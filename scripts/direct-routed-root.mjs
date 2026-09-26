import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suite = join(root, 'benchmarks', 'django-task-suite-2026-09-26');
const routerRoot = resolve(process.env.CODEX_ROUTER_REPO || join(root, '..', 'codex-jev-router'));
const { routeSubagent } = await import(pathToFileURL(join(routerRoot, 'src', 'router.mjs')).href);
const { deciderConfig, evaluateDecision } = await import(pathToFileURL(join(routerRoot, 'src', 'decider.mjs')).href);

const RATES = {
  'gpt-6-sol': { input: 2, cached: 0.2, cache_write: 2.5, output: 10 },
  'gpt-6-luna': { input: 0.1, cached: 0.01, cache_write: 0.125, output: 0.5 },
};

function argumentsFrom(argv) {
  const args = { repetitions: 2, tasks: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') args.repo = resolve(argv[++i] || '');
    else if (argv[i] === '--output') args.output = resolve(argv[++i] || '');
    else if (argv[i] === '--repetitions') args.repetitions = Number(argv[++i]);
    else if (argv[i] === '--task') args.tasks.push(argv[++i]);
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  if (!args.repo || !args.output || !Number.isInteger(args.repetitions) || args.repetitions < 1 || args.repetitions > 5) {
    throw new Error('Usage: node scripts/direct-routed-root.mjs --repo /pinned/django --output /path/results.json [--repetitions 1..5] [--task ID]');
  }
  return args;
}

function execute(command, args, { cwd, env = process.env, timeout = 300_000 } = {}) {
  return new Promise((resolveRun, reject) => {
    const started = performance.now();
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 12_000_000) child.kill('SIGTERM');
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length > 2_000_000) child.kill('SIGTERM');
    });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      resolveRun({ code, timed_out: timedOut, stdout, stderr, elapsed_ms: Math.round(performance.now() - started) });
    });
  });
}

function sanitize(raw, repo, home) {
  return raw.replaceAll(home, '<CODEX_HOME>').replaceAll(repo, '<DJANGO_FIXTURE>')
    .replaceAll(homedir(), '<USER_HOME>')
    .replace(/(?:sk|sess|key)-[A-Za-z0-9_-]{16,}/g, '<REDACTED_TOKEN>');
}

async function sessionRollout(home) {
  const directory = join(home, 'sessions');
  const files = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.name.endsWith('.jsonl')) files.push(target);
    }
  }
  try { await walk(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const sessions = [];
  for (const path of files) {
    let meta;
    let context;
    let usage;
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.type === 'session_meta') meta = event.payload;
      if (event.type === 'turn_context') context = event.payload;
      if (event.type === 'event_msg' && event.payload?.type === 'token_count') {
        usage = event.payload.info?.total_token_usage ?? usage;
      }
    }
    if (!meta?.id || !context?.model || !usage || !Number.isFinite(usage.input_tokens) ||
      !Number.isFinite(usage.output_tokens) || !Number.isFinite(usage.cached_input_tokens)) {
      throw new Error(`Incomplete Codex session rollout: ${path}`);
    }
    sessions.push({ id: meta.id, parent_id: meta.source?.subagent?.thread_spawn?.parent_thread_id ?? null,
      model: context.model, reasoning_effort: context.effort, usage });
  }
  return sessions;
}

function apiCost(session) {
  const rates = RATES[session.model];
  if (!rates) throw new Error(`No API price for observed model ${session.model}`);
  const { input_tokens = 0, cached_input_tokens = 0, cache_write_input_tokens = 0, output_tokens = 0 } = session.usage;
  if (cached_input_tokens > input_tokens) throw new Error('Cached input exceeds input tokens');
  return ((input_tokens - cached_input_tokens) * rates.input + cached_input_tokens * rates.cached +
    cache_write_input_tokens * rates.cache_write + output_tokens * rates.output) / 1_000_000;
}

function parseEvents(raw) {
  const events = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const messages = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message');
  return {
    answer: messages.at(-1)?.item?.text ?? '',
    root_thread_id: events.find(event => event.type === 'thread.started')?.thread_id ?? null,
    root_usage: events.findLast(event => event.type === 'turn.completed')?.usage ?? null,
    command_calls: events.filter(event => event.type === 'item.completed' && event.item?.type === 'command_execution').length,
  };
}

async function grade(taskId, answer) {
  const answerPath = join(tmpdir(), `codex-direct-answer-${process.pid}-${Date.now()}.txt`);
  try {
    await writeFile(answerPath, answer);
    const result = await execute('python3', [join(suite, 'grade.py'), '--task', taskId, '--answer-file', answerPath], { timeout: 20_000 });
    return { correct: result.code === 0, detail: (result.stdout + result.stderr).trim().slice(0, 500) };
  } finally {
    await rm(answerPath, { force: true });
  }
}

async function routeTask(task) {
  let usage = null;
  const started = performance.now();
  const route = await routeSubagent({ agent_type: task.role, message: task.summary }, async input => {
    const raw = await evaluateDecision(input);
    usage = raw.usage ?? null;
    return raw;
  });
  return { ...route, usage, wall_ms: Math.round(performance.now() - started) };
}

async function codexRun({ task, route, repo, tracePath }) {
  const home = await mkdtemp(join(tmpdir(), 'codex-direct-root-home-'));
  try {
    const auth = join(resolve(process.env.CODEX_HOME || join(homedir(), '.codex')), 'auth.json');
    await access(auth);
    await symlink(auth, join(home, 'auth.json'));
    const prompt = `Task in the checked-out Django repository:\n${task.prompt}\n\nUse local shell tools to inspect source. Do not read other workspaces. Do not edit files. Do not access the internet. Final answer must be only the requested JSON object.\n\nComplete the task yourself. Do not spawn or delegate to subagents.`;
    const args = [
      'exec', '--json', '--ignore-user-config', '--ignore-rules', '-s', 'read-only', '-C', repo,
      '-m', route.model, '-c', `model_reasoning_effort=${route.reasoning_effort}`,
      '-c', 'approval_policy=never', '-c', 'agents.enabled=false', prompt,
    ];
    const result = await execute('codex', args, { cwd: repo, env: { ...process.env, CODEX_HOME: home } });
    await writeFile(tracePath, sanitize(result.stdout, repo, home));
    let parsed = { answer: '', root_thread_id: null, root_usage: null, command_calls: 0 };
    try { parsed = parseEvents(result.stdout); }
    catch (error) { parsed.parse_error = String(error); }
    const sessions = await sessionRollout(home);
    const session = sessions.length === 1 ? sessions[0] : null;
    const usageMatches = Boolean(session && parsed.root_usage &&
      session.usage.input_tokens === parsed.root_usage.input_tokens &&
      session.usage.output_tokens === parsed.root_usage.output_tokens);
    const protocolOk = Boolean(result.code === 0 && !result.timed_out && session &&
      session.id === parsed.root_thread_id && !session.parent_id && usageMatches &&
      session.model === route.model && session.reasoning_effort === route.reasoning_effort);
    const verdict = await grade(task.id, parsed.answer);
    return {
      exit_code: result.code, timed_out: result.timed_out, wall_ms: result.elapsed_ms,
      answer: parsed.answer, grade: verdict, protocol_ok: protocolOk,
      root_thread_id: parsed.root_thread_id, root_usage: parsed.root_usage,
      root_usage_matches_rollout: usageMatches, command_calls: parsed.command_calls,
      sessions, usage_complete: usageMatches,
      codex_tokens: usageMatches ? session.usage.input_tokens + session.usage.output_tokens : null,
      estimated_codex_api_usd: usageMatches ? apiCost(session) : null,
      stderr_tail: result.code === 0 ? '' : sanitize(result.stderr.slice(-1500), repo, home),
      ...(parsed.parse_error ? { parse_error: parsed.parse_error } : {}),
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2));
  const manifestText = await readFile(join(suite, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const manifestSha = createHash('sha256').update(manifestText).digest('hex');
  const baseline = JSON.parse(await readFile(join(suite, 'results.json'), 'utf8'));
  if (baseline.manifest_sha256 !== manifestSha || baseline.base_commit !== manifest.base_commit) {
    throw new Error('Saved baseline does not match preregistered manifest');
  }
  const head = (await execute('git', ['rev-parse', 'HEAD'], { cwd: args.repo })).stdout.trim();
  if (head !== manifest.base_commit) throw new Error(`Fixture HEAD ${head} differs from pinned ${manifest.base_commit}`);
  const dirty = (await execute('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: args.repo })).stdout.trim();
  if (dirty) throw new Error('Django fixture has uncommitted or untracked changes');
  for (const path of [args.repo, dirname(args.repo)]) {
    try { await access(join(path, 'AGENTS.md')); throw new Error(`Unexpected AGENTS.md in ${path}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try { await access(join(args.repo, '.codex', 'config.toml')); throw new Error('Unexpected project .codex/config.toml'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const sourceCheck = await execute('python3', [join(suite, 'grade.py'), '--source', args.repo], { timeout: 30_000 });
  if (sourceCheck.code !== 0) throw new Error(`Fixture source check failed: ${sourceCheck.stdout}${sourceCheck.stderr}`);
  const tasks = args.tasks.length ? manifest.tasks.filter(task => args.tasks.includes(task.id)) : manifest.tasks;
  if (!tasks.length || args.tasks.some(id => !tasks.some(task => task.id === id))) throw new Error('Unknown task selection');
  const traceDir = args.output.replace(/\.json$/, '') + '-traces';
  await mkdir(traceDir, { recursive: true });
  const results = {
    benchmark: 'Jev-routed direct root versus previously measured direct Sol high',
    generated_at: new Date().toISOString(), codex_version: (await execute('codex', ['--version'])).stdout.trim(),
    fixture_repo: manifest.fixture_repo, base_commit: manifest.base_commit, manifest_sha256: manifestSha,
    repetitions: args.repetitions, tasks: tasks.map(task => ({ id: task.id, type: task.type, role: task.role, summary: task.summary })),
    baseline_source: 'results.json', baseline_arm: 'single_sol_high',
    comparison_design: 'Historical baseline; direct-root runs are new and were not paired or order randomized with baseline',
    direct_root: { subagents_enabled: false, model_and_effort: 'selected by Jev before each run' },
    codex_isolation: 'New CODEX_HOME with auth symlink only; --ignore-user-config; --ignore-rules; no project AGENTS.md',
    sandbox: 'read-only', pricing: { units: 'USD per million tokens', rates: RATES, assumption: 'Standard, short-context, no regional premium' },
    decider_backend: deciderConfig().kind, runs: [],
  };
  for (let repetition = 1; repetition <= args.repetitions; repetition++) {
    for (const task of tasks) {
      const decision = await routeTask(task);
      const priorRoute = baseline.runs.find(run => run.task === task.id && run.repetition === repetition && run.arm === 'routed_parent')?.route;
      if (!priorRoute || decision.model !== priorRoute.model || decision.reasoning_effort !== priorRoute.reasoning_effort) {
        throw new Error(`Live Jev route changed for ${task.id} repetition ${repetition}; saved baseline comparison would be invalid`);
      }
      const traceRelative = `${task.id}-${repetition}-direct_routed_root.jsonl`;
      const run = await codexRun({ task, route: decision, repo: args.repo, tracePath: join(traceDir, traceRelative) });
      const jevCost = results.decider_backend === 'jev' && decision.usage?.input_tokens != null
        ? decision.usage.input_tokens * 0.042 / 1_000_000 : null;
      results.runs.push({ task: task.id, type: task.type, repetition, arm: 'direct_routed_root',
        route: decision, estimated_jev_api_usd: jevCost, ...run,
        trace: `${traceDir.split('/').at(-1)}/${traceRelative}`,
        estimated_total_api_usd: run.estimated_codex_api_usd == null || jevCost == null
          ? null : run.estimated_codex_api_usd + jevCost,
        end_to_end_ms: run.wall_ms + decision.wall_ms,
      });
      await writeFile(args.output, JSON.stringify(results, null, 2) + '\n');
      process.stderr.write(`${task.id} ${repetition}: correct=${run.grade.correct} protocol=${run.protocol_ok} sessions=${run.sessions.length} cost=$${run.estimated_codex_api_usd?.toFixed(6) ?? 'NA'} time=${run.wall_ms}ms\n`);
      if (!run.protocol_ok) throw new Error(`Direct root protocol failed for ${task.id} repetition ${repetition}: ${run.stderr_tail}`);
    }
  }
}

await main();
