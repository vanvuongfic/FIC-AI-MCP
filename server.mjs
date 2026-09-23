import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { timingSafeEqual } from 'node:crypto';
import * as z from 'zod/v4';

const BASE = 'https://win-house.timxe247.com';
const upstreamSecret = process.env.FIC_AI_SECRET;
const clientToken = process.env.MCP_CLIENT_TOKEN;
const host = process.env.MCP_HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3000);
const allowedHost = process.env.MCP_ALLOWED_HOST;

if (!upstreamSecret || !clientToken || !allowedHost) {
  throw new Error('Set FIC_AI_SECRET, MCP_CLIENT_TOKEN and MCP_ALLOWED_HOST');
}
if (clientToken === upstreamSecret) throw new Error('Use separate MCP and upstream credentials');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');

const tablePattern = /^[A-Za-z0-9_]{1,64}$/;
const columnPattern = /^[A-Za-z0-9_]{1,100}$/;
const secretName = /password|passwd|pwd|secret|token|authorization|api[_-]?key|cookie|session|private[_-]?key|client[_-]?secret|credential|otp|pin|hash/i;
const secretValue = /(?:bearer\s+\S+|(?:password|secret|token|api[_-]?key|authorization)\s*[:=]\s*\S+|-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----)/gi;

function scrub(value, depth = 0) {
  if (depth > 16) return '[truncated]';
  if (typeof value === 'string') return value.replace(secretValue, '[REDACTED]').slice(0, 12000);
  if (Array.isArray(value)) return value.slice(0, 100).map(v => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([k, v]) => [
      k, secretName.test(k) ? '[REDACTED]' : scrub(v, depth + 1)
    ]));
  }
  return value;
}
function equalToken(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function appendQuery(url, params) {
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key + '[]', String(item));
    } else if (value && typeof value === 'object') {
      for (const [subKey, subValue] of Object.entries(value)) {
        url.searchParams.append(key + '[' + subKey + ']', String(subValue));
      }
    } else if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
}
async function upstream(path, params = {}) {
  const url = new URL(path, BASE);
  appendQuery(url, params);
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    headers: { 'X-FIC-AI-Secret': upstreamSecret, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('TEST API HTTP ' + response.status);
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 1000000) throw new Error('Response exceeds 1 MB');
  return scrub(JSON.parse(raw));
}
async function allowedTables() {
  const data = await upstream('/api/internal/fic-ai/tables');
  return new Set(Array.isArray(data.tables) ? data.tables : []);
}
async function checkedTable(table) {
  if (!tablePattern.test(table)) throw new Error('Invalid table');
  const tables = await allowedTables();
  if (!tables.has(table)) throw new Error('Table not allowed by TEST API');
  return encodeURIComponent(table);
}
function tool(fn) {
  return async args => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await fn(args)) }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: 'text', text: ['Response exceeds 1 MB', 'Invalid table', 'Table not allowed by TEST API'].includes(e.message) ? e.message : 'TEST diagnostic request failed.' }]
      };
    }
  };
}

const empty = z.object({});
const tableArg = z.object({ table: z.string().regex(tablePattern) });
const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'fic-ai-test', version: '0.2.0' });
  server.registerTool('health', { description: 'Read FIC POS TEST health', inputSchema: empty }, tool(() => upstream('/api/internal/fic-ai/health')));
  server.registerTool('runtime', { description: 'Read sanitized FIC POS TEST runtime information', inputSchema: empty }, tool(() => upstream('/api/internal/fic-ai/runtime')));
  server.registerTool('latest_errors', {
    description: 'Read 1-20 latest sanitized Laravel TEST errors',
    inputSchema: z.object({ limit: z.number().int().min(1).max(20).optional() })
  }, tool(({ limit }) => upstream('/api/internal/fic-ai/errors/latest', limit === undefined ? {} : { limit })));
  server.registerTool('tables', { description: 'List tables exposed by the TEST read-only API', inputSchema: empty }, tool(() => upstream('/api/internal/fic-ai/tables')));
  server.registerTool('schema', { description: 'Inspect schema of a TEST table exposed by the API', inputSchema: tableArg }, tool(async ({ table }) => upstream('/api/internal/fic-ai/schema/' + await checkedTable(table))));
  server.registerTool('rows', {
    description: 'Read TEST table rows using the REST API supported columns, where and limit parameters',
    inputSchema: z.object({
      table: z.string().regex(tablePattern),
      columns: z.array(z.string().regex(columnPattern)).max(80).optional(),
      where: z.record(z.string().regex(columnPattern), z.union([
        z.string().max(500), z.number(), z.boolean(), z.null(),
        z.array(z.union([z.string().max(500), z.number(), z.boolean()])).max(50)
      ])).optional(),
      limit: z.number().int().min(1).max(100).optional()
    })
  }, tool(async ({ table, columns, where, limit }) => {
    const safe = await checkedTable(table);
    return upstream('/api/internal/fic-ai/rows/' + safe, {
      ...(columns ? { columns } : {}),
      ...(where ? { where } : {}),
      ...(limit !== undefined ? { limit } : {})
    });
  }));
  return server;
});

const app = createMcpExpressApp({ host, allowedHosts: [allowedHost] });
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'fic-ai-test-mcp' }));
app.use('/mcp', (req, res, next) => {
  const header = req.get('authorization') || '';
  if (!header.startsWith('Bearer ') || !equalToken(header.slice(7), clientToken)) return res.sendStatus(401);
  next();
});
const nodeHandler = toNodeHandler(handler);
app.all('/mcp', (req, res) => void nodeHandler(req, res, req.body));
app.listen(port, host, () => process.stdout.write('FIC AI TEST MCP listening on ' + host + ':' + port + '\n'));
