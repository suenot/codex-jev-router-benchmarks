import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const mainRepo = resolve(process.env.CODEX_ROUTER_REPO || join(process.cwd(), '..', 'codex-jev-router'));
const selector = process.argv.includes('--laya') ? 'laya' : 'deterministic';
const requireFromMain = createRequire(join(mainRepo, 'package.json'));
const { Client } = await import(pathToFileURL(requireFromMain.resolve('@modelcontextprotocol/client')).href);
const { StdioClientTransport } = await import(pathToFileURL(requireFromMain.resolve('@modelcontextprotocol/client/stdio')).href);
const temp = await mkdtemp(join(tmpdir(), 'codex-evidence-preflight-'));
const workspace = join(temp, 'workspace');
const auditPath = join(temp, 'selector-audit.jsonl');
const client = new Client({ name: 'evidence-study-preflight', version: '1.0.0' });
try {
  await mkdir(workspace);
  await writeFile(join(workspace, 'trace.log'), Array.from({ length: 24 }, (_, index) =>
    `2026-09-27 ERROR correlation=PRECHECK-${index} receipt mismatch at row ${index}\n` +
    Array.from({ length: 9 }, (_, filler) => `INFO unrelated heartbeat ${index}-${filler}\n`).join('')).join(''));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(mainRepo, 'src', 'evidence-mcp.mjs'), '--root', workspace, '--selector', selector],
    env: { ...process.env, CODEX_EVIDENCE_BENCH_LOG: auditPath,
      CODEX_ROUTER_DECIDER_MODEL: 'typed-decisions',
      CODEX_ROUTER_DECIDER_URL: 'http://127.0.0.1:8000/v1/systemone',
      OPENROUTER_API_KEY: '', TYPESAFE_API_KEY: '', JEV_API_KEY: '' } });
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  if (JSON.stringify(names) !== JSON.stringify(['search_workspace_evidence', 'read_selected_evidence']))
    throw new Error(`Unexpected tools: ${names.join(', ')}`);
  const result = await client.callTool({ name: 'search_workspace_evidence',
    arguments: { query: 'receipt mismatch', kind: 'log' } });
  if (result.isError) throw new Error(result.content?.[0]?.text || 'MCP search failed');
  const records = (await readFile(auditPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const record = records.at(-1);
  if (record.requested_selector !== selector || record.candidates < 8 ||
      record.used_selector !== selector || record.fallback)
    throw new Error(`Selector not healthy: ${JSON.stringify(record)}`);
  if (!result.content?.[0]?.text?.includes(`Selection: ${selector}`))
    throw new Error('MCP response did not confirm selector');
  process.stdout.write(JSON.stringify({ selector, tools: names,
    candidates: record.candidates, returned: record.returned, healthy: true }) + '\n');
} finally {
  await client.close();
  await rm(temp, { recursive: true, force: true });
}
