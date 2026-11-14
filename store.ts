// In-memory store: repositories, git objects, issues, pull requests, labels.
// Everything is deterministic: commit timestamps come from a per-repo counter
// seeded at the scenario epoch, global ids are hashes of stable keys.
import { createHash } from 'node:crypto';
import { VIEWER, EPOCH_SEC } from './scenario.ts';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function gitObjectId(type: string, content: Buffer): string {
  // Two updates instead of Buffer.concat: no copy of the content.
  return createHash('sha1').update(`${type} ${content.length}\0`, 'ascii').update(content).digest('hex');
}

/** Opaque, stable global id: never equal to the plain numeric id. */
export function globalId(kind: string, key: string): string {
  return `${kind}_${createHash('sha256').update(`${kind}:${key}`).digest('base64url').slice(0, 22)}`;
}

export function isoFromEpoch(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer; // raw content, without the "<type> <len>\0" header
}

export interface TreeEntry {
  mode: string; // '100644' file, '40000' dir
  name: string;
  sha: string;
}

export interface Comment {
  id: number;
  gid: string;
  body: string;
  seq: number;
}

export interface Issue {
  number: number;
  gid: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  number: number;
  gid: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string; // tip at creation
  baseSha: string; // tip at creation
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Repo {
  id: number; // databaseId
  gid: string;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>; // full refname -> commit sha
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  numberCounter: number; // shared issue+PR numbering
  commentCounter: number;
  commitSeq: number; // deterministic commit timestamps
  seq: number; // creation order
}

let globalSeq = 1;
let nextRepoId = 5000;

export function nextSeq(): number {
  return globalSeq++;
}

export class Store {
  repos = new Map<string, Repo>(); // key: owner + '/' + name

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const id = nextRepoId++;
    const repo: Repo = {
      id,
      gid: globalId('R', `${owner}/${name}`),
      owner,
      name,
      isPrivate,
      description,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      numberCounter: 0,
      commentCounter: 0,
      commitSeq: 0,
      seq: nextSeq(),
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** Repos owned by `owner`, in creation order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }
}

// ---------------------------------------------------------------- git objects

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const sha = gitObjectId(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

export function getObject(repo: Repo, sha: string): GitObject | undefined {
  return repo.objects.get(sha.toLowerCase());
}

export function makeBlob(repo: Repo, content: Buffer): string {
  return putObject(repo, 'blob', content);
}

/** Parse a tree object into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp);
    const mode = data.subarray(off, sp).toString('ascii');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    off = nul + 21;
  }
  return entries;
}

export function encodeTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git tree sort: names compared as bytes, directories as name + '/'. */
function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return entries.slice().sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * Build (and store) the tree for a flat file map path -> {mode, sha},
 * creating intermediate directory trees. Returns the root tree sha.
 */
export function buildTree(repo: Repo, files: Map<string, { mode: string; sha: string }>): string {
  // Group by first path component.
  interface Node {
    files: Map<string, { mode: string; sha: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, v] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], v);
  }
  const writeNode = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, v] of node.files) entries.push({ mode: v.mode, sha: v.sha, name });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', sha: writeNode(child), name });
    return putObject(repo, 'tree', encodeTree(sortTreeEntries(entries)));
  };
  return writeNode(root);
}

/** Flat file map (path -> blob sha/mode) for the tree at `treeSha`. */
export function flattenTree(repo: Repo, treeSha: string, prefix = ''): Map<string, { mode: string; sha: string }> {
  const out = new Map<string, { mode: string; sha: string }>();
  const obj = getObject(repo, treeSha);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix + e.name;
    if (e.mode === '40000') {
      for (const [p, v] of flattenTree(repo, e.sha, `${path}/`)) out.set(p, v);
    } else {
      out.set(path, { mode: e.mode, sha: e.sha });
    }
  }
  return out;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  authorTime: number;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const info: CommitInfo = { tree: '', parents: [], message, authorName: '', authorEmail: '', authorTime: 0 };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    // The author line is not parsed: authorName/authorEmail/authorTime are
    // never read (encodeCommit is only ever fed fresh values by makeCommit),
    // and the regex it used to need cost more than the fields are worth.
  }
  return info;
}

export function encodeCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const p of info.parents) lines.push(`parent ${p}`);
  lines.push(`author ${info.authorName} <${info.authorEmail}> ${info.authorTime} +0000`);
  lines.push(`committer ${info.authorName} <${info.authorEmail}> ${info.authorTime} +0000`);
  lines.push('');
  lines.push(info.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Create a commit object and store it. Timestamp is deterministic per repo. */
export function makeCommit(repo: Repo, tree: string, parents: string[], message: string): string {
  const time = EPOCH_SEC + repo.commitSeq++;
  return putObject(repo, 'commit', encodeCommit({
    tree,
    parents,
    message,
    authorName: VIEWER.login,
    authorEmail: VIEWER.email,
    authorTime: time,
  }));
}

export function commitOf(repo: Repo, sha: string): CommitInfo | undefined {
  const obj = getObject(repo, sha);
  if (!obj || obj.type !== 'commit') return undefined;
  return parseCommit(obj.data);
}

/** First-parent chain from `tip` (newest first). */
export function commitChain(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = tip;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    const info = commitOf(repo, cur);
    cur = info?.parents[0];
  }
  return out;
}

export function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === anc) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const info = commitOf(repo, cur);
    if (info) for (const p of info.parents) stack.push(p);
  }
  return false;
}

/** First common commit of two tips (linear histories: walk both chains). */
export function mergeBase(repo: Repo, a: string, b: string): string | undefined {
  const aSet = new Set(commitChain(repo, a));
  for (const c of commitChain(repo, b)) if (aSet.has(c)) return c;
  return undefined;
}

/** Files at a branch tip (or at a commit sha). */
export function filesAt(repo: Repo, refOrSha: string): Map<string, { mode: string; sha: string }> {
  let sha = refOrSha;
  const refSha = repo.refs.get(refOrSha);
  if (refSha) sha = refSha;
  const info = commitOf(repo, sha);
  if (!info) return new Map();
  return flattenTree(repo, info.tree);
}

/**
 * Commit a set of file changes on a branch: changes map path -> Buffer (new
 * content) or null (delete). Creates blobs/tree/commit, moves the ref.
 */
export function commitFiles(
  repo: Repo,
  branch: string,
  changes: Map<string, Buffer | null>,
  message: string,
): string {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const files = tip ? filesAt(repo, tip) : new Map<string, { mode: string; sha: string }>();
  for (const [path, content] of changes) {
    if (content === null) files.delete(path);
    else files.set(path, { mode: '100644', sha: makeBlob(repo, content) });
  }
  const tree = buildTree(repo, files);
  const parents = tip ? [tip] : [];
  const sha = makeCommit(repo, tree, parents, message);
  repo.refs.set(ref, sha);
  return sha;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  oldSha: string | null;
  newSha: string | null;
}

/** Diff two flat file maps. */
export function diffFiles(
  oldFiles: Map<string, { mode: string; sha: string }>,
  newFiles: Map<string, { mode: string; sha: string }>,
): FileChange[] {
  const out: FileChange[] = [];
  const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  for (const path of [...paths].sort()) {
    const o = oldFiles.get(path);
    const n = newFiles.get(path);
    if (o && !n) out.push({ path, status: 'deleted', oldSha: o.sha, newSha: null });
    else if (!o && n) out.push({ path, status: 'added', oldSha: null, newSha: n.sha });
    else if (o && n && o.sha !== n.sha) out.push({ path, status: 'modified', oldSha: o.sha, newSha: n.sha });
  }
  return out;
}

/** Create an issue record on a repo (shared by REST, GraphQL and MCP). */
export function createIssueRecord(repo: Repo, title: string, body: string): Issue {
  repo.numberCounter += 1;
  const number = repo.numberCounter;
  const now = isoFromEpoch(EPOCH_SEC + repo.seq + number);
  const issue: Issue = {
    number,
    gid: globalId('I', `${repo.owner}/${repo.name}#${number}`),
    title,
    body,
    state: 'open',
    labels: [],
    comments: [],
    seq: repo.numberCounter,
    createdAt: now,
    updatedAt: now,
  };
  repo.issues.push(issue);
  return issue;
}

/** Create a pull request record on a repo; null when head or base branch is missing. */
export function createPullRecord(repo: Repo, headRef: string, baseRef: string, title: string, body: string): PullRequest | null {
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (!headSha || !baseSha) return null;
  repo.numberCounter += 1;
  const number = repo.numberCounter;
  const now = isoFromEpoch(EPOCH_SEC + repo.seq + number);
  const pr: PullRequest = {
    number,
    gid: globalId('PR', `${repo.owner}/${repo.name}#${number}`),
    title,
    body,
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
  return pr;
}

/**
 * Whether merging `pr` would conflict: a path changed on the head side since
 * the merge base AND changed differently on the base side since then.
 */
export function prHasConflict(repo: Repo, pr: PullRequest): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
  if (!baseTip || !headTip) return false;
  const base = mergeBase(repo, baseTip, headTip);
  if (!base) return false;
  const baseFiles = filesAt(repo, base);
  const curFiles = filesAt(repo, baseTip);
  const headFiles = filesAt(repo, headTip);
  for (const hc of diffFiles(baseFiles, headFiles)) {
    const curEntry = curFiles.get(hc.path);
    const baseEntry = baseFiles.get(hc.path);
    const curChanged = (curEntry?.sha ?? null) !== (baseEntry?.sha ?? null);
    if (!curChanged) continue;
    if ((curEntry?.sha ?? null) !== hc.newSha) return true;
  }
  return false;
}

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: 'closed' | 'missing-branch' | 'conflict' };

/**
 * Squash-merge `pr`: the head tree lands on the base tip as one commit.
 * Shared by REST, GraphQL and MCP so all three surfaces agree.
 */
export function squashMerge(repo: Repo, pr: PullRequest): MergeOutcome {
  if (pr.merged || pr.state === 'closed') return { ok: false, reason: 'closed' };
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
  if (!baseTip || !headTip) return { ok: false, reason: 'missing-branch' };
  if (prHasConflict(repo, pr)) return { ok: false, reason: 'conflict' };
  const headFiles = filesAt(repo, headTip);
  const changes = new Map<string, Buffer | null>();
  const baseFilesNow = filesAt(repo, baseTip);
  for (const [p] of baseFilesNow) if (!headFiles.has(p)) changes.set(p, null);
  for (const [p, v] of headFiles) {
    const obj = repo.objects.get(v.sha);
    changes.set(p, obj ? Buffer.from(obj.data) : Buffer.alloc(0));
  }
  const mergeSha = commitFiles(repo, pr.baseRef, changes, pr.title || `Merge pull request #${pr.number}`);
  pr.merged = true;
  pr.state = 'closed';
  pr.mergeSha = mergeSha;
  pr.mergedAt = isoFromEpoch(EPOCH_SEC + repo.seq + pr.number + 1000);
  pr.updatedAt = pr.mergedAt;
  return { ok: true, sha: mergeSha };
}

/** Line counts of a blob's content. */
export function blobLines(repo: Repo, sha: string | null): string[] {
  if (!sha) return [];
  const obj = getObject(repo, sha);
  if (!obj) return [];
  const text = obj.data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Added/deleted line counts between two blob versions (LCS on lines). */
export function lineDiff(repo: Repo, oldSha: string | null, newSha: string | null): { additions: number; deletions: number } {
  const a = blobLines(repo, oldSha);
  const b = blobLines(repo, newSha);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  // LCS dynamic programming; files here are small (<= ~4KB in the suite).
  const m = a.length;
  const n = b.length;
  const dp: number[] = new Array((m + 1) * (n + 1)).fill(0);
  const idx = (i: number, j: number): number => i * (n + 1) + j;
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[idx(i, j)] = a[i] === b[j] ? dp[idx(i + 1, j + 1)] + 1 : Math.max(dp[idx(i + 1, j)], dp[idx(i, j + 1)]);
    }
  }
  const common = dp[0];
  return { additions: n - common, deletions: m - common };
}
