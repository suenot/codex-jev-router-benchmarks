import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARMS, RATES, costUsd, digest, logFixture, parseFinal, readGrade, scheduleFor, selectorProtocol, verifyManifest } from './evidence-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suite = join(root, 'benchmarks', 'evidence-mcp-2026-09-27');

function argumentsFor(argv) {
  const options = { repositories: {}, phase: 'holdout', repetitions: 3, maxAttempts: 2, tasks: [],
    mainRepo: resolve(process.env.CODEX_ROUTER_REPO || join(root, '..', 'codex-jev-router')) };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--output') options.output = resolve(argv[++index] || '');
    else if (token === '--repo') {
      const [name, path] = (argv[++index] || '').split('=');
      if (!name || !path || options.repositories[name]) throw new Error('Use --repo django=/path --repo pytest=/path');
      options.repositories[name] = resolve(path);
    } else if (token === '--main-repo') options.mainRepo = resolve(argv[++index] || '');
    else if (token === '--phase') options.phase = argv[++index];
    else if (token === '--task') options.tasks.push(argv[++index]);
    else if (token === '--repetitions') options.repetitions = Number(argv[++index]);
    else if (token === '--max-attempts') options.maxAttempts = Number(argv[++index]);
    else if (token === '--dry-run') options.dryRun = true;
    else throw new Error(`Unknown argument ${token}`);
  }
  if (!['holdout', 'tuning'].includes(options.phase) || !Number.isInteger(options.repetitions) ||
      options.repetitions < 1 || options.repetitions > 3 || !Number.isInteger(options.maxAttempts) ||
      options.maxAttempts < 1 || options.maxAttempts > 2 || (!options.dryRun && !options.output)) {
    throw new Error('Usage: node scripts/evidence-mcp-study.mjs --repo django=/pin --repo pytest=/pin --output results.json [--phase holdout|tuning] [--repetitions 3] [--max-attempts 2] [--task ID] [--dry-run]');
  }
  return options;
}

function execute(command, argv, { cwd, env = process.env, timeout = 420_000 } = {}) {
  return new Promise((done, reject) => {
    const started = performance.now();
    const child = spawn(command, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 25_000_000) child.kill('SIGTERM'); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 2_000_000) child.kill('SIGTERM'); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      done({ code, timed_out: timedOut, stdout, stderr, wall_ms: Math.round(performance.now() - started) });
    });
  });
}

async function pinnedRepository(path, commit) {
  const status = await execute('git', ['-C', path, 'rev-parse', 'HEAD']);
  if (status.code || status.stdout.trim() !== commit) throw new Error(`Repository ${path} must be checked out at ${commit}`);
}

async function sessionsIn(home) {
  const sessions = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.jsonl')) {
        let meta, context, usage;
        for (const line of (await readFile(path, 'utf8')).split('\n')) {
          if (!line) continue;
          const event = JSON.parse(line);
          if (event.type === 'session_meta') meta = event.payload;
          if (event.type === 'turn_context') context = event.payload;
          if (event.type === 'event_msg' && event.payload?.type === 'token_count')
            usage = event.payload.info?.total_token_usage ?? usage;
        }
        if (meta?.id && context?.model && usage) sessions.push({ id: meta.id,
          parent_id: meta.source?.subagent?.thread_spawn?.parent_thread_id ?? null,
          model: context.model, reasoning_effort: context.effort, usage });
      }
    }
  }
  try { await walk(join(home, 'sessions')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return sessions;
}

async function prepareWorkspace(task, source, temp) {
  const work = join(temp, 'workspace');
  const clone = await execute('git', ['clone', '--quiet', '--shared', source, work], { timeout: 120_000 });
  if (clone.code) throw new Error(`Local clone failed: ${clone.stderr}`);
  if (task.repo === 'pytest') {
    await writeFile(join(work, 'src', '_pytest', '_version.py'),
      'version = "dev"\nversion_tuple = (0, 0, "dev")\n');
  }
  if (task.kind === 'log') {
    await mkdir(join(work, 'bench-logs'));
    await writeFile(join(work, 'bench-logs', 'incident.log'), logFixture(task));
  }
  let mutatedOriginal = null;
  if (task.kind === 'edit') {
    const path = join(work, task.changed);
    const original = await readFile(path, 'utf8');
    const mutated = original.replace(task.mutation.old, task.mutation.new);
    if (mutated === original) throw new Error(`Mutation did not apply: ${task.id}`);
    await writeFile(path, mutated);
    mutatedOriginal = join(temp, 'mutated-original.txt');
    await writeFile(mutatedOriginal, mutated);
  }
  const initialStatus = (await execute('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: work })).stdout;
  const initialLogHash = task.kind === 'log' ? digest(await readFile(join(work, 'bench-logs', 'incident.log'))) : null;
  const initialVersionHash = task.repo === 'pytest' ? digest(await readFile(join(work, 'src', '_pytest', '_version.py'))) : null;
  const initialEditHash = task.kind === 'edit' ? digest(await readFile(join(work, task.changed))) : null;
  return { work, mutatedOriginal, initialStatus, initialLogHash, initialVersionHash, initialEditHash };
}

async function changedPaths(task, fixture) {
  const currentStatus = (await execute('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: fixture.work })).stdout;
  const initial = new Set(fixture.initialStatus.trim().split('\n').filter(Boolean));
  const current = new Set(currentStatus.trim().split('\n').filter(Boolean));
  const unexpected = [...current].filter(line => !initial.has(line)).map(line => line.slice(3));
  if (task.kind === 'log' && digest(await readFile(join(fixture.work, 'bench-logs', 'incident.log'))) !== fixture.initialLogHash)
    unexpected.push('bench-logs/incident.log');
  if (task.repo === 'pytest' && digest(await readFile(join(fixture.work, 'src', '_pytest', '_version.py'))) !== fixture.initialVersionHash)
    unexpected.push('src/_pytest/_version.py');
  if (task.kind === 'edit' && digest(await readFile(join(fixture.work, task.changed))) !== fixture.initialEditHash)
    unexpected.push(task.changed);
  return [...new Set(unexpected)].sort();
}

async function gradeEdit(task, work, answer, changes) {
  let completion = false;
  try { completion = JSON.stringify(JSON.parse(answer.trim())) === '{"done":true}'; } catch { /* graded below */ }
  if (!completion || changes.join(',') !== task.changed) return { correct: false,
    detail: `completion=${completion}; changed=${changes.join(',')}` };
  const pythonPath = [work, ...(task.repo === 'pytest' ? [join(work, 'src')] : [])].join(':');
  const command = await execute('uv', ['run', '--no-project', '--python', '3.12', '--with', 'asgiref',
    '--with', 'sqlparse', '--with', 'pytest', 'python', join(suite, 'grade-edit.py'), task.id],
  { cwd: work, env: { ...process.env, PYTHONPATH: pythonPath,
    PYTHONPYCACHEPREFIX: join(dirname(work), 'grade-pycache') }, timeout: 120_000 });
  return { correct: command.code === 0, detail: command.code === 0 ? 'hidden behavior checks passed' :
    (command.stdout + command.stderr).slice(-1200) };
}

function promptFor(task, arm) {
  const common = `Work only in this pinned public ${task.repo} checkout. Do not access the internet or another workspace. ` +
    `${task.prompt}\n` + (task.kind === 'edit' ?
      'Edit only the named source file. Return only {"done":true}.' :
      'Do not change any file. Return only JSON with exactly {"value": <answer>, "citations": ["path:line", ...]}. Cite the exact source lines specified by your evidence, including the incident traceback line for log tasks.');
  return arm === 'stock' ? `${common}\nUse ordinary local commands to inspect the checkout. Do not create a subagent.` :
    `${common}\nA local evidence MCP is available. For broad or noisy searches, prefer search_workspace_evidence and use read_selected_evidence when more context is needed. For exact named symbols or a known file, ordinary local commands are fine. Do not create a subagent.`;
}

function configFor(arm, node, server, workspace, auditPath) {
  if (arm === 'stock') return '';
  return `[mcp_servers.evidence]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify([
    server, '--root', workspace, '--selector', arm])}\nstartup_timeout_sec = 30\n\n` +
    `[mcp_servers.evidence.env]\nCODEX_EVIDENCE_BENCH_LOG = ${JSON.stringify(auditPath)}\n` +
    (arm === 'laya' ? 'CODEX_ROUTER_DECIDER_MODEL = "typed-decisions"\nCODEX_ROUTER_DECIDER_URL = "http://127.0.0.1:8000/v1/systemone"\n' : '');
}

async function readSelectorAudit(path) {
  try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function savePatch(task, fixture, tracePath) {
  if (task.kind !== 'edit') return null;
  const patchPath = tracePath.replace(/\.jsonl$/, '.patch');
  const diff = await execute('diff', ['-u', '--label', `a/${task.changed}`, '--label', `b/${task.changed}`,
    fixture.mutatedOriginal, join(fixture.work, task.changed)]);
  if (![0, 1].includes(diff.code)) throw new Error(`diff failed: ${diff.stderr}`);
  await writeFile(patchPath, diff.stdout);
  return { path: `${basename(dirname(patchPath))}/${basename(patchPath)}`,
    sha256: digest(diff.stdout), bytes: Buffer.byteLength(diff.stdout) };
}

async function oneAttempt({ task, arm, options, source, tracePath, server }) {
  const temp = await mkdtemp(join(tmpdir(), 'codex-evidence-study-'));
  try {
    const fixture = await prepareWorkspace(task, source, temp);
    const home = join(temp, 'codex-home');
    const auditPath = join(temp, 'selector-audit.jsonl');
    await mkdir(home);
    const auth = join(resolve(process.env.CODEX_HOME || join(homedir(), '.codex')), 'auth.json');
    await access(auth);
    await symlink(auth, join(home, 'auth.json'));
    await writeFile(join(home, 'config.toml'), configFor(arm, process.execPath, server, fixture.work, auditPath));
    const invocation = ['exec', '--json', '--skip-git-repo-check', '--ignore-rules', '-s', 'workspace-write',
      '-C', fixture.work, '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort=xhigh',
      '-c', 'approval_policy=never', '-c', 'agents.enabled=false', promptFor(task, arm)];
    const result = await execute('codex', invocation, { cwd: fixture.work, env: {
      ...process.env, CODEX_HOME: home, OPENROUTER_API_KEY: '', JEV_API_KEY: '', TYPESAFE_API_KEY: '' } });
    let parsed = { answer: '', root_thread_id: null, root_usage: null, trace: [] };
    try { parsed = parseFinal(result.stdout); } catch (error) { parsed.parse_error = String(error); }
    const records = await readSelectorAudit(auditPath);
    await writeFile(tracePath, parsed.trace.map(event => JSON.stringify(event)).join('\n') + '\n');
    const sessions = await sessionsIn(home);
    const rootSessions = sessions.filter(session => session.id === parsed.root_thread_id &&
      session.model === 'gpt-6-sol' && session.reasoning_effort === 'xhigh' &&
      session.usage.input_tokens === parsed.root_usage?.input_tokens &&
      session.usage.output_tokens === parsed.root_usage?.output_tokens);
    const protocolOk = rootSessions.length === 1 && sessions.length === 1 &&
      costUsd('gpt-6-sol', sessions[0].usage) != null &&
      selectorProtocol(arm, records);
    const changes = await changedPaths(task, fixture);
    const grade = task.kind === 'edit' ? await gradeEdit(task, fixture.work, parsed.answer, changes) :
      changes.length ? { correct: false, detail: `unexpected changes: ${changes.join(',')}` } : readGrade(task, parsed.answer);
    const patch = await savePatch(task, fixture, tracePath);
    return { exit_code: result.code, timed_out: result.timed_out, wall_ms: result.wall_ms,
      root_thread_id: parsed.root_thread_id, root_usage: parsed.root_usage, sessions,
      selector_audit: records, protocol_ok: protocolOk, answer: parsed.answer, grade,
      changed_paths: changes, patch, estimated_api_usd: protocolOk ? costUsd('gpt-6-sol', sessions[0].usage) : null,
      ...(parsed.parse_error ? { parse_error: parsed.parse_error } : {}),
      ...(result.code ? { stderr_tail: result.stderr.slice(-1200) } : {}) };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  const manifestText = await readFile(join(suite, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const tasks = manifest.tasks.filter(task => task.phase === options.phase &&
    (!options.tasks.length || options.tasks.includes(task.id)));
  if (!tasks.length || options.tasks.some(id => !tasks.some(task => task.id === id))) throw new Error('Unknown task selection');
  const schedule = scheduleFor(tasks, options.repetitions, manifest.seed);
  if (options.dryRun) {
    process.stdout.write(JSON.stringify({ phase: options.phase, selected_tasks: tasks.map(task => task.id),
      scheduled_runs: schedule.length * ARMS.length, schedule }, null, 2) + '\n');
    return;
  }
  for (const [name, spec] of Object.entries(manifest.repositories)) {
    if (!options.repositories[name]) throw new Error(`Missing --repo ${name}=/absolute/path`);
    await pinnedRepository(options.repositories[name], spec.commit);
  }
  await verifyManifest(manifest, options.repositories);
  const server = join(options.mainRepo, 'src', 'evidence-mcp.mjs');
  await access(server);
  const identity = { manifest_sha256: digest(manifestText), runner_sha256: digest(await readFile(fileURLToPath(import.meta.url))),
    library_sha256: digest(await readFile(join(root, 'scripts', 'evidence-lib.mjs'))),
    grader_sha256: digest(await readFile(join(suite, 'grade-edit.py'))),
    server_sha256: digest(await readFile(server)),
    phase: options.phase, selected_tasks: tasks.map(task => task.id),
    repetitions: options.repetitions, max_attempts: options.maxAttempts,
    commits: Object.fromEntries(Object.entries(manifest.repositories).map(([key, spec]) => [key, spec.commit])) };
  const traceDir = options.output.replace(/\.json$/, '') + '-traces';
  await mkdir(dirname(options.output), { recursive: true });
  await mkdir(traceDir, { recursive: true });
  let results;
  try { results = JSON.parse(await readFile(options.output, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (results && JSON.stringify(results.identity) !== JSON.stringify(identity))
    throw new Error('Existing result identity differs; choose another output path');
  results ??= { benchmark: 'local evidence MCP against one Sol xhigh root',
    generated_at: new Date().toISOString(), identity,
    codex_version: (await execute('codex', ['--version'])).stdout.trim(),
    pricing: { currency: 'USD', units: 'per million tokens', model_rates: RATES,
      source: 'https://developers.openai.com/api/docs/pricing',
      caveat: 'API cost estimate, not subscription billing; local selector compute and electricity not priced' },
    laya_backend: { url: 'http://127.0.0.1:8000/v1/systemone', model: 'typed-decisions',
      binding: 'loopback only; no hosted decision backend' },
    isolation: 'fresh local clone and CODEX_HOME per attempt; no inherited MCP config; agents disabled; no hosted decider',
    schedule, runs: [] };
  for (const block of schedule) {
    const task = tasks.find(item => item.id === block.task);
    for (const arm of block.order) {
      if (results.runs.some(run => run.task === task.id && run.repetition === block.repetition && run.arm === arm)) continue;
      const attempts = [];
      for (let number = 1; number <= options.maxAttempts; number++) {
        const traceName = `${task.id}.rep${block.repetition}.${arm}.attempt${number}.jsonl`;
        const tracePath = join(traceDir, traceName);
        const trial = await oneAttempt({ task, arm, options,
          source: options.repositories[task.repo], tracePath, server });
        attempts.push({ ...trial, trace: `${traceDir.split('/').at(-1)}/${traceName}` });
        if (trial.exit_code === 0 && trial.protocol_ok && trial.grade.correct && trial.estimated_api_usd != null) break;
      }
      const last = attempts.at(-1);
      const total = attempts.every(attempt => attempt.estimated_api_usd != null) ?
        attempts.reduce((sum, attempt) => sum + attempt.estimated_api_usd, 0) : null;
      results.runs.push({ task: task.id, kind: task.kind, repo: task.repo, arm,
        repetition: block.repetition, attempts, passed: last.exit_code === 0 && last.protocol_ok && last.grade.correct,
        estimated_api_usd: total, end_to_end_ms: attempts.reduce((sum, attempt) => sum + attempt.wall_ms, 0) });
      await writeFile(options.output, JSON.stringify(results, null, 2) + '\n');
      process.stderr.write(`${task.id} rep${block.repetition} ${arm}: pass=${results.runs.at(-1).passed} attempts=${attempts.length} api_usd=${total}\n`);
    }
  }
}

await main();
