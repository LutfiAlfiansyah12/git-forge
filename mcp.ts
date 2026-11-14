// MCP endpoint under /mcp: JSON-RPC 2.0 over Streamable HTTP (plain JSON
// answers; the suite's client also accepts SSE, but JSON is enough).
// Modern era (2026-07-28): server/discover, no handshake, no session.
// Legacy era is answered too (initialize + notifications/initialized) so an
// older client still negotiates. All tools act on the same store as REST
// and GraphQL, with identical ids.
import { VIEWER } from './scenario.ts';
import {
  Store, type Repo, type Issue, type PullRequest,
  createIssueRecord, createPullRecord, squashMerge,
} from './store.ts';
import type { Req, Resp } from './http.ts';

export interface McpCtx {
  store: Store;
}

const SERVER_NAME = 'muse-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28'];
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

// -----------------------------------------------------------------------------------------------------------
// Tool definitions (canonical github-mcp-server names; property names are
// the canonical ones so the suite's synonym mapping is exact).
// -----------------------------------------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      name: { type: 'string', description: 'The name of the repository.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the issue.' },
      body: { type: 'string', description: 'The body of the issue.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      state: { type: 'string', description: 'The state filter: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the pull request.' },
      body: { type: 'string', description: 'The body of the pull request.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsListJson(): Record<string, unknown>[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: 'object', properties: t.properties, required: t.required },
  }));
}

// -----------------------------------------------------------------------------------------------------------
// JSON shapes (mirroring the REST surface's objects, minus URLs).
// -----------------------------------------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.gid,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_pull_requests: true,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.gid,
    node_id: issue.gid,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
  };
}

function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.gid,
    node_id: pr.gid,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeSha,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
  };
}

// -----------------------------------------------------------------------------------------------------------
// Tool execution
// -----------------------------------------------------------------------------------------------------------

type ToolResult =
  | { ok: true; value: Record<string, unknown> | Record<string, unknown>[] }
  | { ok: false; message: string };

function findRepo(ctx: McpCtx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function toolError(message: string): ToolResult {
  return { ok: false, message };
}

function runTool(ctx: McpCtx, name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name);
      if (!repoName) return toolError('create_repo: "name" is required');
      if (ctx.store.getRepo(VIEWER.login, repoName)) return toolError(`create_repo: repository ${VIEWER.login}/${repoName} already exists`);
      const repo = ctx.store.createRepo(VIEWER.login, repoName, args.private !== false, str(args.description));
      return { ok: true, value: repoJson(repo) };
    }
    case 'get_repo': {
      const repo = findRepo(ctx, str(args.owner), str(args.repo));
      if (!repo) return toolError(`get_repo: repository ${str(args.owner)}/${str(args.repo)} not found`);
      return { ok: true, value: repoJson(repo) };
    }
    case 'create_issue': {
      const repo = findRepo(ctx, str(args.owner), str(args.repo));
      if (!repo) return toolError(`create_issue: repository ${str(args.owner)}/${str(args.repo)} not found`);
      const issue = createIssueRecord(repo, str(args.title), str(args.body));
      return { ok: true, value: issueJson(repo, issue) };
    }
    case 'list_issues': {
      const repo = findRepo(ctx, str(args.owner), str(args.repo));
      if (!repo) return toolError(`list_issues: repository ${str(args.owner)}/${str(args.repo)} not found`);
      const state = str(args.state, 'open') || 'open';
      let list = repo.issues.slice();
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => b.seq - a.seq);
      return { ok: true, value: list.map((i) => issueJson(repo, i)) };
    }
    case 'create_pull_request': {
      const repo = findRepo(ctx, str(args.owner), str(args.repo));
      if (!repo) return toolError(`create_pull_request: repository ${str(args.owner)}/${str(args.repo)} not found`);
      const pr = createPullRecord(repo, str(args.head), str(args.base), str(args.title), str(args.body));
      if (!pr) return toolError(`create_pull_request: head or base branch does not exist`);
      return { ok: true, value: pullJson(repo, pr) };
    }
    case 'merge_pull_request': {
      const repo = findRepo(ctx, str(args.owner), str(args.repo));
      if (!repo) return toolError(`merge_pull_request: repository ${str(args.owner)}/${str(args.repo)} not found`);
      const num = typeof args.pull_number === 'number' ? args.pull_number : Number(str(args.pull_number));
      const pr = repo.pulls.find((p) => p.number === num);
      if (!pr) return toolError(`merge_pull_request: pull request #${num} not found`);
      const out = squashMerge(repo, pr);
      if (!out.ok) return toolError(`merge_pull_request: cannot merge pull request #${num}: ${out.reason}`);
      return { ok: true, value: { ...pullJson(repo, pr), sha: out.sha } };
    }
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

// -----------------------------------------------------------------------------------------------------------
// JSON-RPC dispatch
// -----------------------------------------------------------------------------------------------------------

function rpcResult(id: unknown, result: unknown): Resp {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): Resp {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

const SERVER_INFO = { name: SERVER_NAME, version: SERVER_VERSION };

export function handleMcp(ctx: McpCtx, req: Req): Resp | null {
  const seg = req.segments;
  if (seg[0] !== 'mcp') return null;

  // A legacy session close: nothing is held, so it always succeeds.
  if (req.method === 'DELETE') return { status: 204, body: null };
  if (req.method !== 'POST') return { status: 405, body: { message: 'Method Not Allowed' } };

  // A body that is not JSON is a JSON-RPC parse error (HTTP 400, modern era).
  if (req.jsonError || req.rawBody.length === 0) {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  const body: unknown = req.json;
  if (!isObj(body) || typeof body.method !== 'string') {
    return rpcError(isObj(body) ? (body.id ?? null) : null, -32600, 'Invalid Request');
  }
  const id: unknown = 'id' in body ? body.id : undefined;
  const isNotification = id === undefined;
  const method = body.method;
  const params = isObj(body.params) ? body.params : {};

  // Notifications get no JSON-RPC answer.
  if (isNotification) return { status: 202, body: null };

  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        protocolVersion: '2026-07-28',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    }
    case 'initialize': {
      const offered = str(params.protocolVersion);
      const negotiated = LEGACY_REVISIONS.includes(offered) ? offered : SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping': {
      return rpcResult(id, {});
    }
    case 'tools/list': {
      return rpcResult(id, { tools: toolsListJson() });
    }
    case 'tools/call': {
      const name = str(params.name);
      const args = isObj(params.arguments) ? params.arguments : {};
      const def = TOOLS.find((t) => t.name === name);
      if (!def) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const missing = def.required.filter((prop) => args[prop] === undefined || args[prop] === null || args[prop] === '');
      if (missing.length > 0) {
        return rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
      }
      const out = runTool(ctx, name, args);
      if (!out.ok) {
        return rpcResult(id, {
          content: [{ type: 'text', text: out.message }],
          isError: true,
        });
      }
      const text = JSON.stringify(out.value);
      const structured = Array.isArray(out.value) ? { issues: out.value } : out.value;
      return rpcResult(id, {
        content: [{ type: 'text', text }],
        structuredContent: structured,
      });
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
