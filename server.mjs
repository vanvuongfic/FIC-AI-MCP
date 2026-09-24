import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as z from 'zod/v4';

const BASE = 'https://win-house.timxe247.com';
const upstreamSecret = process.env.FIC_AI_SECRET;
const clientToken = process.env.MCP_CLIENT_TOKEN;
const host = process.env.MCP_HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3000);
const allowedHost = process.env.MCP_ALLOWED_HOST;
const githubToken = process.env.GITHUB_TOKEN;
const githubRepo = 'vanvuongfic/FIC-POS';
const githubApi = 'https://api.github.com';
const mountPath = (process.env.MCP_MOUNT_PATH || '/fic-ai-mcp').replace(/\/$/, '');
const execFileAsync = promisify(execFile);
const testDeployHelper = '/home/timxerzf/.fic-ai-test-actions/deploy-test.sh';

if (!upstreamSecret || !clientToken || !allowedHost || !githubToken) {
  throw new Error('Set FIC_AI_SECRET, MCP_CLIENT_TOKEN, MCP_ALLOWED_HOST and GITHUB_TOKEN');
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
async function github(path, params = {}) {
  const url = new URL(path, githubApi);
  appendQuery(url, params);
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    headers: {
      Authorization: 'Bearer ' + githubToken,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'fic-ai-test-mcp'
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('GitHub API HTTP ' + response.status);
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 1000000) throw new Error('Response exceeds 1 MB');
  return scrub(JSON.parse(raw));
}
function checkedGitRef(ref) {
  const value = ref || 'develop';
  if (!['develop', 'test/main'].includes(value)) throw new Error('GitHub ref not allowed');
  return value;
}
function checkedGitPath(path) {
  const value = String(path || '').replace(/^\/+/, '');
  if (!value || value.includes('..') || value.length > 500) throw new Error('Invalid GitHub path');
  return value;
}
async function githubReadFile(path, ref) {
  const safePath = checkedGitPath(path);
  const safeRef = checkedGitRef(ref);
  const data = await github('/repos/' + githubRepo + '/contents/' + safePath.split('/').map(encodeURIComponent).join('/'), { ref: safeRef });
  if (data.type !== 'file' || !data.content) throw new Error('GitHub path is not a file');
  const content = Buffer.from(String(data.content).replace(/\n/g, ''), 'base64').toString('utf8');
  return scrub({ repository: githubRepo, ref: safeRef, path: safePath, sha: data.sha, content });
}
async function githubSearchCode(query) {
  const q = String(query || '').trim();
  if (!q || q.length > 200) throw new Error('Invalid GitHub query');
  const data = await github('/search/code', { q: q + ' repo:' + githubRepo });
  const items = Array.isArray(data.items) ? data.items.slice(0, 20) : [];
  return scrub({
    repository: githubRepo,
    note: 'Search locates source paths; use github_read_file with ref develop or test/main for exact branch content.',
    items: items.map(item => ({ name: item.name, path: item.path, sha: item.sha, html_url: item.html_url }))
  });
}
async function hostingAction(action) {
  if (!['status', 'pull', 'clear-cache', 'deploy'].includes(action)) throw new Error('Hosting action not allowed');
  const { stdout, stderr } = await execFileAsync(testDeployHelper, [action], {
    timeout: 60000,
    maxBuffer: 1024 * 1024,
    env: process.env
  });
  return scrub({ action, stdout, stderr });
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
  const server = new McpServer({ name: 'fic-ai-test', version: '0.3.0' });
  server.registerTool('hosting_status', {
    description: 'Read FIC POS Hosting TEST git branch, HEAD and working-tree status. TEST only.',
    inputSchema: empty
  }, tool(() => hostingAction('status')));
  server.registerTool('hosting_pull_test', {
    description: 'Fast-forward pull origin test/main on FIC POS Hosting TEST. Refuses wrong branch or local changes.',
    inputSchema: empty
  }, tool(() => hostingAction('pull')));
  server.registerTool('hosting_clear_cache', {
    description: 'Run php artisan optimize:clear on FIC POS Hosting TEST only.',
    inputSchema: empty
  }, tool(() => hostingAction('clear-cache')));
  server.registerTool('hosting_deploy_test', {
    description: 'Safely deploy FIC POS Hosting TEST: require clean test/main, ff-only pull, then php artisan optimize:clear.',
    inputSchema: empty
  }, tool(() => hostingAction('deploy')));
  server.registerTool('github_read_file', {
    description: 'Read one source file from vanvuongfic/FIC-POS. Read-only. Allowed refs: develop and test/main.',
    inputSchema: z.object({
      path: z.string().min(1).max(500),
      ref: z.enum(['develop', 'test/main']).optional()
    })
  }, tool(({ path, ref }) => githubReadFile(path, ref)));
  server.registerTool('github_search_code', {
    description: 'Search source paths in vanvuongfic/FIC-POS using GitHub code search. Read-only.',
    inputSchema: z.object({ query: z.string().min(1).max(200) })
  }, tool(({ query }) => githubSearchCode(query)));
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
const nodeHandler = toNodeHandler(handler);

// cPanel/LiteSpeed Passenger may preserve the public application prefix in req.url.
// Match by safe path suffix so the same app works both directly and under /fic-ai-mcp.
app.use((req, res, next) => {
  const pathname = (req.path || '').replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && pathname.endsWith('/healthz')) {
    return res.json({ ok: true, service: 'fic-ai-test-mcp' });
  }

  if (pathname.endsWith('/mcp')) {
    const header = req.get('authorization') || '';
    if (!header.startsWith('Bearer ') || !equalToken(header.slice(7), clientToken)) {
      return res.sendStatus(401);
    }
    return void nodeHandler(req, res, req.body);
  }

  next();
});

app.listen(port, host, () => process.stdout.write('FIC AI TEST MCP listening on ' + host + ':' + port + '\n'));
