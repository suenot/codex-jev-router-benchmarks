import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ARMS, armOrder, costUsd, logFixture, readGrade, scheduleFor, selectorProtocol } from '../scripts/evidence-lib.mjs';

const manifest = JSON.parse(await readFile(new URL('../benchmarks/evidence-mcp-2026-09-27/manifest.json', import.meta.url)));

test('preregistered holdout has four tasks per kind and tuning tasks are separate', () => {
  const holdout = manifest.tasks.filter(task => task.phase === 'holdout');
  const tuning = manifest.tasks.filter(task => task.phase === 'tuning');
  assert.equal(holdout.length, 16);
  assert.equal(tuning.length, 8);
  assert.equal(new Set(manifest.tasks.map(task => task.id)).size, 24);
  for (const kind of ['exact', 'log', 'multi', 'edit']) assert.equal(holdout.filter(task => task.kind === kind).length, 4);
  assert.equal(new Set(holdout.map(task => task.repo)).size, 2);
});

test('schedule rotates three arms without losing a paired run', () => {
  const tasks = manifest.tasks.filter(task => task.phase === 'holdout');
  const schedule = scheduleFor(tasks, 3, manifest.seed);
  assert.equal(schedule.length, 48);
  assert.equal(schedule.reduce((count, block) => count + block.order.length, 0), 144);
  for (const block of schedule) {
    assert.deepEqual([...block.order].sort(), [...ARMS].sort());
    assert.deepEqual(block.order, armOrder(block.task, block.repetition, manifest.seed));
  }
  assert.notDeepEqual(schedule[0].order, schedule[16].order);
});

test('money calculation separates uncached, cached, writes, and outputs', () => {
  assert.equal(costUsd('gpt-6-sol', { input_tokens: 1000, cached_input_tokens: 400,
    cache_write_input_tokens: 100, output_tokens: 200 }), (500 * 2 + 400 * 0.2 + 100 * 2.5 + 200 * 10) / 1_000_000);
  assert.equal(costUsd('gpt-6-sol', { input_tokens: 10, cached_input_tokens: 11, output_tokens: 1 }), null);
  assert.equal(costUsd('gpt-6-sol', { input_tokens: 10, cached_input_tokens: 5,
    cache_write_input_tokens: 6, output_tokens: 1 }), null);
  assert.equal(costUsd('gpt-6-sol', { input_tokens: 272_001, cached_input_tokens: 0,
    output_tokens: 1 }), null);
  assert.equal(costUsd('unknown', { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 }), null);
});

test('strict read grade checks answer and all source citations', () => {
  const task = manifest.tasks.find(item => item.id === 'dj-random-storage-suffix');
  assert.equal(readGrade(task, JSON.stringify({ value: task.expected, citations: task.citations })).correct, true);
  assert.equal(readGrade(task, JSON.stringify({ value: 'django.utils.crypto.get_random_string', citations: task.citations })).correct, true);
  assert.equal(readGrade(task, JSON.stringify({ value: task.expected, citations: [task.citations[0]] })).correct, false);
  assert.equal(readGrade(task, JSON.stringify({ value: 'wrong', citations: task.citations })).correct, false);
});

test('log grade accepts either recoverable-attempt evidence, plus the terminal frame', () => {
  const task = manifest.tasks.find(item => item.id === 'dj-signing-incident');
  const citations = [...task.citations, 'bench-logs/incident.log:360', 'bench-logs/incident.log:730'];
  assert.equal(readGrade(task, JSON.stringify({ value: task.expected, citations })).correct, true);
  assert.equal(readGrade(task, JSON.stringify({ value: task.expected,
    citations: citations.filter(value => value !== 'bench-logs/incident.log:730') })).correct, false);
  assert.equal(readGrade(task, JSON.stringify({ value: task.expected,
    citations: citations.filter(value => value !== 'bench-logs/incident.log:902') })).correct, false);
});

test('incident fixture has a fixed target line surrounded by noisy errors', () => {
  const task = manifest.tasks.find(item => item.id === 'pt-collect-report-incident');
  const lines = logFixture(task).trimEnd().split('\n');
  assert.equal(lines.length, 1200);
  assert.match(lines[619], /PT-REPORT-841.*attempt=2.*retry scheduled/);
  assert.match(lines[900], /PT-REPORT-841.*attempt=3 terminal failure/);
  assert.match(lines[901], /PT-REPORT-841.*pytest_make_collect_report/);
  assert.ok(lines.filter(line => line.includes('PT-REPORT-841')).length > 80);
  assert.ok(lines.filter(line => line.includes('ERROR')).length > 50);
});

test('Laya fallbacks and missing audit records cannot masquerade as local model use', () => {
  const good = { requested_selector: 'laya', used_selector: 'laya', fallback: null, candidates: 12 };
  assert.equal(selectorProtocol('laya', [good]), true);
  assert.equal(selectorProtocol('laya', [{ ...good, used_selector: 'deterministic', fallback: 'timeout' }]), false);
  assert.equal(selectorProtocol('laya', [{ ...good, candidates: 3, used_selector: 'deterministic', fallback: 'too_few_candidates' }]), true);
  assert.equal(selectorProtocol('laya', []), true);
  assert.equal(selectorProtocol('stock', []), true);
  assert.equal(selectorProtocol('stock', [good]), false);
});
