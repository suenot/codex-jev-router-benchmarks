import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const ARMS = ['stock', 'deterministic', 'laya'];
export const RATES = Object.freeze({
  'gpt-6-sol': { input: 2, cached: 0.2, cache_write: 2.5, output: 10 },
});

export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function armOrder(taskId, repetition, seed) {
  let state = (seed ^ repetition) >>> 0;
  for (const char of taskId) state = (Math.imul(state, 33) + char.charCodeAt(0)) >>> 0;
  const order = [...ARMS];
  for (let i = order.length - 1; i > 0; i--) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const j = (state >>> 0) % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

export function scheduleFor(tasks, repetitions, seed) {
  return Array.from({ length: repetitions }, (_, index) => tasks.map(task => ({
    task: task.id, repetition: index + 1, order: armOrder(task.id, index + 1, seed),
  }))).flat();
}

export function costUsd(model, usage, rates = RATES) {
  const rate = rates[model];
  if (!rate || !usage) return null;
  const { input_tokens: input, cached_input_tokens: cached,
    cache_write_input_tokens: write = 0, output_tokens: output } = usage;
  // Codex reports cached and cache-write tokens as subsets of input_tokens.
  // A session above the short-context boundary is conservatively unpriced:
  // total session usage cannot prove whether an individual request crossed it.
  if (![input, cached, write, output].every(value => Number.isSafeInteger(value) && value >= 0) ||
      cached + write > input || input > 272_000) return null;
  return ((input - cached - write) * rate.input + cached * rate.cached +
    write * rate.cache_write + output * rate.output) / 1_000_000;
}

export function parseFinal(raw) {
  const events = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const last = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message').at(-1);
  return {
    answer: last?.item?.text ?? '',
    root_thread_id: events.find(event => event.type === 'thread.started')?.thread_id ?? null,
    root_usage: events.findLast(event => event.type === 'turn.completed')?.usage ?? null,
    trace: events.map(event => {
      if (event.type === 'thread.started') return { type: event.type, thread_id: event.thread_id };
      if (event.type === 'turn.completed') return { type: event.type, usage: event.usage };
      if (event.type === 'item.completed') return { type: event.type, item_type: event.item?.type,
        tool: event.item?.tool, server: event.item?.server,
        ...(event.item?.type === 'agent_message' ? { text: event.item.text } : {}),
        ...(event.item?.type === 'command_execution' ? { exit_code: event.item.exit_code } : {}) };
      return { type: event.type };
    }),
  };
}

function answerMatches(task, value) {
  if (task.kind === 'exact') return JSON.stringify(value) === JSON.stringify(task.expected);
  if (typeof task.expected === 'number') return value === task.expected || value === String(task.expected);
  if (typeof value !== 'string') return false;
  const symbol = task.expected.split('.').at(-1);
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?:$|[^\\p{L}\\p{N}_])`, 'iu').test(value);
}

export function readGrade(task, answer) {
  let parsed;
  try { parsed = JSON.parse(answer.trim()); } catch { return { correct: false, detail: 'invalid JSON' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !== 'citations,value' ||
      !answerMatches(task, parsed.value) ||
      !Array.isArray(parsed.citations) ||
      parsed.citations.some(value => typeof value !== 'string') ||
      !task.citations.every(citation => parsed.citations.includes(citation)) ||
      (task.kind === 'log' && (!['120', '360'].some(line => parsed.citations.includes(`bench-logs/incident.log:${line}`)) ||
        !['620', '730'].some(line => parsed.citations.includes(`bench-logs/incident.log:${line}`))))) {
    return { correct: false, detail: 'answer or required source citations do not match' };
  }
  return { correct: true, detail: 'exact answer and source citations' };
}

export function logFixture(task) {
  const correlation = task.prompt.match(/correlation ([A-Z-]+\d+)/)?.[1];
  if (!correlation || !task.log_source) throw new Error(`Invalid log task ${task.id}`);
  const lines = [];
  for (let index = 1; index <= 1200; index++) {
    if (index === 120) lines.push(`WARN correlation=${correlation} attempt=1 retry scheduled after recoverable error`);
    else if (index === 360) lines.push(`Traceback correlation=${correlation} attempt=1 recovered at decoy/first.py:12 in preliminary_probe`);
    else if (index === 620) lines.push(`WARN correlation=${correlation} attempt=2 retry scheduled after recoverable error`);
    else if (index === 730) lines.push(`Traceback correlation=${correlation} attempt=2 recovered at decoy/second.py:29 in secondary_probe`);
    else if (index === 901) lines.push(`2026-09-27T12:00:00Z ERROR correlation=${correlation} attempt=3 terminal failure`);
    else if (index === 902) lines.push(`Traceback correlation=${correlation} attempt=3 at ${task.log_source} in ${task.expected}`);
    else if (index === 1100) lines.push(`INFO correlation=${correlation} replay=ignored after terminal failure`);
    else if (index % 13 === 0) lines.push(`INFO correlation=${correlation} attempt=${index < 600 ? 1 : index < 900 ? 2 : 3} heartbeat worker=${index % 7}`);
    else lines.push(`2026-09-27T12:00:${String(index % 60).padStart(2, '0')}Z ${index % 17 === 0 ? 'ERROR' : 'INFO'} correlation=NOISE-${index % 89} subsystem=${index % 3 === 0 ? 'cache' : 'worker'} attempt=${index % 4} ${index % 17 === 0 ? 'Traceback at decoy/unrelated.py:45 in unrelated_handler' : 'operation complete'}`);
  }
  return lines.join('\n') + '\n';
}

export function selectorProtocol(arm, records) {
  if (arm === 'stock') return records.length === 0;
  if (!records.length) return true;
  return records.every(record => {
    const requested = record.requested_selector;
    const actual = record.used_selector;
    if (requested !== arm || !Number.isInteger(record.candidates)) return false;
    if (arm === 'deterministic') return actual === 'deterministic';
    return record.candidates < 8 ? ['deterministic', 'laya'].includes(actual) :
      actual === 'laya' && !record.fallback;
  });
}

export async function verifyManifest(manifest, repoPaths) {
  if (manifest.schema !== 1 || !Number.isInteger(manifest.seed) || manifest.repetitions !== 3 ||
      JSON.stringify(manifest.protocol.arms) !== JSON.stringify(ARMS)) throw new Error('Invalid protocol');
  const ids = new Set();
  const counts = {};
  for (const task of manifest.tasks) {
    if (ids.has(task.id) || !repoPaths[task.repo] || !['holdout', 'tuning'].includes(task.phase) ||
        !['exact', 'log', 'multi', 'edit'].includes(task.kind)) throw new Error(`Invalid task ${task.id}`);
    ids.add(task.id);
    counts[`${task.phase}:${task.kind}`] = (counts[`${task.phase}:${task.kind}`] || 0) + 1;
    if (task.kind === 'edit') {
      const original = await readFile(`${repoPaths[task.repo]}/${task.changed}`, 'utf8');
      if (original.split(task.mutation.old).length !== 2 || task.mutation.old === task.mutation.new)
        throw new Error(`Mutation is not unique in pinned source: ${task.id}`);
    } else {
      if (!task.citations?.length) throw new Error(`Missing citations: ${task.id}`);
      for (const citation of task.citations) {
        if (citation.startsWith('bench-logs/')) {
          const [path, line] = citation.split(':');
          const correlation = task.prompt.match(/correlation ([A-Z-]+\d+)/)?.[1];
          if (path !== 'bench-logs/incident.log' || !logFixture(task).split('\n')[Number(line) - 1]?.includes(correlation))
            throw new Error(`Invalid generated log citation: ${task.id}`);
          continue;
        }
        const match = citation.match(/^([^:]+):(\d+)$/);
        if (!match || match[1].includes('..')) throw new Error(`Invalid citation: ${citation}`);
        const lines = (await readFile(`${repoPaths[task.repo]}/${match[1]}`, 'utf8')).split('\n');
        if (!lines[Number(match[2]) - 1]?.trim()) throw new Error(`Empty or missing source citation: ${citation}`);
      }
    }
  }
  for (const kind of ['exact', 'log', 'multi', 'edit']) if (counts[`holdout:${kind}`] !== 4)
    throw new Error(`Need four holdout tasks of kind ${kind}`);
  if (manifest.tasks.filter(task => task.phase === 'tuning').length !== 8)
    throw new Error('Need eight separate tuning tasks');
  return counts;
}
