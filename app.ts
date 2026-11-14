// The forge's HTTP server: routing, auth, body parsing, JSON replies.
// main.ts owns the lifecycle (bind, register, poll /done); this file owns the
// surface: git smart HTTP, REST v3, GraphQL v4 and MCP, all on one store.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, type RestCtx } from './rest.ts';
import { handleGit, type GitCtx } from './git.ts';
import { handleGraphql, type GraphqlCtx } from './graphql.ts';
import { handleMcp, type McpCtx } from './mcp.ts';
import {
  pathOf, queryOf, readBody, parseJsonBody, sendJson, sendEmpty, sendRaw, type Req,
} from './http.ts';

export function createApp(): Server {
  const store = new Store();
  const restCtx: RestCtx = { store };
  const gitCtx: GitCtx = { store };
  const graphqlCtx: GraphqlCtx = { store };
  const mcpCtx: McpCtx = { store };
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';

      // The env's boot probe: 200 {"ok":true}, no auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Read the body for methods that carry one.
      let rawBody = Buffer.alloc(0);
      let json: unknown;
      let jsonError = false;
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        try {
          rawBody = await readBody(req);
        } catch {
          sendJson(res, 400, { message: 'Bad Request: could not read request body' });
          return;
        }
        const parsed = parseJsonBody(rawBody);
        json = parsed.json;
        jsonError = parsed.jsonError;
      }

      const segments = path.split('/').filter((s) => s.length > 0);
      const host = req.headers.host ?? 'localhost';

      // Auth: every API surface needs the trial bearer token. A request
      // without it (or with the wrong one) is 401 JSON.
      const isApi = segments[0] === 'api' || segments[0] === 'mcp' || (segments.length >= 2 && segments[1].endsWith('.git'));
      if (isApi) {
        const auth = req.headers.authorization ?? '';
        const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
        const ok = token === '' ? presented !== '' : presented === token;
        if (!ok) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
      }

      const request: Req = {
        method,
        path,
        segments,
        query: queryOf(req),
        headers: req.headers,
        host,
        rawBody,
        json,
        jsonError,
      };

      // REST v3.
      if (segments[0] === 'api' && segments[1] === 'v3') {
        const out = handleRest(restCtx, request);
        if (out !== null) {
          if (out.status === 204) {
            sendEmpty(res, 204);
            return;
          }
          sendJson(res, out.status, out.body, out.headers ?? {});
          return;
        }
      }

      // Git smart HTTP.
      if (segments.length >= 2 && segments[1].endsWith('.git')) {
        const out = handleGit(gitCtx, request);
        if (out !== null) {
          if (out.rawBody !== undefined) {
            sendRaw(res, out.status, out.headers?.['content-type'] ?? 'application/octet-stream', out.rawBody);
            return;
          }
          sendJson(res, out.status, out.body, out.headers ?? {});
          return;
        }
      }

      // GraphQL v4.
      if (segments[0] === 'api' && segments[1] === 'graphql') {
        const out = handleGraphql(graphqlCtx, request);
        if (out !== null) {
          sendJson(res, out.status, out.body, out.headers ?? {});
          return;
        }
      }

      // MCP (JSON-RPC 2.0, Streamable HTTP).
      if (segments[0] === 'mcp') {
        const out = handleMcp(mcpCtx, request);
        if (out !== null) {
          if (out.status === 204 || out.status === 202) {
            sendEmpty(res, out.status);
            return;
          }
          sendJson(res, out.status, out.body, out.headers ?? {});
          return;
        }
      }

      sendJson(res, 404, { message: 'Not Found' });
    })().catch(() => {
      try {
        sendJson(res, 500, { message: 'Internal Server Error' });
      } catch {
        // The socket is gone; nothing left to do.
      }
    });
  });
}
