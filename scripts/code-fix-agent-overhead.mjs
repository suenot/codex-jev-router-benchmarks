import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'benchmarks', 'swe-bench-verified-django-16527');
const routerRoot = resolve(process.env.CODEX_ROUTER_REPO || join(root, '..', 'codex-jev-router'));
const { routeSubagent } = await import(pathToFileURL(join(routerRoot, 'src', 'router.mjs')).href);
const { deciderConfig, evaluateDecision } = await import(pathToFileURL(join(routerRoot, 'src', 'decider.mjs')).href);
const RATES = {
  'gpt-6-sol': { input: 2, cached: 0.2, output: 10 },
  'gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5 },
};
const TEST = 'admin_views.test_templatetags.AdminTemplateTagsTest.test_submit_row_save_as_new_add_permission_required';

function argsFrom(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source') args.source = resolve(argv[++i] || '');
    else if (argv[i] === '--output') args.output = resolve(argv[++i] || '');
    else if (argv[i] === '--grade-only') args.gradeOnly = true;
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  if (!args.source || !args.output) throw new Error('Usage: node scripts/code-fix-agent-overhead.mjs --source /pinned/django/repo --output /path/results.json [--grade-only]');
  return args;
}

function execute(command, argv, { cwd, env = process.env, timeout = 600_000, input } = {}) {
  return new Promise((done, reject) => {
    const started = performance.now();
    const child = spawn(command, argv, { cwd, env, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 30_000_000) child.kill('SIGTERM'); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 5_000_000) child.kill('SIGTERM'); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      done({ code, timed_out: timedOut, stdout, stderr, wall_ms: Math.round(performance.now() - started) });
    });
    if (input != null) child.stdin.end(input);
  });
}

async function checked(command, argv, options) {
  const run = await execute(command, argv, options);
  if (run.code !== 0) throw new Error(`${command} ${argv.join(' ')} failed (${run.code}): ${(run.stderr || run.stdout).slice(-1500)}`);
  return run;
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function sanitize(text) {
  return text.replace(/\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T\/django-code-fix-(?:pair|grade)-[^/]+\/(single_sol_high|routed_parent|single|routed)/g,
    (_, arm) => arm === 'single_sol_high' || arm === 'single' ? '<WORKTREE_A>' : '<WORKTREE_B>');
}

async function archivedControls() {
  const base = await readFile(join(fixture, 'control.official-test.log'), 'utf8');
  const reference = await readFile(join(fixture, 'gold.official-test.log'), 'utf8');
  if (!base.includes('FAILED (failures=1)') || !reference.includes('\nOK\n')) {
    throw new Error('Archived base/reference official-test evidence is incomplete');
  }
  return { base_test_passed: false, reference_test_passed: true,
    base_log: '../swe-bench-verified-django-16527/control.official-test.log',
    reference_log: '../swe-bench-verified-django-16527/gold.official-test.log' };
}

function sourcePatch(patch) {
  return patch.split(/(?=^diff --git )/m).filter(section => !/^diff --git a\/[^\n]+\.sqlite3 b\//.test(section)).join('');
}

async function applyOfficialTest(repo) {
  const direct = await execute('git', ['apply', join(fixture, 'test.patch')], { cwd: repo });
  if (direct.code === 0) return { code: 0, method: 'git apply', log: direct.stdout + direct.stderr };
  const rebased = await execute('patch', ['-p1', '-F', '3', '-i', join(fixture, 'test.patch')], { cwd: repo });
  return { code: rebased.code, method: 'patch -F 3 after overlapping regression insertion',
    log: `git apply:\n${direct.stdout}${direct.stderr}\npatch:\n${rebased.stdout}${rebased.stderr}` };
}

function price(model, usage) {
  const rate = RATES[model];
  if (!rate) throw new Error(`Unknown observed model: ${model}`);
  const uncached = usage.input_tokens - usage.cached_input_tokens;
  if (uncached < 0) throw new Error('Cached input exceeds total input');
  return (uncached * rate.input + usage.cached_input_tokens * rate.cached + usage.output_tokens * rate.output) / 1_000_000;
}

async function sessionsIn(home) {
  const files = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const item = join(path, entry.name);
      if (entry.isDirectory()) await walk(item);
      else if (entry.name.endsWith('.jsonl')) files.push(item);
    }
  }
  try { await walk(join(home, 'sessions')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const sessions = [];
  for (const path of files) {
    let meta;
    let context;
    let usage;
    let spawnCount = 0;
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.type === 'session_meta') meta = event.payload;
      if (event.type === 'turn_context') context = event.payload;
      if (event.type === 'event_msg' && event.payload?.type === 'token_count') usage = event.payload.info?.total_token_usage ?? usage;
      if (event.type === 'event_msg' && event.payload?.type === 'agent_message') spawnCount += 0;
      if (event.type === 'response_item' && event.payload?.name === 'spawn_agent') spawnCount++;
    }
    if (!meta?.id || !context?.model || !usage) throw new Error(`Incomplete rollout: ${path}`);
    sessions.push({ id: meta.id, parent_id: meta.source?.subagent?.thread_spawn?.parent_thread_id ?? null,
      model: context.model, reasoning_effort: context.effort, usage, spawn_calls: spawnCount });
  }
  return sessions;
}

function parseCli(raw) {
  const events = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  return {
    root_thread_id: events.find(event => event.type === 'thread.started')?.thread_id ?? null,
    root_usage: events.findLast(event => event.type === 'turn.completed')?.usage ?? null,
    answer: events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message').at(-1)?.item?.text ?? '',
    trace: events.map(event => ({ type: event.type, item_type: event.item?.type, item_id: event.item?.id,
      thread_id: event.thread_id, usage: event.type === 'turn.completed' ? event.usage : undefined })),
  };
}

function promptFor(issue, arm, route) {
  const common = `${issue}\n\nWork only in this checked-out Django repository. Inspect the code, make the needed patch, add a focused regression test, and run relevant tests. Do not access the internet or other benchmark workspaces. The Python 3.10 test environment is on PATH. The hidden official test is unavailable during this run.`;
  if (arm === 'single_sol_high') return `${common}\n\nComplete the task yourself. Do not delegate or spawn subagents.`;
  return `${common}\n\nDelegate the complete implementation and verification to exactly one worker subagent with model=${route.model} and reasoning_effort=${route.reasoning_effort}. Give it the issue and the instructions above. Do not inspect or edit source yourself. Wait for its result, then summarize the result. Do not spawn another agent.`;
}

async function runArm({ arm, route, issue, repo, outputDir, pythonPath }) {
  const home = await mkdtemp(join(tmpdir(), 'codex-code-fix-home-'));
  try {
    const auth = join(resolve(process.env.CODEX_HOME || join(homedir(), '.codex')), 'auth.json');
    await access(auth);
    await symlink(auth, join(home, 'auth.json'));
    const env = { ...process.env, CODEX_HOME: home, PATH: `${pythonPath}:${process.env.PATH}` };
    const command = ['exec', '--json', '--ignore-user-config', '--ignore-rules', '-s', 'workspace-write', '-C', repo,
      '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort=high', '-c', 'approval_policy=never',
      '-c', `agents.enabled=${arm === 'single_sol_high' ? 'false' : 'true'}`, promptFor(issue, arm, route)];
    const run = await execute('codex', command, { cwd: repo, env });
    await writeFile(join(outputDir, `${arm}.events.jsonl`), sanitize(run.stdout));
    await writeFile(join(outputDir, `${arm}.stderr.log`), sanitize(run.stderr));
    const parsed = parseCli(run.stdout);
    await writeFile(join(outputDir, `${arm}.answer.txt`), sanitize(parsed.answer) + '\n');
    const sessions = await sessionsIn(home);
    const root = sessions.find(session => session.id === parsed.root_thread_id &&
      session.usage.input_tokens === parsed.root_usage?.input_tokens &&
      session.usage.output_tokens === parsed.root_usage?.output_tokens);
    const children = sessions.filter(session => session !== root);
    const usageComplete = Boolean(root && sessions.length === (arm === 'single_sol_high' ? 1 : 2));
    const protocolOk = usageComplete && root.model === 'gpt-6-sol' && root.reasoning_effort === 'high' &&
      (arm === 'single_sol_high' ? children.length === 0 : children.length === 1 &&
        children[0].model === route.model && children[0].reasoning_effort === route.reasoning_effort &&
        (!children[0].parent_id || children[0].parent_id === parsed.root_thread_id));
    const status = await checked('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo });
    for (const line of status.stdout.split('\n')) {
      if (line.startsWith('?? ') && !line.endsWith('.sqlite3')) await checked('git', ['add', '-N', '--', line.slice(3)], { cwd: repo });
    }
    const patch = sourcePatch((await checked('git', ['diff', '--binary'], { cwd: repo })).stdout);
    await writeFile(join(outputDir, `${arm}.patch`), patch);
    await writeFile(join(outputDir, `${arm}.trace.json`), JSON.stringify({ root_thread_id: parsed.root_thread_id,
      root_usage: parsed.root_usage, sessions, cli_events: parsed.trace }, null, 2) + '\n');
    const cost = usageComplete ? sessions.reduce((sum, item) => sum + price(item.model, item.usage), 0) : null;
    return { exit_code: run.code, timed_out: run.timed_out, wall_ms: run.wall_ms, protocol_ok: protocolOk,
      usage_complete: usageComplete, sessions, codex_tokens: usageComplete ? sessions.reduce((sum, item) => sum + item.usage.input_tokens + item.usage.output_tokens, 0) : null,
      estimated_codex_api_usd: cost, patch_sha256: sha256(patch), patch_bytes: Buffer.byteLength(patch),
      answer_file: `${arm}.answer.txt`, patch_file: `${arm}.patch`, trace_file: `${arm}.trace.json`, events_file: `${arm}.events.jsonl`, stderr_file: `${arm}.stderr.log` };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function main() {
  const args = argsFrom(process.argv.slice(2));
  const outputDir = dirname(args.output);
  await mkdir(outputDir, { recursive: true });
  const instance = JSON.parse(await readFile(join(fixture, 'instance.json'), 'utf8'));
  const issue = await readFile(join(fixture, 'prompt.txt'), 'utf8');
  const testPatch = await readFile(join(fixture, 'test.patch'));
  const temp = await mkdtemp(join(tmpdir(), 'django-code-fix-pair-'));
  const paths = { single_sol_high: join(temp, 'single'), routed_parent: join(temp, 'routed') };
  const results = { benchmark: 'Django SWE-bench Verified 16527 code-fix agent overhead', generated_at: new Date().toISOString(),
    instance_id: instance.instance_id, base_commit: instance.base_commit, source: '<PINNED_DJANGO_SOURCE>',
    codex_version: (await checked('codex', ['--version'])).stdout.trim(),
    decider_backend: deciderConfig().kind, test_patch_sha256: sha256(testPatch),
    official_test: TEST, grading: 'Local official FAIL_TO_PASS test after applying hidden test.patch; not the full SWE-bench Docker harness',
    control_evidence: await archivedControls(),
    arms: {} };
  try {
    await checked('git', ['-C', args.source, 'cat-file', '-e', `${instance.base_commit}^{commit}`]);
    for (const repo of Object.values(paths)) {
      await checked('git', ['-C', args.source, 'worktree', 'add', '--detach', repo, instance.base_commit], { timeout: 300_000 });
      await checked('git', ['sparse-checkout', 'disable'], { cwd: repo, timeout: 300_000 });
      const head = (await checked('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
      if (head !== instance.base_commit) throw new Error(`Wrong fixture commit: ${head}`);
      for (const path of [repo, dirname(repo)]) {
        try { await access(join(path, 'AGENTS.md')); throw new Error(`Unexpected AGENTS.md: ${path}`); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    const venv = join(temp, 'venv');
    await checked('uv', ['venv', '--python', 'python3.10', venv]);
    await checked('uv', ['pip', 'install', '--python', join(venv, 'bin', 'python'), 'asgiref==3.12.1', 'sqlparse==0.6.0', 'typing-extensions==4.16.0']);
    const pythonPath = join(venv, 'bin');
    let routeUsage = null;
    const routeStarted = performance.now();
    let route;
    let routeAttempts = 0;
    for (; routeAttempts < 3 && !routeUsage; routeAttempts++) {
      route = await routeSubagent({ agent_type: 'worker', message: 'Make a small prescribed Django admin template-tag permission fix and a focused regression test in known files, then run relevant tests.' }, async input => {
        const raw = await evaluateDecision(input);
        routeUsage = raw.usage ?? null;
        return raw;
      });
    }
    if (results.decider_backend === 'jev' && !routeUsage) throw new Error('Jev route failed after 3 attempts; refusing an unpriced fallback trial');
    const routeMs = Math.round(performance.now() - routeStarted);
    const jevCost = results.decider_backend === 'jev' && routeUsage?.input_tokens != null ? routeUsage.input_tokens * 0.042 / 1_000_000 : null;
    results.route = { ...route, usage: routeUsage, attempts: routeAttempts, wall_ms: routeMs, estimated_jev_api_usd: jevCost };
    await writeFile(args.output, JSON.stringify(results, null, 2) + '\n');
    for (const arm of ['single_sol_high', 'routed_parent']) {
      const repo = paths[arm];
      const run = await runArm({ arm, route, issue, repo, outputDir, pythonPath });
      const apply = await applyOfficialTest(repo);
      await writeFile(join(outputDir, `${arm}.official-patch-apply.log`), sanitize(apply.log));
      let test = null;
      if (apply.code === 0) {
        test = await execute(join(venv, 'bin', 'python'), ['tests/runtests.py', TEST, '--noinput'],
          { cwd: repo, env: { ...process.env, PATH: `${pythonPath}:${process.env.PATH}`, PYTHONPATH: repo }, timeout: 300_000 });
        await writeFile(join(outputDir, `${arm}.official-test.log`), sanitize(test.stdout + test.stderr));
      }
      const total = run.estimated_codex_api_usd == null || (arm === 'routed_parent' && jevCost == null) ? null :
        run.estimated_codex_api_usd + (arm === 'routed_parent' ? jevCost : 0);
      results.arms[arm] = { ...run, official_patch_applied: apply.code === 0, official_patch_method: apply.method,
        official_test_exit_code: test?.code ?? null, official_test_passed: test?.code === 0,
        estimated_total_api_usd: total, end_to_end_ms: run.wall_ms + (arm === 'routed_parent' ? routeMs : 0) };
      await writeFile(args.output, JSON.stringify(results, null, 2) + '\n');
      process.stderr.write(`${arm}: test=${test?.code}, protocol=${run.protocol_ok}, sessions=${run.sessions.length}, tokens=${run.codex_tokens}, cost=$${total?.toFixed(6)}\n`);
    }
  } finally {
    for (const repo of Object.values(paths)) {
      await execute('git', ['-C', args.source, 'worktree', 'remove', '--force', repo]);
    }
    await rm(temp, { recursive: true, force: true });
  }
}

async function gradeExisting(args, instance) {
  const results = JSON.parse(await readFile(args.output, 'utf8'));
  results.control_evidence = await archivedControls();
  results.grade_replay_note = 'Official tests replayed from the saved agent patches in fresh pinned worktrees with PYTHONPATH set to each worktree. The initial grading invocation omitted PYTHONPATH; agent sessions and patches were not rerun.';
  const outputDir = dirname(args.output);
  const temp = await mkdtemp(join(tmpdir(), 'django-code-fix-grade-'));
  const venv = join(temp, 'venv');
  const repos = [];
  try {
    await checked('uv', ['venv', '--python', 'python3.10', venv]);
    await checked('uv', ['pip', 'install', '--python', join(venv, 'bin', 'python'), 'asgiref==3.12.1', 'sqlparse==0.6.0', 'typing-extensions==4.16.0']);
    for (const arm of ['single_sol_high', 'routed_parent']) {
      const repo = join(temp, arm);
      repos.push(repo);
      await checked('git', ['-C', args.source, 'worktree', 'add', '--detach', repo, instance.base_commit], { timeout: 300_000 });
      await checked('git', ['sparse-checkout', 'disable'], { cwd: repo, timeout: 300_000 });
      const patchPath = join(outputDir, `${arm}.patch`);
      const patch = sourcePatch(await readFile(patchPath, 'utf8'));
      await writeFile(patchPath, patch);
      results.arms[arm].patch_sha256 = sha256(patch);
      results.arms[arm].patch_bytes = Buffer.byteLength(patch);
      const agentPatch = await execute('git', ['apply', patchPath], { cwd: repo });
      if (agentPatch.code !== 0) throw new Error(`${arm} agent patch did not apply: ${agentPatch.stderr}`);
      const officialPatch = await applyOfficialTest(repo);
      await writeFile(join(outputDir, `${arm}.official-patch-apply.log`), sanitize(officialPatch.log));
      let test = null;
      if (officialPatch.code === 0) {
        test = await execute(join(venv, 'bin', 'python'), ['tests/runtests.py', TEST, '--noinput'],
          { cwd: repo, env: { ...process.env, PATH: `${join(venv, 'bin')}:${process.env.PATH}`, PYTHONPATH: repo }, timeout: 300_000 });
        await writeFile(join(outputDir, `${arm}.official-test.log`), sanitize(test.stdout + test.stderr));
      }
      results.arms[arm].official_patch_applied = officialPatch.code === 0;
      results.arms[arm].official_patch_method = officialPatch.method;
      results.arms[arm].official_test_exit_code = test?.code ?? null;
      results.arms[arm].official_test_passed = test?.code === 0;
      await writeFile(args.output, JSON.stringify(results, null, 2) + '\n');
      process.stderr.write(`${arm} official test: ${test?.code}\n`);
    }
  } finally {
    for (const repo of repos) await execute('git', ['-C', args.source, 'worktree', 'remove', '--force', repo]);
    await rm(temp, { recursive: true, force: true });
  }
}

const args = argsFrom(process.argv.slice(2));
if (args.gradeOnly) await gradeExisting(args, JSON.parse(await readFile(join(fixture, 'instance.json'), 'utf8')));
else await main();
