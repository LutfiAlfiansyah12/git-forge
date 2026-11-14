// REST v3 under /api/v3: repositories, branches, commits, contents, labels,
// issues, comments, pull requests, merges. Auth is enforced by app.ts.
import { VIEWER, EPOCH_SEC } from './scenario.ts';
import {
  Store, type Repo, type Issue, type PullRequest,
  commitFiles, filesAt, commitChain, commitOf, diffFiles, lineDiff,
  mergeBase, isAncestor, globalId, isoFromEpoch, squashMerge,
} from './store.ts';
import { errResp, notFound, paginate, type Req, type Resp } from './http.ts';

export interface RestCtx {
  store: Store;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function repoUrl(req: Req, owner: string, name: string): string {
  return `http://${req.host}/api/v3/repos/${owner}/${name}`;
}

function repoJson(req: Req, repo: Repo): Record<string, unknown> {
  const createdAt = isoFromEpoch(EPOCH_SEC + repo.seq);
  return {
    id: repo.id,
    node_id: repo.gid,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `http://${req.host}/${repo.owner}/${repo.name}`,
    url: repoUrl(req, repo.owner, repo.name),
    created_at: createdAt,
    updated_at: createdAt,
    fork: false,
    has_issues: true,
    has_pull_requests: true,
  };
}

function issueJson(req: Req, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.gid,
    node_id: issue.gid,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    url: `${repoUrl(req, repo.owner, repo.name)}/issues/${issue.number}`,
    html_url: `http://${req.host}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
  };
}

function pullJson(req: Req, repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.gid,
    node_id: pr.gid,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}`, user: { login: repo.owner, id: VIEWER.id } },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}`, user: { login: repo.owner, id: VIEWER.id } },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeSha,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    url: `${repoUrl(req, repo.owner, repo.name)}/pulls/${pr.number}`,
    html_url: `http://${req.host}/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

/** The repo, or null (caller answers 404). Only the viewer's repos exist. */
function findRepo(ctx: RestCtx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

export function handleRest(ctx: RestCtx, req: Req): Resp | null {
  const seg = req.segments;
  if (seg[0] !== 'api' || seg[1] !== 'v3') return null;
  const rest = seg.slice(2);
  const method = req.method;
  const body: Record<string, unknown> = isObj(req.json) ? req.json : {};

  // GET /api/v3/ — API root.
  if (rest.length === 0) {
    if (method !== 'GET') return errResp(405, 'Method Not Allowed');
    return {
      status: 200,
      body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return errResp(405, 'Method Not Allowed');
    return { status: 200, body: { installed_version: '1.0.0' } };
  }

  // /api/v3/user...
  if (rest[0] === 'user') {
    if (rest.length === 1 && method === 'GET') {
      return { status: 200, body: { login: VIEWER.login, id: VIEWER.id, type: 'User', name: VIEWER.name, email: VIEWER.email } };
    }
    if (rest.length === 2 && rest[1] === 'repos') {
      if (method === 'GET') {
        const all = ctx.store.reposOf(VIEWER.login).map((r) => repoJson(req, r));
        const base = `http://${req.host}/api/v3/user/repos`;
        const { page, link } = paginate(all, req.query, base);
        const headers: Record<string, string> = {};
        if (link) headers.link = link;
        return { status: 200, body: page, headers };
      }
      if (method === 'POST') {
        if (req.jsonError) return errResp(400, 'Bad Request: malformed JSON');
        const name = str(body.name);
        if (!name) return errResp(422, 'Validation Failed: name is required');
        if (ctx.store.getRepo(VIEWER.login, name)) return errResp(422, 'Validation Failed: repository already exists');
        const repo = ctx.store.createRepo(VIEWER.login, name, body.private !== false, str(body.description));
        return { status: 201, body: repoJson(req, repo) };
      }
      return errResp(405, 'Method Not Allowed');
    }
    return notFound();
  }

  // /api/v3/repos/{owner}/{repo}[/...]
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = decodeURIComponent(rest[1]);
    const name = decodeURIComponent(rest[2]);
    const repo = findRepo(ctx, owner, name);
    const tail = rest.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') {
        if (!repo) return notFound('Not Found');
        return { status: 200, body: repoJson(req, repo) };
      }
      if (method === 'PATCH') {
        if (!repo) return notFound('Not Found');
        if (req.jsonError) return errResp(400, 'Bad Request: malformed JSON');
        if (typeof body.description === 'string') repo.description = body.description;
        return { status: 200, body: repoJson(req, repo) };
      }
      if (method === 'DELETE') {
        if (!repo) return notFound('Not Found');
        ctx.store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return errResp(405, 'Method Not Allowed');
    }

    if (!repo) return notFound('Not Found');

    // branches
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const out: Record<string, unknown>[] = [];
        for (const [ref, sha] of [...repo.refs.entries()].sort()) {
          if (!ref.startsWith('refs/heads/')) continue;
          out.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
        }
        return { status: 200, body: out };
      }
      if (tail.length >= 2 && method === 'GET') {
        const branch = tail.slice(1).map(decodeURIComponent).join('/');
        const sha = branchTip(repo, branch);
        if (!sha) return notFound('Not Found');
        return { status: 200, body: { name: branch, commit: { sha }, protected: false } };
      }
      return errResp(405, 'Method Not Allowed');
    }

    // git/refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        if (req.jsonError) return errResp(400, 'Bad Request: malformed JSON');
        const ref = str(body.ref);
        const sha = str(body.sha).toLowerCase();
        if (!ref.startsWith('refs/')) return errResp(422, 'Validation Failed: ref must start with refs/');
        if (!/^[0-9a-f]{40}$/.test(sha)) return errResp(422, 'Validation Failed: sha must be a 40-hex string');
        if (repo.refs.has(ref)) return errResp(422, 'Validation Failed: ref already exists');
        repo.refs.set(ref, sha);
        return { status: 201, body: { ref, object: { sha, type: 'commit' } } };
      }
      if (method === 'GET') {
        if (tail.length === 2) {
          const out: Record<string, unknown>[] = [];
          for (const [ref, sha] of [...repo.refs.entries()].sort()) out.push({ ref, object: { sha, type: 'commit' } });
          return { status: 200, body: out };
        }
        const ref = tail.slice(2).map(decodeURIComponent).join('/');
        const sha = repo.refs.get(ref);
        if (!sha) return notFound('Not Found');
        return { status: 200, body: { ref, object: { sha, type: 'commit' } } };
      }
      return errResp(405, 'Method Not Allowed');
    }

    // commits
    if (tail[0] === 'commits') {
      if (method === 'GET' && tail.length === 1) {
        const branch = req.query.get('sha') ?? repo.defaultBranch;
        const tip = branchTip(repo, branch) ?? (repo.refs.get(branch) as string | undefined);
        if (!tip) return notFound('Not Found');
        const out: Record<string, unknown>[] = [];
        for (const sha of commitChain(repo, tip)) {
          const info = commitOf(repo, sha);
          out.push({ sha, commit: { message: info?.message ?? '' } });
        }
        return { status: 200, body: out };
      }
      return errResp(405, 'Method Not Allowed');
    }

    // contents
    if (tail[0] === 'contents') {
      const contentPath = tail.slice(1).map(decodeURIComponent).join('/');
      if (method === 'PUT') {
        if (req.jsonError) return errResp(400, 'Bad Request: malformed JSON');
        const message = str(body.message, 'Update');
        const contentB64 = str(body.content);
        if (!contentB64) return errResp(422, 'Validation Failed: content is required');
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return errResp(400, 'Bad Request: content is not valid base64');
        }
        const branch = str(body.branch, repo.defaultBranch) || repo.defaultBranch;
        const ref = `refs/heads/${branch}`;
        const tip = repo.refs.get(ref);
        const files = tip ? filesAt(repo, tip) : new Map();
        const existing = files.get(contentPath);
        const givenSha = str(body.sha).toLowerCase();
        if (existing) {
          if (!givenSha) return errResp(409, 'Conflict: file already exists');
          if (givenSha !== existing.sha) return errResp(409, 'Conflict: sha does not match the current blob');
        } else if (givenSha) {
          return errResp(409, 'Conflict: sha does not match the current blob');
        }
        const changes = new Map<string, Buffer | null>([[contentPath, content]]);
        const commitSha = commitFiles(repo, branch, changes, message);
        const blobSha = filesAt(repo, commitSha).get(contentPath)?.sha ?? '';
        const status = existing ? 200 : 201;
        return {
          status,
          body: {
            content: {
              name: contentPath.split('/').pop(),
              path: contentPath,
              sha: blobSha,
              size: content.length,
              type: 'file',
              encoding: 'base64',
              url: `${repoUrl(req, owner, name)}/contents/${contentPath}`,
            },
            commit: { sha: commitSha, message },
          },
        };
      }
      if (method === 'GET') {
        const refParam = req.query.get('ref');
        let tip: string | undefined;
        if (refParam) {
          tip = repo.refs.get(`refs/heads/${refParam}`) ?? (repo.refs.get(refParam) as string | undefined) ?? (/^[0-9a-f]{40}$/i.test(refParam) ? refParam.toLowerCase() : undefined);
        } else {
          tip = branchTip(repo, repo.defaultBranch);
        }
        if (!tip) return notFound('Not Found');
        const files = filesAt(repo, tip);
        const direct = files.get(contentPath);
        if (direct) {
          const obj = repo.objects.get(direct.sha);
          const raw = obj?.data ?? Buffer.alloc(0);
          return {
            status: 200,
            body: {
              type: 'file',
              encoding: 'base64',
              size: raw.length,
              name: contentPath.split('/').pop(),
              path: contentPath,
              content: raw.toString('base64'),
              sha: direct.sha,
              url: `${repoUrl(req, owner, name)}/contents/${contentPath}`,
            },
          };
        }
        // Directory listing: immediate children of contentPath.
        const prefix = contentPath ? `${contentPath}/` : '';
        const children = new Map<string, { type: string; sha: string; path: string }>();
        for (const [p, v] of files) {
          if (!p.startsWith(prefix)) continue;
          const rest2 = p.slice(prefix.length);
          const slash = rest2.indexOf('/');
          if (slash === -1) {
            children.set(rest2, { type: 'file', sha: v.sha, path: p });
          } else {
            const dir = rest2.slice(0, slash);
            if (!children.has(dir)) children.set(dir, { type: 'dir', sha: '', path: `${prefix}${dir}` });
          }
        }
        if (children.size === 0) return notFound('Not Found');
        const out: Record<string, unknown>[] = [];
        for (const [name, c] of [...children.entries()].sort()) {
          out.push({ type: c.type, name, path: c.path, sha: c.sha || undefined, size: c.type === 'file' ? (repo.objects.get(c.sha)?.data.length ?? 0) : undefined });
        }
        return { status: 200, body: out };
      }
      if (method === 'DELETE') {
        if (req.jsonError) return errResp(400, 'Bad Request: malformed JSON');
        const branch = str(body.branch, repo.defaultBranch) || repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) return notFound('Not Found');
        const files = filesAt(repo, tip);
        const existing = files.get(contentPath);
        if (!existing) return notFound('Not Found');
        const givenSha = str(body.sha).toLowerCase();
        if (givenSha && givenSha !== existing.sha) return errResp(409, 'Conflict: sha does not match the current blob');
        const message = str(body.message, 'Delete');
        const changes = new Map<string, Buffer | null>([[contentPath, null]]);
        const commitSha = commitFiles(repo, branch, changes, message);
        return { status: 200, body: { commit: { sha: commitSha, message } } };
      }
      return errResp(405, 'Method Not Allowed');
    }

    // labels
    if (tail[0] === 'labels') {
      if (method === 'POST' && tail.length === 1) {
        if (req.jsonError) return errResp(400, 'Bad Request: malformed JSON');
        const name = str(body.name);
        if (!name) return errResp(422, 'Validation Failed: name is required');
        const color = str(body.color, 'ededed');
        repo.labels.set(name, { name, color, description: str(body.description) });
        return { status: 201, body: { name, color, description: str(body.description) } };
      }
      if (method === 'GET' && tail.length === 1) {
        return { status: 200, body: [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description })) };
      }
      return errResp(405, 'Method Not Allowed');
    }

    // issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          if (req.jsonError) return errResp(400, 'Bad Request: malformed JSON');
          const labelsRaw: unknown[] = Array.isArray(body.labels) ? body.labels : [];
          const labelNames: string[] = [];
          for (const l of labelsRaw) {
            const name = typeof l === 'string' ? l : isObj(l) ? str(l.name) : '';
            if (name && !repo.labels.has(name)) return errResp(422, `Validation Failed: label "${name}" does not exist`);
            if (name) labelNames.push(name);
          }
          repo.numberCounter += 1;
          const number = repo.numberCounter;
          const now = isoFromEpoch(EPOCH_SEC + repo.seq + number);
          const issue: Issue = {
            number,
            gid: globalId('I', `${owner}/${name}#${number}`),
            title: str(body.title),
            body: str(body.body),
            state: 'open',
            labels: labelNames,
            comments: [],
            seq: repo.numberCounter,
            createdAt: now,
            updatedAt: now,
          };
          issue.seq = repo.numberCounter;
          repo.issues.push(issue);
          return { status: 201, body: issueJson(req, repo, issue) };
        }
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          let list = repo.issues.slice();
          if (state !== 'all') list = list.filter((i) => i.state === state);
          const sort = req.query.get('sort') ?? 'created';
          const dir = req.query.get('direction') ?? 'desc';
          if (sort === 'created') {
            list.sort((a, b) => (dir === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          const base = `http://${req.host}/api/v3/repos/${owner}/${name}/issues`;
          const { page, link } = paginate(list.map((i) => issueJson(req, repo, i)), req.query, base);
          const headers: Record<string, string> = {};
          if (link) headers.link = link;
          return { status: 200, body: page, headers };
        }
        return errResp(405, 'Method Not Allowed');
      }
      const num = Number(tail[1]);
      if (!Number.isInteger(num) || num < 1) return notFound('Not Found');
      const issue = repo.issues.find((i) => i.number === num);
      if (tail.length === 2) {
        if (method === 'GET') {
          if (!issue) return notFound('Not Found');
          return { status: 200, body: issueJson(req, repo, issue) };
        }
        if (method === 'PATCH') {
          if (!issue) return notFound('Not Found');
          if (req.jsonError) return errResp(400, 'Bad Request: malformed JSON');
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          issue.updatedAt = isoFromEpoch(EPOCH_SEC + repo.seq + issue.number);
          return { status: 200, body: issueJson(req, repo, issue) };
        }
        return errResp(405, 'Method Not Allowed');
      }
      if (tail[2] === 'comments') {
        if (!issue) return notFound('Not Found');
        if (method === 'POST') {
          if (req.jsonError) return errResp(400, 'Bad Request: malformed JSON');
          repo.commentCounter += 1;
          const comment = {
            id: repo.commentCounter,
            gid: globalId('C', `${owner}/${name}#${num}/c${repo.commentCounter}`),
            body: str(body.body),
            seq: repo.commentCounter,
          };
          issue.comments.push(comment);
          return { status: 201, body: { id: comment.id, node_id: comment.gid, body: comment.body } };
        }
        if (method === 'GET') {
          return { status: 200, body: issue.comments.map((c) => ({ id: c.id, node_id: c.gid, body: c.body })) };
        }
        return errResp(405, 'Method Not Allowed');
      }
      return notFound();
    }

    // pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          if (req.jsonError) return errResp(400, 'Bad Request: malformed JSON');
          const headRef = str(body.head);
          const baseRef = str(body.base, repo.defaultBranch);
          const headSha = branchTip(repo, headRef);
          const baseSha = branchTip(repo, baseRef);
          if (!headSha || !baseSha) return errResp(422, 'Validation Failed: head or base branch does not exist');
          repo.numberCounter += 1;
          const number = repo.numberCounter;
          const now = isoFromEpoch(EPOCH_SEC + repo.seq + number);
          const pr: PullRequest = {
            number,
            gid: globalId('PR', `${owner}/${name}#${number}`),
            title: str(body.title),
            body: str(body.body),
            state: 'open',
            headRef,
            baseRef,
            headSha,
            baseSha,
            merged: false,
            mergedAt: null,
            mergeSha: null,
            seq: number,
            createdAt: now,
            updatedAt: now,
          };
          repo.pulls.push(pr);
          return { status: 201, body: pullJson(req, repo, pr) };
        }
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          let list = repo.pulls.slice();
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.seq - a.seq);
          const base = `http://${req.host}/api/v3/repos/${owner}/${name}/pulls`;
          const { page, link } = paginate(list.map((p) => pullJson(req, repo, p)), req.query, base);
          const headers: Record<string, string> = {};
          if (link) headers.link = link;
          return { status: 200, body: page, headers };
        }
        return errResp(405, 'Method Not Allowed');
      }
      const num = Number(tail[1]);
      if (!Number.isInteger(num) || num < 1) return notFound('Not Found');
      const pr = repo.pulls.find((p) => p.number === num);
      if (tail.length === 2) {
        if (method === 'GET') {
          if (!pr) return notFound('Not Found');
          return { status: 200, body: pullJson(req, repo, pr) };
        }
        return errResp(405, 'Method Not Allowed');
      }
      if (tail[2] === 'files' && method === 'GET') {
        if (!pr) return notFound('Not Found');
        const baseFiles = filesAt(repo, pr.baseSha);
        const headFiles = filesAt(repo, pr.headSha);
        const changes = diffFiles(baseFiles, headFiles);
        const out: Record<string, unknown>[] = [];
        for (const c of changes) {
          const { additions, deletions } = lineDiff(repo, c.oldSha, c.newSha);
          const status = c.status === 'added' ? 'added' : c.status === 'modified' ? 'modified' : 'removed';
          out.push({ filename: c.path, status, additions, deletions, changes: additions + deletions });
        }
        return { status: 200, body: out };
      }
      if (tail[2] === 'merge' && method === 'PUT') {
        if (!pr) return notFound('Not Found');
        const out = squashMerge(repo, pr);
        if (!out.ok) {
          if (out.reason === 'closed') return errResp(405, 'Conflict: pull request is already closed');
          if (out.reason === 'missing-branch') return errResp(422, 'Validation Failed: head or base branch is missing');
          return errResp(405, 'Conflict: merge conflict');
        }
        return { status: 200, body: { sha: out.sha, merged: true, message: `Pull Request successfully merged` } };
      }
      return notFound();
    }

    return notFound();
  }

  return notFound();
}
