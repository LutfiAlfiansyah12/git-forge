// Shared HTTP plumbing for the forge: request parsing, JSON replies,
// request ids, pagination links. All replies are JSON, never HTML.
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Req {
  method: string;
  path: string;
  segments: string[];
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  host: string;
  rawBody: Buffer;
  json: unknown;
  jsonError: boolean;
}

export interface Resp {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** Binary body (git): sent verbatim with headers['content-type']. */
  rawBody?: Buffer;
}

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

export function pathOf(req: IncomingMessage): string {
  return parseUrl(req).path;
}

export function queryOf(req: IncomingMessage): URLSearchParams {
  return parseUrl(req).query;
}

/** Parse the request URL once: pathname + query params together. */
export function parseUrl(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const u = new URL(req.url ?? '/', 'http://entry');
    return { path: u.pathname, query: u.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

const MAX_BODY_BYTES = 16 * 1024 * 1024;

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parseJsonBody(raw: Buffer): { json: unknown; jsonError: boolean } {
  if (raw.length === 0) return { json: undefined, jsonError: false };
  try {
    return { json: JSON.parse(raw.toString('utf8')), jsonError: false };
  } catch {
    return { json: undefined, jsonError: true };
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

export function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId() });
  res.end();
}

export function errResp(status: number, message: string): Resp {
  return { status, body: { message } };
}

export function notFound(message = 'Not Found'): Resp {
  return errResp(404, message);
}

/** Paginate a list; returns the page and a Link header value (or ''). */
export function paginate<T>(items: T[], query: URLSearchParams, baseUrl: string): { page: T[]; link: string } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(Math.trunc(perPageRaw), 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  if (page < totalPages) {
    const u = new URL(baseUrl);
    u.searchParams.set('per_page', String(perPage));
    u.searchParams.set('page', String(page + 1));
    links.push(`<${u.toString()}>; rel="next"`);
    const l = new URL(baseUrl);
    l.searchParams.set('per_page', String(perPage));
    l.searchParams.set('page', String(totalPages));
    links.push(`<${l.toString()}>; rel="last"`);
  }
  if (page > 1) {
    const u = new URL(baseUrl);
    u.searchParams.set('per_page', String(perPage));
    u.searchParams.set('page', String(1));
    links.push(`<${u.toString()}>; rel="first"`);
    const p = new URL(baseUrl);
    p.searchParams.set('per_page', String(perPage));
    p.searchParams.set('page', String(page - 1));
    links.push(`<${p.toString()}>; rel="prev"`);
  }
  return { page: pageItems, link: links.join(', ') };
}
