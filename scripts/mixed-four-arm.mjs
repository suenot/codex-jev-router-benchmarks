import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suite = join(root, 'benchmarks', 'mixed-2026-09-26');
const routerRoot = resolve(process.env.CODEX_ROUTER_REPO || join(root, '..', 'codex-jev-router'));
const { routeSubagent } = await import(pathToFileURL(join(routerRoot, 'src', 'router.mjs')).href);
const { deciderConfig, evaluateDecision } = await import(pathToFileURL(join(routerRoot, 'src', 'decider.mjs')).href);
const ARMS = ['single_sol_xhigh', 'fixed_sol_high_child', 'jev_routed_child', 'optional_delegation'];
const RATES = {
  'gpt-6-sol': { input: 2, cached: 0.2, cache_write: 2.5, output: 10 },
  'gpt-6-luna': { input: 0.1, cached: 0.01, cache_write: 0.125, output: 0.5 },
};
const JEV_INPUT_RATE = 0.042;

function sha(value) { return createHash('sha256').update(value).digest('hex'); }

async function fixtureDigest() {
  const hash = createHash('sha256');
  async function walk(dir, relative = '') {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await walk(join(dir, entry.name), path);
      else { hash.update(path); hash.update('\0'); hash.update(await readFile(join(dir, entry.name))); hash.update('\0'); }
    }
  }
  await walk(join(suite, 'fixture'));
  return hash.digest('hex');
}

function argsFrom(argv) {
  const args = { repetitions: 3, maxAttempts: 2, tasks: [], policyFile: join(suite, 'optional-policy.md') };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output') args.output = resolve(argv[++i] || '');
    else if (arg === '--task') args.tasks.push(argv[++i]);
    else if (arg === '--repetitions') args.repetitions = Number(argv[++i]);
    else if (arg === '--max-attempts') args.maxAttempts = Number(argv[++i]);
    else if (arg === '--policy-file') args.policyFile = resolve(argv[++i] || '');
    else if (arg === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!args.output || !Number.isInteger(args.repetitions) || args.repetitions < 1 || args.repetitions > 5 ||
      !Number.isInteger(args.maxAttempts) || args.maxAttempts < 1 || args.maxAttempts > 3) {
    throw new Error('Usage: node scripts/mixed-four-arm.mjs --output /path/results.json [--task ID] [--repetitions 3] [--max-attempts 2] [--policy-file PATH] [--dry-run]');
  }
  return args;
}

function execute(command, argv, { cwd, env = process.env, input, timeout = 360_000 } = {}) {
  return new Promise((done, reject) => {
    const started = performance.now();
    const child = spawn(command, argv, { cwd, env, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 15_000_000) child.kill('SIGTERM'); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 2_000_000) child.kill('SIGTERM'); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      done({ code, timed_out: timedOut, stdout, stderr, wall_ms: Math.round(performance.now() - started) });
    });
    if (input != null) child.stdin.end(input);
  });
}

function price(model, usage) {
  const rate = RATES[model];
  if (!rate) return null;
  const { input_tokens: input, cached_input_tokens: cached, output_tokens: output,
    cache_write_input_tokens: write = 0 } = usage;
  if (![input, cached, output, write].every(value => Number.isInteger(value) && value >= 0) || cached > input) return null;
  return ((input - cached) * rate.input + cached * rate.cached + write * rate.cache_write + output * rate.output) / 1_000_000;
}

function jevPrice(decision) {
  if (!decision) return 0;
  if (decision.usage?.input_tokens == null) return null;
  return decision.usage.input_tokens * JEV_INPUT_RATE / 1_000_000;
}

async function sessionsIn(home) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.jsonl')) files.push(path);
    }
  }
  try { await walk(join(home, 'sessions')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const sessions = [];
  for (const path of files) {
    let meta, context, usage;
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.type === 'session_meta') meta = event.payload;
      if (event.type === 'turn_context') context = event.payload;
      if (event.type === 'event_msg' && event.payload?.type === 'token_count') usage = event.payload.info?.total_token_usage ?? usage;
    }
    if (meta?.id && context?.model && usage) sessions.push({ id: meta.id,
      parent_id: meta.source?.subagent?.thread_spawn?.parent_thread_id ?? null,
      model: context.model, reasoning_effort: context.effort, usage });
  }
  return sessions;
}

function parseEvents(raw) {
  const events = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { answer: events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message').at(-1)?.item?.text ?? '',
    root_thread_id: events.find(event => event.type === 'thread.started')?.thread_id ?? null,
    root_usage: events.findLast(event => event.type === 'turn.completed')?.usage ?? null,
    trace: events.map(event => {
      if (event.type === 'thread.started') return { type: event.type, thread_id: event.thread_id };
      if (event.type === 'turn.completed') return { type: event.type, usage: event.usage };
      if (event.type === 'item.completed') return { type: event.type, item_type: event.item?.type,
        ...(event.item?.type === 'agent_message' ? { text: event.item.text } : {}),
        ...(event.item?.type === 'command_execution' ? { exit_code: event.item.exit_code } : {}) };
      return { type: event.type };
    }) };
}

function shuffle(taskId, repetition, seed) {
  let state = (seed ^ repetition) >>> 0;
  for (const char of taskId) state = (Math.imul(state, 33) + char.charCodeAt(0)) >>> 0;
  const result = [...ARMS];
  for (let i = result.length - 1; i > 0; i--) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const j = (state >>> 0) % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function routeShim() {
  const router = pathToFileURL(join(routerRoot, 'src', 'router.mjs')).href;
  const decider = pathToFileURL(join(routerRoot, 'src', 'decider.mjs')).href;
  return `import { appendFile } from 'node:fs/promises';\n` +
    `import { routeSubagent } from ${JSON.stringify(router)};\n` +
    `import { evaluateDecision } from ${JSON.stringify(decider)};\n` +
    `const role = process.argv.find(x => x.startsWith('--role='))?.slice(7) || 'default';\n` +
    `let summary = ''; for await (const chunk of process.stdin) summary += chunk;\n` +
    `let usage = null; const started = performance.now();\n` +
    `const route = await routeSubagent({ agent_type: role, message: summary.trim() }, async input => { const raw = await evaluateDecision(input); usage = raw.usage ?? null; return raw; });\n` +
    `await appendFile(new URL('./decisions.jsonl', import.meta.url), JSON.stringify({ route, usage, wall_ms: Math.round(performance.now() - started) }) + '\\n');\n` +
    `process.stdout.write(JSON.stringify(route) + '\\n');\n`;
}

function promptFor(task, arm, route, policy) {
  const common = `You are in a small public benchmark fixture. Work only here. ${task.prompt}\n` +
    (task.type === 'code_edit' ? 'Edit only the named source file. ' : 'Do not edit the fixture. ') +
    'Do not access the internet or other workspaces. ' +
    (task.type === 'code_edit' ? 'Return only {"done":true}.' :
      'Return only a JSON object with exactly two top-level keys, "answer" and "citations". "answer" is an object with only the requested fields. "citations" is an object with those same field names; each value is an array of repository-relative "path:line" strings supporting that answer field.');
  if (arm === 'single_sol_xhigh') return `${common}\nComplete this yourself. Do not spawn a subagent.`;
  if (arm === 'fixed_sol_high_child' || arm === 'jev_routed_child') return `${common}\nDelegate the complete task to exactly one ${task.role} subagent with model=${route.model} and reasoning_effort=${route.reasoning_effort}. Do not inspect the fixture yourself. Wait for its result. Return its JSON unchanged. Do not spawn another child.`;
  return `${common}\n\nSubagent policy under test:\n${policy}\n\nIf a subagent is warranted, first run node .benchmark/route.mjs --role=${task.role} with a short sanitized task summary on stdin; use exactly the returned model and reasoning_effort for one child. Do not call the route script if you will not delegate. No nested children. The final answer must obey the task contract.`;
}

async function routeTask(task) {
  let usage = null;
  const started = performance.now();
  const route = await routeSubagent({ agent_type: task.role, message: task.summary }, async input => {
    const raw = await evaluateDecision(input);
    usage = raw.usage ?? null;
    return raw;
  });
  return { route, usage, wall_ms: Math.round(performance.now() - started) };
}

async function changedPaths(work) {
  const paths = [];
  async function walk(dir, rel = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.benchmark') continue;
      const next = join(rel, entry.name);
      if (entry.isDirectory()) await walk(join(dir, entry.name), next);
      else paths.push(next);
    }
  }
  await walk(work);
  const fixture = join(suite, 'fixture');
  const originals = [];
  async function originalWalk(dir, rel = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const next = join(rel, entry.name);
      if (entry.isDirectory()) await originalWalk(join(dir, entry.name), next);
      else originals.push(next);
    }
  }
  await originalWalk(fixture);
  return [...new Set([...paths, ...originals])].filter(asyncPath => !paths.includes(asyncPath) || !originals.includes(asyncPath))
    .concat(await Promise.all(paths.filter(path => originals.includes(path)).map(async path =>
      sha(await readFile(join(work, path))) === sha(await readFile(join(fixture, path))) ? null : path)))
    .filter(Boolean).sort();
}

async function grade(task, answer, work, changes) {
  if (task.type !== 'code_edit') {
    const answerFile = join(work, '.benchmark', 'answer.json');
    await writeFile(answerFile, answer);
    const checked = await execute('python3', [join(suite, 'grade.py'), '--task', task.id, '--answer-file', answerFile], { cwd: work, timeout: 20_000 });
    return { correct: checked.code === 0 && changes.length === 0,
      detail: changes.length ? `unexpected file changes: ${changes.join(', ')}` : (checked.stdout + checked.stderr).trim().slice(0, 500) };
  }
  if (answer.trim() !== '{"done":true}' && (() => { try { return JSON.stringify(JSON.parse(answer)) !== '{"done":true}'; } catch { return true; } })()) {
    return { correct: false, detail: 'edit completion JSON mismatch' };
  }
  if (changes.join(',') !== task.allowed_changed_paths.join(',')) return { correct: false, detail: `changed paths: ${changes.join(', ')}` };
  const result = await execute('node', [join(suite, 'check-receipt.mjs'), work], { cwd: work, timeout: 20_000 });
  return { correct: result.code === 0, detail: result.code === 0 ? 'hidden behavior checks passed' : result.stderr.slice(-500) };
}

async function saveEditPatch(work, tracePath) {
  const source = join('src', 'receipts.mjs');
  const diff = await execute('diff', ['-u', '--label', `a/${source}`, '--label', `b/${source}`,
    join(suite, 'fixture', source), join(work, source)], { cwd: work, timeout: 20_000 });
  if (diff.code !== 0 && diff.code !== 1) throw new Error(`diff failed: ${diff.stderr}`);
  const path = tracePath.replace(/\.jsonl$/, '.patch');
  await writeFile(path, diff.stdout);
  return { path: `${dirname(tracePath).split('/').at(-1)}/${path.split('/').at(-1)}`,
    sha256: sha(diff.stdout), bytes: Buffer.byteLength(diff.stdout) };
}

async function oneAttempt({ task, arm, route, policy, tracePath }) {
  const temp = await mkdtemp(join(tmpdir(), 'codex-mixed-four-arm-'));
  const work = join(temp, 'fixture');
  const home = join(temp, 'codex-home');
  try {
    await cp(join(suite, 'fixture'), work, { recursive: true });
    await mkdir(join(work, '.benchmark'));
    await writeFile(join(work, '.benchmark', 'route.mjs'), routeShim());
    await writeFile(join(work, '.benchmark', 'package.json'), '{"type":"module"}\n');
    await mkdir(home);
    const auth = join(resolve(process.env.CODEX_HOME || join(homedir(), '.codex')), 'auth.json');
    await access(auth);
    await symlink(auth, join(home, 'auth.json'));
    const args = ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
      '-s', 'workspace-write', '-C', work, '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort=xhigh',
      '-c', 'approval_policy=never', '-c', `agents.enabled=${arm === 'single_sol_xhigh' ? 'false' : 'true'}`,
      promptFor(task, arm, route?.route, policy)];
    const run = await execute('codex', args, { cwd: work, env: { ...process.env, CODEX_HOME: home, CODEX_ROUTER_LOG: '0' } });
    let parsed = { answer: '', root_thread_id: null, root_usage: null, trace: [] };
    try { parsed = parseEvents(run.stdout); } catch (error) { parsed.parse_error = String(error); }
    await writeFile(tracePath, parsed.trace.map(event => JSON.stringify(event)).join('\n') + '\n');
    const sessions = await sessionsIn(home);
    const roots = sessions.filter(session => session.id === parsed.root_thread_id &&
      session.model === 'gpt-6-sol' && session.reasoning_effort === 'xhigh' &&
      session.usage.input_tokens === parsed.root_usage?.input_tokens &&
      session.usage.output_tokens === parsed.root_usage?.output_tokens);
    const rootSession = roots.length === 1 ? roots[0] : null;
    const children = sessions.filter(session => session !== rootSession);
    let decisions = [];
    try { decisions = (await readFile(join(work, '.benchmark', 'decisions.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const expectedRoute = arm === 'optional_delegation' ? decisions[0]?.route : route?.route;
    const childExpected = arm === 'single_sol_xhigh' ? 0 : arm === 'optional_delegation' ? decisions.length : 1;
    const usageComplete = Boolean(rootSession && sessions.length === 1 + childExpected && sessions.every(session => price(session.model, session.usage) != null));
    const protocolOk = usageComplete && decisions.length <= 1 && children.length === childExpected &&
      (arm !== 'optional_delegation' || decisions.length === children.length) &&
      children.every(child => child.model === expectedRoute?.model && child.reasoning_effort === expectedRoute?.reasoning_effort &&
        (!child.parent_id || child.parent_id === parsed.root_thread_id));
    const changes = await changedPaths(work);
    const verdict = await grade(task, parsed.answer, work, changes);
    const patch = task.type === 'code_edit' ? await saveEditPatch(work, tracePath) : null;
    const codexCost = usageComplete ? sessions.reduce((sum, session) => sum + price(session.model, session.usage), 0) : null;
    const allDecisions = arm === 'jev_routed_child' ? [route] : arm === 'optional_delegation' ? decisions : [];
    const decisionCosts = allDecisions.map(jevPrice);
    const jevCost = decisionCosts.some(value => value == null) ? null : decisionCosts.reduce((sum, value) => sum + value, 0);
    return { exit_code: run.code, timed_out: run.timed_out, wall_ms: run.wall_ms,
      end_to_end_ms: run.wall_ms + (arm === 'jev_routed_child' ? route.wall_ms : 0),
      answer: parsed.answer, grade: verdict, protocol_ok: protocolOk, root_thread_id: parsed.root_thread_id,
      root_usage: parsed.root_usage, sessions, decisions: allDecisions, changed_paths: changes,
      ...(patch ? { patch } : {}),
      estimated_codex_api_usd: codexCost, estimated_jev_api_usd: jevCost,
      estimated_total_api_usd: codexCost == null || jevCost == null ? null : codexCost + jevCost,
      ...(parsed.parse_error ? { parse_error: parsed.parse_error } : {}),
      ...(run.code ? { stderr_tail: run.stderr.slice(-1000) } : {}) };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function main() {
  const args = argsFrom(process.argv.slice(2));
  const manifestText = await readFile(join(suite, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const policy = await readFile(args.policyFile, 'utf8');
  const fixtureCheck = await execute('python3', [join(suite, 'grade.py'), '--verify-fixture']);
  if (fixtureCheck.code) throw new Error(`Fixture check failed: ${fixtureCheck.stdout}${fixtureCheck.stderr}`);
  const tasks = args.tasks.length ? manifest.tasks.filter(task => args.tasks.includes(task.id)) : manifest.tasks;
  if (!tasks.length || args.tasks.some(id => !tasks.some(task => task.id === id))) throw new Error('Unknown task selection');
  const schedule = Array.from({ length: args.repetitions }, (_, index) => tasks.map(task => ({
    task: task.id, repetition: index + 1, order: shuffle(task.id, index + 1, manifest.seed) }))).flat();
  const identity = { manifest_sha256: sha(manifestText), fixture_sha256: await fixtureDigest(),
    grader_sha256: sha(await readFile(join(suite, 'grade.py'))) + ':' + sha(await readFile(join(suite, 'check-receipt.mjs'))),
    runner_sha256: sha(await readFile(fileURLToPath(import.meta.url))),
    router_sha256: sha(await readFile(join(routerRoot, 'src', 'router.mjs'))),
    decider_sha256: sha(await readFile(join(routerRoot, 'src', 'decider.mjs'))),
    policy_sha256: sha(policy), repetitions: args.repetitions,
    max_attempts: args.maxAttempts, selected_tasks: tasks.map(task => task.id), seed: manifest.seed };
  if (args.dryRun) { process.stdout.write(JSON.stringify({ identity, schedule }, null, 2) + '\n'); return; }
  if (deciderConfig().kind !== 'jev' || !deciderConfig().configured) throw new Error('A configured Jev backend is required for the four-arm run');
  const traceDir = args.output.replace(/\.json$/, '') + '-traces';
  await mkdir(dirname(args.output), { recursive: true });
  await mkdir(traceDir, { recursive: true });
  let results;
  try { results = JSON.parse(await readFile(args.output, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (results && JSON.stringify(results.identity) !== JSON.stringify(identity)) throw new Error('Existing result identity differs; choose another output path');
  results ??= { benchmark: 'four-arm mixed full-workflow comparison', generated_at: new Date().toISOString(),
    identity, codex_version: (await execute('codex', ['--version'])).stdout.trim(),
    pricing: { units: 'USD per million tokens', codex: RATES, jev_input: JEV_INPUT_RATE,
      codex_source: 'https://developers.openai.com/api/docs/models/gpt-6-sol',
      jev_source: 'https://typesafe.ai/blog/introducing-system-one-models-and-jev',
      assumption: 'Standard short-context Codex API rates; TypeSafe lists Jev output tokens free; tool fees, other charges, and subscription billing are not measured' },
    isolation: 'fresh CODEX_HOME with auth symlink; --ignore-user-config; --ignore-rules; synthetic fixture copied per attempt',
    schedule, runs: [] };
  for (const block of schedule) {
    const task = tasks.find(item => item.id === block.task);
    for (const arm of block.order) {
      if (results.runs.some(run => run.task === task.id && run.repetition === block.repetition && run.arm === arm)) continue;
      const attempts = [];
      for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
        const route = arm === 'jev_routed_child' ? await routeTask(task) :
          arm === 'fixed_sol_high_child' ? { route: { model: 'gpt-6-sol', reasoning_effort: 'high', reason: 'fixed' } } : null;
        const traceRelative = `${task.id}.rep${block.repetition}.${arm}.attempt${attempt}.jsonl`;
        const trial = await oneAttempt({ task, arm, route, policy, tracePath: join(traceDir, traceRelative) });
        attempts.push({ ...trial, trace: `${traceDir.split('/').at(-1)}/${traceRelative}` });
        if (trial.exit_code === 0 && trial.protocol_ok && trial.grade.correct && trial.estimated_total_api_usd != null) break;
      }
      const totalCost = attempts.every(attempt => attempt.estimated_total_api_usd != null)
        ? attempts.reduce((sum, attempt) => sum + attempt.estimated_total_api_usd, 0) : null;
      const last = attempts.at(-1);
      results.runs.push({ task: task.id, type: task.type, repetition: block.repetition, arm, attempts,
        grade: last.grade, protocol_ok: last.protocol_ok, passed: last.exit_code === 0 && last.protocol_ok && last.grade.correct,
        estimated_total_api_usd: totalCost,
        end_to_end_ms: attempts.reduce((sum, attempt) => sum + attempt.end_to_end_ms, 0) });
      await writeFile(args.output, JSON.stringify(results, null, 2) + '\n');
      process.stderr.write(`${task.id} rep${block.repetition} ${arm}: pass=${results.runs.at(-1).passed} attempts=${attempts.length} cost=${totalCost}\n`);
    }
  }
}

await main();
