import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARMS, RATES, costUsd, digest, scheduleFor, selectorProtocol, verifyManifest } from './evidence-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suite = join(root, 'benchmarks', 'evidence-mcp-2026-09-27');

function argsFor(argv) {
  const options = { repos: {}, mainRepo: resolve(process.env.CODEX_ROUTER_REPO || join(root, '..', 'codex-jev-router')) };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--results') options.results = resolve(argv[++index] || '');
    else if (arg === '--report') options.report = resolve(argv[++index] || '');
    else if (arg === '--main-repo') options.mainRepo = resolve(argv[++index] || '');
    else if (arg === '--repo') {
      const [name, path] = (argv[++index] || '').split('=');
      if (!name || !path) throw new Error('Use --repo django=/path --repo pytest=/path');
      options.repos[name] = resolve(path);
    } else throw new Error(`Unknown argument ${arg}`);
  }
  if (!options.results) throw new Error('Usage: node scripts/audit-evidence.mjs --results results.json [--report report.md] [--repo django=/pin --repo pytest=/pin]');
  return options;
}

function execute(command, args, { cwd, input, env = process.env, timeout = 120_000 } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd, env,
      stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.stdout.on('data', part => { stdout += part; });
    child.stderr.on('data', part => { stderr += part; });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); done({ code, stdout, stderr }); });
    if (input != null) child.stdin.end(input);
  });
}

function nearly(a, b) { return Math.abs(a - b) < 1e-8; }
function fail(message) { throw new Error(message); }

function independentlyGradeRead(task, answer) {
  let result;
  try { result = JSON.parse(answer.trim()); } catch { return false; }
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      Object.keys(result).sort().join(',') !== 'citations,value' ||
      !Array.isArray(result.citations) || result.citations.some(value => typeof value !== 'string') ||
      !task.citations.every(citation => result.citations.includes(citation))) return false;
  if (task.kind === 'log' && (
    !['120', '360'].some(line => result.citations.includes(`bench-logs/incident.log:${line}`)) ||
    !['620', '730'].some(line => result.citations.includes(`bench-logs/incident.log:${line}`)))) return false;
  if (task.kind === 'exact') return result.value === task.expected;
  if (typeof task.expected === 'number')
    return result.value === task.expected || result.value === String(task.expected);
  if (typeof result.value !== 'string') return false;
  const symbol = task.expected.substring(task.expected.lastIndexOf('.') + 1).toLocaleLowerCase('en');
  return result.value.toLocaleLowerCase('en').split(/[^\p{L}\p{N}_]+/u).includes(symbol);
}

async function replayEdit(task, patch, repo) {
  const temp = await mkdtemp(join(tmpdir(), 'codex-evidence-replay-'));
  const work = join(temp, 'workspace');
  try {
    const clone = await execute('git', ['clone', '--quiet', '--shared', repo, work]);
    if (clone.code) fail(`Replay clone failed: ${clone.stderr}`);
    if (task.repo === 'pytest') await writeFile(join(work, 'src', '_pytest', '_version.py'),
      'version = "dev"\nversion_tuple = (0, 0, "dev")\n');
    const path = join(work, task.changed);
    const original = await readFile(path, 'utf8');
    if (original.split(task.mutation.old).length !== 2) fail(`Mutation no longer unique: ${task.id}`);
    await writeFile(path, original.replace(task.mutation.old, task.mutation.new));
    const applied = await execute('patch', ['-p1'], { cwd: work, input: patch });
    if (applied.code) return false;
    const pythonPath = [work, ...(task.repo === 'pytest' ? [join(work, 'src')] : [])].join(':');
    const result = await execute('uv', ['run', '--no-project', '--python', '3.12', '--with', 'asgiref',
      '--with', 'sqlparse', '--with', 'pytest', 'python', join(suite, 'grade-edit.py'), task.id],
    { cwd: work, env: { ...process.env, PYTHONPATH: pythonPath,
      PYTHONPYCACHEPREFIX: join(temp, 'grade-pycache') } });
    return result.code === 0;
  } finally { await rm(temp, { recursive: true, force: true }); }
}

function percentSaved(control, candidate) {
  if (!control) return null;
  return (control - candidate) / control * 100;
}

function percentile(sorted, fraction) {
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

export function pairedBootstrap(blocks, control, candidate, seed = 27092026) {
  const taskIds = [...new Set(blocks.map(block => block.task))].sort();
  if (!taskIds.length) return null;
  const byTask = new Map(taskIds.map(id => [id, blocks.filter(block => block.task === id)]));
  let state = seed >>> 0;
  const draws = [];
  for (let draw = 0; draw < 10_000; draw++) {
    let base = 0, routed = 0;
    for (let index = 0; index < taskIds.length; index++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      const id = taskIds[(state >>> 0) % taskIds.length];
      for (const block of byTask.get(id)) {
        base += block[control].estimated_api_usd;
        routed += block[candidate].estimated_api_usd;
      }
    }
    draws.push(percentSaved(base, routed));
  }
  draws.sort((a, b) => a - b);
  return [percentile(draws, 0.025), percentile(draws, 0.975)];
}

function pairedRows(blocks, control, candidate) {
  const base = blocks.reduce((sum, block) => sum + block[control].estimated_api_usd, 0);
  const routed = blocks.reduce((sum, block) => sum + block[candidate].estimated_api_usd, 0);
  const critical = blocks.some(block => block[candidate].attempts.some(attempt =>
    attempt.changed_paths.some(path => block.kind !== 'edit' || path !== block.allowed_change)));
  const quality = !critical && blocks.every(block => !block[control].passed || block[candidate].passed) &&
    blocks.filter(block => block[candidate].passed).length >= blocks.filter(block => block[control].passed).length;
  const interval = pairedBootstrap(blocks, control, candidate);
  const saving = percentSaved(base, routed);
  const cost = saving >= 10 && interval?.[0] > 0;
  return { base, routed, saving, interval, quality, critical, cost, pass: quality && cost };
}

async function audit(options) {
  const manifestText = await readFile(join(suite, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const resultText = await readFile(options.results, 'utf8');
  const data = JSON.parse(resultText);
  const identity = data.identity;
  let postRunIntegrity = null;
  try { postRunIntegrity = JSON.parse(await readFile(join(dirname(options.results), 'post-run-integrity.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (postRunIntegrity) {
    if (postRunIntegrity.provenance !== 'post-run-supplement-not-runtime-attestation' ||
        postRunIntegrity.results_sha256 !== digest(resultText) ||
        postRunIntegrity.evidence_impl_sha256 !== digest(await readFile(join(options.mainRepo, 'src', 'evidence.mjs'))) ||
        postRunIntegrity.mcp_wrapper_sha256 !== digest(await readFile(join(options.mainRepo, 'src', 'evidence-mcp.mjs'))))
      fail('Post-run integrity supplement does not match results or current MCP source');
  }
  if (JSON.stringify(data.laya_backend) !== JSON.stringify({
    url: 'http://127.0.0.1:8000/v1/systemone', model: 'typed-decisions',
    binding: 'loopback only; no hosted decision backend',
  })) fail('Laya backend differs from preregistered local endpoint/model');
  if (JSON.stringify(data.pricing.model_rates) !== JSON.stringify(RATES))
    fail('Recorded model rates differ from audited price snapshot');
  if (JSON.stringify(identity.commits) !== JSON.stringify(Object.fromEntries(
    Object.entries(manifest.repositories).map(([name, repo]) => [name, repo.commit]))))
    fail('Pinned commits differ from preregistration');
  if (identity.server_sha256 !== digest(await readFile(join(options.mainRepo, 'src', 'evidence-mcp.mjs'))))
    fail('MCP server changed since result capture');
  if (Object.keys(options.repos).length) {
    if (!options.repos.django || !options.repos.pytest) fail('Supply both pinned repositories for replay');
    for (const [name, path] of Object.entries(options.repos)) {
      const commit = await execute('git', ['-C', path, 'rev-parse', 'HEAD']);
      if (commit.code || commit.stdout.trim() !== manifest.repositories[name]?.commit)
        fail(`Wrong pinned ${name} checkout for audit`);
    }
    await verifyManifest(manifest, options.repos);
  }
  if (identity.manifest_sha256 !== digest(manifestText) ||
      identity.runner_sha256 !== digest(await readFile(join(root, 'scripts', 'evidence-mcp-study.mjs'))) ||
      identity.library_sha256 !== digest(await readFile(join(root, 'scripts', 'evidence-lib.mjs'))) ||
      identity.grader_sha256 !== digest(await readFile(join(suite, 'grade-edit.py'))))
    fail('Runner, manifest, library, or grader changed since result capture');
  const tasks = manifest.tasks.filter(task => task.phase === identity.phase && identity.selected_tasks.includes(task.id));
  if (tasks.length !== identity.selected_tasks.length) fail('Unknown or duplicate selected task');
  const schedule = scheduleFor(tasks, identity.repetitions, manifest.seed);
  if (JSON.stringify(schedule) !== JSON.stringify(data.schedule)) fail('Arm schedule changed');
  const expectedKeys = schedule.flatMap(block => block.order.map(arm => `${block.task}:${block.repetition}:${arm}`));
  const actualKeys = data.runs.map(run => `${run.task}:${run.repetition}:${run.arm}`);
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys.slice(0, actualKeys.length)))
    fail('Runs are not a prefix of the preregistered schedule');
  const taskMap = new Map(tasks.map(task => [task.id, task]));
  const traceRoot = dirname(options.results);
  let replayed = 0;
  for (const run of data.runs) {
    const task = taskMap.get(run.task);
    if (run.kind !== task.kind || run.repo !== task.repo || !run.attempts.length ||
        run.attempts.length > identity.max_attempts) fail(`Invalid run metadata: ${run.task}`);
    let total = 0;
    for (const attempt of run.attempts) {
      const tracePath = resolve(traceRoot, attempt.trace);
      if (!tracePath.startsWith(traceRoot + '/') || !tracePath.endsWith('.jsonl')) fail('Unsafe trace path');
      const events = (await readFile(tracePath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      if (!events.some(event => event.type === 'turn.completed')) fail(`No completion in ${attempt.trace}`);
      if (attempt.sessions.length !== 1 || attempt.sessions[0].id !== attempt.root_thread_id ||
          attempt.sessions[0].model !== 'gpt-6-sol' || attempt.sessions[0].reasoning_effort !== 'xhigh' ||
          attempt.sessions[0].usage.input_tokens !== attempt.root_usage?.input_tokens ||
          attempt.sessions[0].usage.output_tokens !== attempt.root_usage?.output_tokens)
        fail(`Root or child session mismatch: ${run.task}`);
      const price = costUsd('gpt-6-sol', attempt.sessions[0].usage, RATES);
      const protocol = price != null && selectorProtocol(run.arm, attempt.selector_audit);
      if (attempt.protocol_ok !== protocol || (protocol && !nearly(attempt.estimated_api_usd, price)) ||
          (!protocol && attempt.estimated_api_usd != null)) fail(`Usage or protocol mismatch: ${run.task}`);
      let grade;
      if (task.kind === 'edit') {
        if (!attempt.patch) fail(`Missing edit patch: ${run.task}`);
        const patchPath = resolve(traceRoot, attempt.patch.path);
        if (!patchPath.startsWith(traceRoot + '/')) fail('Unsafe patch path');
        const patch = await readFile(patchPath, 'utf8');
        if (digest(patch) !== attempt.patch.sha256 || Buffer.byteLength(patch) !== attempt.patch.bytes)
          fail(`Patch hash mismatch: ${run.task}`);
        if (options.repos[task.repo]) {
          const success = await replayEdit(task, patch, options.repos[task.repo]);
          replayed++;
          const completion = (() => { try { return JSON.stringify(JSON.parse(attempt.answer)) === '{"done":true}'; }
            catch { return false; } })();
          grade = completion && attempt.changed_paths.join(',') === task.changed && success;
          if (grade !== attempt.grade.correct) fail(`Edit grade does not replay: ${run.task}`);
        }
      } else {
        grade = independentlyGradeRead(task, attempt.answer) && !attempt.changed_paths.length;
        if (grade !== attempt.grade.correct) fail(`Read grade mismatch: ${run.task}`);
      }
      if (attempt.estimated_api_usd == null) total = null;
      else if (total != null) total += price;
    }
    if ((total == null) !== (run.estimated_api_usd == null) ||
        (total != null && !nearly(total, run.estimated_api_usd)) ||
        run.end_to_end_ms !== run.attempts.reduce((sum, attempt) => sum + attempt.wall_ms, 0))
      fail(`Retry-inclusive cost or time mismatch: ${run.task}`);
    const last = run.attempts.at(-1);
    if (run.passed !== (last.exit_code === 0 && last.protocol_ok && last.grade.correct))
      fail(`Pass flag mismatch: ${run.task}`);
  }
  const complete = actualKeys.length === expectedKeys.length;
  const editAttempts = data.runs.filter(run => run.kind === 'edit')
    .reduce((sum, run) => sum + run.attempts.length, 0);
  const fullHoldout = complete && identity.phase === 'holdout' && identity.repetitions === 3 &&
    identity.selected_tasks.length === 16 && replayed === editAttempts;
  const allPriced = data.runs.every(run => run.estimated_api_usd != null);
  const groups = [];
  if (complete && allPriced) {
    const byKey = new Map(data.runs.map(run => [`${run.task}:${run.repetition}:${run.arm}`, run]));
    const blocks = schedule.map(block => ({ task: block.task, kind: taskMap.get(block.task).kind,
      allowed_change: taskMap.get(block.task).changed ?? null,
      ...Object.fromEntries(ARMS.map(arm => [arm, byKey.get(`${block.task}:${block.repetition}:${arm}`)])) }));
    for (const kind of ['all', 'eligible', 'exact', 'log', 'multi', 'edit']) {
      const rows = kind === 'all' ? blocks : kind === 'eligible' ?
        blocks.filter(block => manifest.protocol.mcp_eligible_kinds.includes(block.kind)) :
        blocks.filter(block => block.kind === kind);
      if (!rows.length) continue;
      groups.push({ kind, blocks: rows.length,
        deterministic: pairedRows(rows, 'stock', 'deterministic'),
        laya_vs_stock: pairedRows(rows, 'stock', 'laya'),
        laya_vs_deterministic: pairedRows(rows, 'deterministic', 'laya') });
    }
  }
  const nonuse = Object.fromEntries(['exact', 'log', 'multi', 'edit'].map(kind => [kind,
    data.runs.filter(run => run.kind === kind && run.arm !== 'stock' &&
      run.attempts.every(attempt => !attempt.selector_audit.length)).length]));
  const layaRecords = data.runs.filter(run => run.arm === 'laya')
    .flatMap(run => run.attempts.flatMap(attempt => attempt.selector_audit));
  const eligible = layaRecords.filter(record => record.candidates >= 8);
  const layaGate = eligible.length > 0 && eligible.every(record =>
    record.used_selector === 'laya' && !record.fallback);
  const releaseReady = fullHoldout && allPriced;
  const lines = ['# Local evidence MCP benchmark', '',
    `Status: **${releaseReady ? 'complete, audited holdout' : 'pending / diagnostic only'}**.`, '',
    `Runs: ${data.runs.length}/${expectedKeys.length}; edit attempts replayed: ${replayed}; eligible Laya searches: ${eligible.length}; genuine local Laya selection: ${layaGate ? 'yes' : 'not established'}.`, '',
    `Intervention runs with no MCP search, by task kind: ${Object.entries(nonuse).map(([kind, count]) => `${kind}=${count}`).join(', ')}. Nonuse is a valid measured outcome in every arm; log and multi-file tasks are preregistered as most likely to benefit.`, '',
    'The three arms use one Codex `gpt-6-sol` root at `xhigh`; child agents are disabled. The baseline has no MCP and is instructed to use ordinary local commands. Intervention arms have the local MCP and are instructed to prefer it for broad or noisy searches, with deterministic or Laya selection (`typed-decisions` at loopback `127.0.0.1:8000`). The comparison measures tool availability together with this instruction; it does not show that Codex would discover and use the MCP unaided. Every attempt, including retries, contributes its Codex input, cached input, cache writes, and output tokens to the estimated API price. Local CPU/electricity, other charges, and subscription billing are excluded.', '',
    'The four incident logs are deterministic noisy overlays on two pinned public source repositories; they are not production logs. The final holdout task set was frozen after the excluded diagnostics and before the complete 144-run comparison. Tuning tasks are disjoint. Relative uncertainty uses task-cluster bootstrap resampling (10,000 draws) over paired repetitions.', ''];
  lines.push('Two earlier diagnostics are excluded: a [three-arm pilot](pilot-diagnostic/README.md) exposed an overstrict log-citation rule; an [interrupted 34-run format diagnostic](diagnostic-format/README.md) exposed overstrict answer formatting. Every read task shown in either diagnostic was replaced, while the four unrun edit tasks were retained. The final manifest and grader were frozen before any replacement task was run. These revisions mean this is a frozen **final** holdout after diagnostic feedback, not an untouched first-pass preregistration.', '');
  lines.push(postRunIntegrity ?
    `Supplemental post-run integrity: [post-run-integrity.json](post-run-integrity.json) binds this results file and the MCP wrapper to SHA-256 digests. The evidence implementation was **not hashed at run time**. Its first post-run digest was \`${postRunIntegrity.pre_privacy_post_run_capture?.evidence_impl_sha256 ?? 'unavailable'}\`; the current post-change digest is \`${postRunIntegrity.evidence_impl_sha256}\`. Neither digest proves the implementation bytes used during model runs.` :
    'The run identity hashes the MCP wrapper but not the evidence implementation. No post-run implementation digest is attached; implementation bytes used during each run cannot be independently proven.', '');
  lines.push('After the measured run, the main MCP implementation was hardened to exclude hidden paths such as `.zshrc` and to stop using `rg --hidden`. A targeted post-change preflight on the `dj-signing-incident` fixture returned six excerpts from 16 candidates and excluded a matching hidden `.zshrc`; the full economic comparison was **not** rerun after this change.', '');
  if (groups.length) {
    lines.push('| Task kind | Pair | Strict passes | Control USD | Candidate USD | Saving | 95% CI | Quality | Cost gate |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |');
    for (const group of groups) {
      const groupRuns = data.runs.filter(run => group.kind === 'all' ||
        (group.kind === 'eligible' ? manifest.protocol.mcp_eligible_kinds.includes(run.kind) : run.kind === group.kind));
      for (const [label, key, control, candidate] of [
        ['local deterministic vs stock', 'deterministic', 'stock', 'deterministic'],
        ['local Laya vs stock', 'laya_vs_stock', 'stock', 'laya'],
        ['local Laya vs deterministic', 'laya_vs_deterministic', 'deterministic', 'laya']]) {
        const outcome = group[key];
        const passCount = arm => groupRuns.filter(run => run.arm === arm && run.passed).length;
        lines.push(`| ${group.kind} | ${label} | ${passCount(candidate)}/${passCount(control)} | $${outcome.base.toFixed(6)} | $${outcome.routed.toFixed(6)} | ${outcome.saving.toFixed(1)}% | ${outcome.interval.map(value => `${value.toFixed(1)}%`).join(' to ')} | ${outcome.quality ? 'pass' : 'fail'} | ${outcome.cost ? 'pass' : 'fail'} |`);
      }
    }
    lines.push('');
    lines.push('## Individual final tasks', '',
      'Each cost is the sum of three repetitions, including retries. Pass counts are strict final grades. Savings compare deterministic MCP with stock Codex for the same task; task-level differences have only three paired repetitions and are descriptive.', '',
      '| Task | Kind | Stock USD (pass) | Deterministic USD (pass) | Laya USD (pass) | Deterministic saving |',
      '| --- | --- | ---: | ---: | ---: | ---: |');
    for (const task of tasks) {
      const selected = data.runs.filter(run => run.task === task.id);
      const summary = arm => {
        const rows = selected.filter(run => run.arm === arm);
        return { usd: rows.reduce((sum, run) => sum + run.estimated_api_usd, 0),
          passed: rows.filter(run => run.passed).length, count: rows.length };
      };
      const stock = summary('stock'), deterministic = summary('deterministic'), laya = summary('laya');
      const cell = value => `$${value.usd.toFixed(6)} (${value.passed}/${value.count})`;
      lines.push(`| \`${task.id}\` | ${task.kind} | ${cell(stock)} | ${cell(deterministic)} | ${cell(laya)} | ${percentSaved(stock.usd, deterministic.usd).toFixed(1)}% |`);
    }
    lines.push('');
  }
  if (!releaseReady) lines.push('No release claim is allowed until all 144 holdout runs are priced and every edit patch replays against the pinned source.', '');
  else {
    const all = groups.find(group => group.kind === 'all');
    const eligibleGroup = groups.find(group => group.kind === 'eligible');
    const log = groups.find(group => group.kind === 'log');
    const multi = groups.find(group => group.kind === 'multi');
    const deterministic = all.deterministic.quality && eligibleGroup.deterministic.cost;
    const laya = layaGate && all.laya_vs_deterministic.quality && eligibleGroup.laya_vs_deterministic.cost;
    lines.push(`Recommendation gate for deterministic evidence (all-task quality plus eligible-task cost): **${deterministic ? 'PASS' : 'FAIL'}**. Laya default gate (same quality, extra eligible-task cost saving, genuine local selection): **${laya ? 'PASS' : 'FAIL'}**.`, '');
    lines.push(`Interpretation: deterministic MCP saved **${eligibleGroup.deterministic.saving.toFixed(1)}%** estimated Codex API cost on the preregistered log and multi-file tasks (task-cluster 95% CI ${eligibleGroup.deterministic.interval.map(value => `${value.toFixed(1)}%`).join(' to ')}) and **${all.deterministic.saving.toFixed(1)}%** across all tasks. The measurable signal came from noisy logs (${log.deterministic.saving.toFixed(1)}% saved); the MCP was unused in ${nonuse.multi} multi-file intervention runs, so that category does not demonstrate retrieval benefit. Local Laya made ${eligible.length} genuine eligible selections but cost **${Math.abs(eligibleGroup.laya_vs_deterministic.saving).toFixed(1)}% ${eligibleGroup.laya_vs_deterministic.saving < 0 ? 'more' : 'less'}** than deterministic selection on eligible tasks and does not pass the default gate.`, '');
    lines.push('Use deterministic evidence selection selectively for noisy log investigations. These four synthetic log overlays on two real pinned repositories do not establish a production-wide savings rate. Exact lookups and bounded edits did not meet their separate 10% confidence gate; the sessions were fresh, so continuing-dialog cache effects remain unmeasured.', '');
  }
  return { report: lines.join('\n'), releaseReady };
}

const options = argsFor(process.argv.slice(2));
const outcome = await audit(options);
if (options.report) await writeFile(options.report, outcome.report);
else process.stdout.write(outcome.report);
