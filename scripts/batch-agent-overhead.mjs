import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suite = join(root, 'benchmarks', 'django-task-suite-2026-09-26');
const routerRoot = resolve(process.env.CODEX_ROUTER_REPO || join(root, '..', 'codex-jev-router'));
const { routeSubagent } = await import(pathToFileURL(join(routerRoot, 'src', 'router.mjs')).href);
const { deciderConfig, evaluateDecision } = await import(pathToFileURL(join(routerRoot, 'src', 'decider.mjs')).href);

// Fixed before any runs. Each group contains four unrelated tasks from the manifest.
const GROUPS = [
  ['paginator-elided-symbol', 'url-namespace-symbol', 'forms-normalization', 'filefield-form-data-claim'],
  ['signal-robust-symbol', 'slash-redirect-default', 'orm-chunk-sizes', 'extension-case-claim'],
  ['static-location-symbol', 'template-truncation', 'paginator-float-claim', 'json-response-list-claim'],
];
const RATES = {
  'gpt-6-sol': { input: 2, cached: 0.2, cache_write: 2.5, output: 10 },
  'gpt-6-luna': { input: 0.1, cached: 0.01, cache_write: 0.125, output: 0.5 },
};

function argumentsFrom(argv) {
  const args = { repetitions: 2 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') args.repo = resolve(argv[++i] || '');
    else if (argv[i] === '--output') args.output = resolve(argv[++i] || '');
    else if (argv[i] === '--repetitions') args.repetitions = Number(argv[++i]);
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  if (!args.repo || !args.output || !Number.isInteger(args.repetitions) || args.repetitions < 1 || args.repetitions > 10) {
    throw new Error('Usage: node scripts/batch-agent-overhead.mjs --repo /pinned/django --output /path/results.json [--repetitions 1..10]');
  }
  return args;
}

function execute(command, args, { cwd, env = process.env, timeout = 1_200_000 } = {}) {
  return new Promise((resolveRun, reject) => {
    const started = performance.now();
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 24_000_000) child.kill('SIGTERM');
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

async function rollouts(home, traceDir, prefix) {
  const files = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.name.endsWith('.jsonl')) files.push(target);
    }
  }
  try { await walk(join(home, 'sessions')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  files.sort();
  const sessions = [];
  for (const [index, path] of files.entries()) {
    const raw = await readFile(path, 'utf8');
    const trace = `${prefix}-rollout-${index + 1}.jsonl`;
    await writeFile(join(traceDir, trace), raw);
    let meta;
    let context;
    let usage;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.type === 'session_meta') meta = event.payload;
      if (event.type === 'turn_context') context = event.payload;
      if (event.type === 'event_msg' && event.payload?.type === 'token_count') {
        usage = event.payload.info?.total_token_usage ?? usage;
      }
    }
    if (!meta?.id || !context?.model || !usage ||
      !Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) {
      throw new Error(`Incomplete Codex rollout: ${path}`);
    }
    sessions.push({
      id: meta.id, parent_id: meta.source?.subagent?.thread_spawn?.parent_thread_id ?? null,
      model: context.model, reasoning_effort: context.effort, usage, trace,
    });
  }
  return sessions.sort((a, b) => a.id.localeCompare(b.id));
}

function apiCost(session) {
  const rates = RATES[session.model];
  if (!rates) throw new Error(`No API price for observed model ${session.model}`);
  const { input_tokens = 0, cached_input_tokens = 0, cache_write_input_tokens = 0, output_tokens = 0 } = session.usage;
  if (cached_input_tokens > input_tokens) throw new Error('Cached input exceeds input tokens');
  return ((input_tokens - cached_input_tokens) * rates.input + cached_input_tokens * rates.cached +
    cache_write_input_tokens * rates.cache_write + output_tokens * rates.output) / 1_000_000;
}

function sumUsage(sessions) {
  return sessions.reduce((total, session) => {
    for (const key of ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens']) {
      total[key] += session.usage[key] || 0;
    }
    return total;
  }, { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 });
}

function multiset(items) {
  return items.map(item => `${item.model}/${item.reasoning_effort}`).sort().join('|');
}

function rootSessionFor(parsed, sessions) {
  const candidates = sessions.filter(session => session.id === parsed.root_thread_id &&
    session.model === 'gpt-6-sol' && session.reasoning_effort === 'high' &&
    session.usage.input_tokens === parsed.root_usage?.input_tokens &&
    session.usage.output_tokens === parsed.root_usage?.output_tokens);
  return candidates.length === 1 ? candidates[0] : null;
}

function protocolOk(arm, parsed, sessions, decisions) {
  const rootSession = rootSessionFor(parsed, sessions);
  if (!rootSession || rootSession.model !== 'gpt-6-sol' || rootSession.reasoning_effort !== 'high') return false;
  const children = sessions.filter(session => session !== rootSession);
  if (arm === 'single_sol_high') return children.length === 0;
  return children.length === 4 &&
    children.every(child => !child.parent_id || child.parent_id === parsed.root_thread_id) &&
    multiset(children) === multiset(decisions);
}

function promptFor(tasks, arm, decisions) {
  const list = tasks.map((task, index) => `${index + 1}. TASK ID: ${task.id}\n${task.prompt}`).join('\n\n');
  const common = `Solve these four independent read-only tasks in the pinned Django checkout. Use local shell tools, do not access the internet or another workspace, and do not edit files.\n\n${list}\n\nReturn only JSON of the form {"answers":{"TASK_ID":{"answer":{...},"citations":{...}},...}}. Include all four exact task IDs. Each value must satisfy that task's JSON contract.`;
  if (arm === 'single_sol_high') return `${common}\n\nComplete all four tasks yourself in this session. Do not spawn or delegate to subagents.`;
  const instructions = tasks.map((task, index) =>
    `${index + 1}. Spawn one ${task.role} subagent for ${task.id} with model=${decisions[index].model} and reasoning_effort=${decisions[index].reasoning_effort}. Give it only that task's prompt and ask for its JSON answer.`
  ).join('\n');
  return `${common}\n\nSpawn exactly four distinct subagents, one for each task, using these separately determined routes:\n${instructions}\nWait for all four. Do not inspect Django source yourself. Combine their returned JSON answers under the four task IDs without changing their content. Do not spawn extra agents.`;
}

async function gradeAnswers(tasks, raw, home) {
  let answers;
  try {
    const parsed = JSON.parse(raw.trim());
    answers = parsed.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('answers must be an object');
  } catch (error) {
    return { results: tasks.map(task => ({ task: task.id, correct: false, detail: `Invalid combined JSON: ${error}` })), parse_error: String(error) };
  }
  const results = [];
  for (const task of tasks) {
    if (!Object.hasOwn(answers, task.id)) {
      results.push({ task: task.id, correct: false, detail: 'Missing task answer' });
      continue;
    }
    const answerPath = join(home, `${task.id}-answer.json`);
    await writeFile(answerPath, JSON.stringify(answers[task.id]));
    const graded = await execute('python3', [join(suite, 'grade.py'), '--task', task.id, '--answer-file', answerPath], { timeout: 20_000 });
    results.push({ task: task.id, correct: graded.code === 0, detail: (graded.stdout + graded.stderr).trim().slice(0, 500) });
  }
  return { results, extra_ids: Object.keys(answers).filter(id => !tasks.some(task => task.id === id)) };
}

async function codexRun({ tasks, arm, decisions, repo, traceDir, prefix }) {
  const home = await mkdtemp(join(tmpdir(), 'codex-batch-agent-home-'));
  try {
    const auth = join(resolve(process.env.CODEX_HOME || join(homedir(), '.codex')), 'auth.json');
    await access(auth);
    await symlink(auth, join(home, 'auth.json'));
    const args = [
      'exec', '--json', '--ignore-user-config', '--ignore-rules', '-s', 'read-only', '-C', repo,
      '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort=high', '-c', 'approval_policy=never',
      '-c', `agents.enabled=${arm === 'single_sol_high' ? 'false' : 'true'}`,
      promptFor(tasks, arm, decisions),
    ];
    const run = await execute('codex', args, { cwd: repo, env: { ...process.env, CODEX_HOME: home } });
    const eventTrace = `${prefix}.events.jsonl`;
    await writeFile(join(traceDir, eventTrace), run.stdout);
    const stderrTrace = `${prefix}.stderr.txt`;
    await writeFile(join(traceDir, stderrTrace), run.stderr);
    let parsed = { answer: '', root_thread_id: null, root_usage: null, command_calls: 0 };
    let parseError = null;
    try { parsed = parseEvents(run.stdout); }
    catch (error) { parseError = String(error); }
    let sessions = [];
    let usageError = null;
    try { sessions = await rollouts(home, traceDir, prefix); }
    catch (error) { usageError = String(error); }
    const graded = await gradeAnswers(tasks, parsed.answer, home);
    const rootSession = rootSessionFor(parsed, sessions);
    const usageComplete = !usageError && Boolean(rootSession) && sessions.length === (arm === 'single_sol_high' ? 1 : 5);
    const codexUsage = usageComplete ? sumUsage(sessions) : null;
    return {
      exit_code: run.code, timed_out: run.timed_out, wall_ms: run.elapsed_ms,
      answer: parsed.answer, grades: graded.results, correct_count: graded.results.filter(item => item.correct).length,
      all_correct: graded.results.every(item => item.correct) && !graded.extra_ids?.length,
      extra_answer_ids: graded.extra_ids ?? [], protocol_ok: protocolOk(arm, parsed, sessions, decisions),
      root_thread_id: parsed.root_thread_id, root_usage: parsed.root_usage,
      root_usage_matches_rollout: Boolean(rootSession && parsed.root_usage &&
        rootSession.usage.input_tokens === parsed.root_usage.input_tokens &&
        rootSession.usage.output_tokens === parsed.root_usage.output_tokens),
      command_calls: parsed.command_calls, sessions, usage_complete: usageComplete, codex_usage: codexUsage,
      codex_tokens: codexUsage ? codexUsage.input_tokens + codexUsage.output_tokens : null,
      estimated_codex_api_usd: usageComplete ? sessions.reduce((sum, item) => sum + apiCost(item), 0) : null,
      traces: { events: eventTrace, stderr: stderrTrace, rollouts: sessions.map(session => session.trace) },
      ...(parseError ? { parse_error: parseError } : {}),
      ...(graded.parse_error ? { answer_parse_error: graded.parse_error } : {}),
      ...(usageError ? { usage_error: usageError } : {}),
    };
  } finally {
    await rm(home, { recursive: true, force: true });
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

async function main() {
  const args = argumentsFrom(process.argv.slice(2));
  const manifestText = await readFile(join(suite, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const manifestSha = createHash('sha256').update(manifestText).digest('hex');
  const taskMap = new Map(manifest.tasks.map(task => [task.id, task]));
  const ids = GROUPS.flat();
  if (ids.length !== 12 || new Set(ids).size !== 12 || manifest.tasks.length !== 12 || ids.some(id => !taskMap.has(id))) {
    throw new Error('Fixed groups do not exactly cover the 12-task manifest');
  }
  const head = (await execute('git', ['rev-parse', 'HEAD'], { cwd: args.repo, timeout: 20_000 })).stdout.trim();
  if (head !== manifest.base_commit) throw new Error(`Fixture HEAD ${head} differs from pinned ${manifest.base_commit}`);
  const dirty = (await execute('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: args.repo, timeout: 20_000 })).stdout.trim();
  if (dirty) throw new Error('Django fixture has uncommitted or untracked changes');
  for (const path of [args.repo, dirname(args.repo)]) {
    try { await access(join(path, 'AGENTS.md')); throw new Error(`Unexpected AGENTS.md in ${path}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try { await access(join(args.repo, '.codex', 'config.toml')); throw new Error('Unexpected project .codex/config.toml'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const sourceCheck = await execute('python3', [join(suite, 'grade.py'), '--source', args.repo], { timeout: 30_000 });
  if (sourceCheck.code !== 0) throw new Error(`Fixture source check failed: ${sourceCheck.stdout}${sourceCheck.stderr}`);
  const traceDir = args.output.replace(/\.json$/, '') + '-traces';
  await mkdir(dirname(args.output), { recursive: true });
  await mkdir(traceDir, { recursive: true });
  const backend = deciderConfig().kind;
  const results = {
    benchmark: 'Four-task Sol-high batch versus Sol-high parent with four routed subagents',
    generated_at: new Date().toISOString(), codex_version: (await execute('codex', ['--version'], { timeout: 20_000 })).stdout.trim(),
    fixture_repo: manifest.fixture_repo, base_commit: manifest.base_commit, manifest_sha256: manifestSha,
    repetitions: args.repetitions, groups: GROUPS.map((taskIds, index) => ({ id: `group-${index + 1}`, task_ids: taskIds })),
    baseline: { model: 'gpt-6-sol', reasoning_effort: 'high', subagents_enabled: false },
    routed_parent: { model: 'gpt-6-sol', reasoning_effort: 'high', subagents_enabled: true, children: 4 },
    codex_isolation: 'Fresh CODEX_HOME per arm with auth symlink only; --ignore-user-config; --ignore-rules; no project AGENTS.md',
    sandbox: 'read-only', pricing: { units: 'USD per million tokens', rates: RATES, jev_input: 0.042,
      assumption: 'Standard, short-context, no regional premium' },
    decider_backend: backend, trace_directory: basename(traceDir), runs: [],
  };
  let pair = 0;
  for (let repetition = 1; repetition <= args.repetitions; repetition++) {
    for (const [groupIndex, idsForGroup] of GROUPS.entries()) {
      const tasks = idsForGroup.map(id => taskMap.get(id));
      const arms = pair++ % 2 ? ['routed_parent', 'single_sol_high'] : ['single_sol_high', 'routed_parent'];
      for (const arm of arms) {
        const decisions = [];
        if (arm === 'routed_parent') {
          for (const task of tasks) decisions.push(await routeTask(task));
        }
        const routeWallMs = decisions.reduce((sum, decision) => sum + decision.wall_ms, 0);
        const jevUsage = decisions.map((decision, index) => ({ task: tasks[index].id, ...decision }));
        const jevCost = backend === 'jev' && decisions.every(decision => decision.usage?.input_tokens != null)
          ? decisions.reduce((sum, decision) => sum + decision.usage.input_tokens * 0.042 / 1_000_000, 0)
          : null;
        const prefix = `group-${groupIndex + 1}-rep-${repetition}-${arm}`;
        const run = await codexRun({ tasks, arm, decisions, repo: args.repo, traceDir, prefix });
        const result = {
          group: `group-${groupIndex + 1}`, repetition, arm, task_ids: idsForGroup,
          ...(arm === 'routed_parent' ? { routes: jevUsage, jev_wall_ms: routeWallMs, estimated_jev_api_usd: jevCost } : {}),
          ...run, end_to_end_ms: routeWallMs + run.wall_ms,
          estimated_total_api_usd: run.estimated_codex_api_usd == null || (arm === 'routed_parent' && jevCost == null)
            ? null : run.estimated_codex_api_usd + (jevCost ?? 0),
        };
        results.runs.push(result);
        await writeFile(args.output, JSON.stringify(results, null, 2) + '\n');
        process.stderr.write(`${prefix}: ${run.correct_count}/4 correct, protocol=${run.protocol_ok}, sessions=${run.sessions.length}, tokens=${run.codex_tokens ?? 'unknown'}, ${run.wall_ms}ms\n`);
      }
    }
  }
}

await main();
