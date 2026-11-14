// GraphQL v4 under /api/graphql: a small parser + executor for the documents
// gh and github-mcp-server send (see kit sdk/conformance/checks-graphql.ts).
// No GraphQL library: the suite sends 18 fixed documents, so a hand-written
// tokenizer + recursive-descent parser plus a typed resolver table is enough.
// Unknown fields are GraphQL errors (HTTP 200 + errors array, message names
// the field); an unknown repository is data.repository = null, no errors.
import { VIEWER } from './scenario.ts';
import {
  Store, type Repo, type Issue, type PullRequest,
  filesAt, diffFiles, prHasConflict, squashMerge, globalId,
  createIssueRecord, createPullRecord,
} from './store.ts';
import type { Req, Resp } from './http.ts';

export interface GraphqlCtx {
  store: Store;
}

// -----------------------------------------------------------------------------------------------------------
// Tokenizer
// -----------------------------------------------------------------------------------------------------------

type TokKind = 'punct' | 'name' | 'string' | 'int' | 'float';
interface Tok {
  kind: TokKind;
  value: string;
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.startsWith('...', i)) {
      toks.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(c)) {
      toks.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1] as string;
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === 'b' ? '\b' : e === 'f' ? '\f' : e;
          j += 2;
        } else {
          out += src[j] as string;
          j += 1;
        }
      }
      if (j >= src.length) throw new Error('unterminated string in GraphQL document');
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      let isFloat = false;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      toks.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j] as string)) j += 1;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return toks;
}

// -----------------------------------------------------------------------------------------------------------
// Parser (AST)
// -----------------------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'var'; name: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

type Selection =
  | { kind: 'field'; alias: string | null; name: string; args: Record<string, ValueNode>; children: Selection[] | null }
  | { kind: 'inline'; typeCondition: string | null; children: Selection[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selections: Selection[] }>;
}

class Parser {
  private pos = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }

  private next(): Tok {
    const t = this.toks[this.pos];
    if (!t) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return t;
  }

  private isPunct(value: string): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === 'punct' && t.value === value;
  }

  private expectPunct(value: string): void {
    if (!this.isPunct(value)) throw new Error(`expected "${value}" in GraphQL document, got ${JSON.stringify(this.peek()?.value)}`);
    this.pos += 1;
  }

  private isName(value: string): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === 'name' && t.value === value;
  }

  private expectName(what = 'a name'): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected ${what} in GraphQL document, got ${JSON.stringify(t.value)}`);
    return t.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selections: Selection[] }>();
    while (this.pos < this.toks.length) {
      if (this.isName('fragment')) {
        this.next();
        const name = this.expectName('a fragment name');
        if (!this.isName('on')) throw new Error('expected "on" in fragment definition');
        this.next();
        const typeCondition = this.expectName('a type condition');
        const selections = this.parseSelectionSet();
        fragments.set(name, { typeCondition, selections });
        continue;
      }
      let type: 'query' | 'mutation' = 'query';
      let name: string | null = null;
      if (this.isName('query') || this.isName('mutation')) {
        type = this.next().value as 'query' | 'mutation';
        if (this.peek()?.kind === 'name') name = this.next().value;
      } else if (this.isName('subscription')) {
        throw new Error('subscriptions are not supported');
      }
      if (this.isPunct('(')) this.parseVariableDefinitions();
      this.skipDirectives();
      const selections = this.parseSelectionSet();
      operations.push({ type, name, selections });
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      this.expectName('a variable name');
      this.expectPunct(':');
      this.parseType();
      if (this.isPunct('=')) {
        this.next();
        this.parseValue();
      }
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    if (this.isPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('a type name');
    }
    while (this.isPunct('!')) this.next();
  }

  private skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName('a directive name');
      if (this.isPunct('(')) this.parseArguments();
    }
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      const name = this.expectName('an argument name');
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'float') return { kind: 'float', value: Number(t.value) };
    if (t.kind === 'punct' && t.value === '$') return { kind: 'var', name: this.expectName('a variable name') };
    if (t.kind === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      while (!this.isPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!this.isPunct('}')) {
        const name = this.expectName('an input field name');
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value ${JSON.stringify(t.value)} in GraphQL document`);
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const out: Selection[] = [];
    while (!this.isPunct('}')) out.push(this.parseSelection());
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): Selection {
    if (this.isPunct('...')) {
      this.next();
      if (this.isName('on')) {
        this.next();
        const typeCondition = this.expectName('a type condition');
        this.skipDirectives();
        return { kind: 'inline', typeCondition, children: this.parseSelectionSet() };
      }
      const name = this.expectName('a fragment name');
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    const first = this.expectName('a field name');
    let alias: string | null = null;
    let name = first;
    if (this.isPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName('a field name');
    }
    const args = this.isPunct('(') ? this.parseArguments() : {};
    this.skipDirectives();
    const children = this.isPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, children };
  }
}

// -----------------------------------------------------------------------------------------------------------
// Execution
// -----------------------------------------------------------------------------------------------------------

interface GqlError {
  message: string;
  path?: (string | number)[];
}

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: GqlError[];
  fragments: Map<string, { typeCondition: string; selections: Selection[] }>;
}

/** A resolved object: its GraphQL type plus the underlying record. */
type Obj = { __typename: string; [key: string]: unknown };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'var':
      return variables[node.name];
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = resolveValue(v, variables);
      return out;
    }
  }
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

// -- wrappers ----------------------------------------------------------------

function wrapRepo(repo: Repo): Obj {
  return { __typename: 'Repository', repo };
}
function wrapIssue(repo: Repo, issue: Issue): Obj {
  return { __typename: 'Issue', repo, issue };
}
function wrapPull(repo: Repo, pr: PullRequest): Obj {
  return { __typename: 'PullRequest', repo, pr };
}
function wrapComment(repo: Repo, issue: Issue, comment: { id: number; gid: string; body: string }): Obj {
  return { __typename: 'Comment', repo, issue, comment };
}

// -- lookups -----------------------------------------------------------------

function findRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function findRepoByGid(ctx: Ctx, gid: string): Repo | null {
  for (const repo of ctx.store.repos.values()) if (repo.gid === gid) return repo;
  return null;
}

function findIssueByGid(ctx: Ctx, gid: string): { repo: Repo; issue: Issue } | null {
  for (const repo of ctx.store.repos.values()) {
    for (const issue of repo.issues) if (issue.gid === gid) return { repo, issue };
  }
  return null;
}

function findPullByGid(ctx: Ctx, gid: string): { repo: Repo; pr: PullRequest } | null {
  for (const repo of ctx.store.repos.values()) {
    for (const pr of repo.pulls) if (pr.gid === gid) return { repo, pr };
  }
  return null;
}

// -- cursors -----------------------------------------------------------------

function encodeCursor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// -- connections ---------------------------------------------------------------

function issuesConnection(repo: Repo, args: Record<string, unknown>): Obj {
  let list = repo.issues.slice();
  if (Array.isArray(args.states)) {
    const wanted = new Set(args.states as string[]);
    list = list.filter((i) => wanted.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = isObj(args.orderBy) ? args.orderBy : null;
  if (orderBy?.field === 'CREATED_AT') {
    list.sort((a, b) => (orderBy.direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  } else if (orderBy?.field === 'UPDATED_AT') {
    list.sort((a, b) => (orderBy.direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  } else {
    list.sort((a, b) => a.seq - b.seq);
  }
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const seq = decodeCursor(args.after);
    if (seq !== null) {
      const idx = list.findIndex((i) => i.seq === seq);
      if (idx >= 0) start = idx + 1;
    }
  }
  const first = typeof args.first === 'number' ? args.first : undefined;
  const page = first !== undefined ? list.slice(start, start + first) : list.slice(start);
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.seq) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((i) => wrapIssue(repo, i)),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

function pullRequestsConnection(repo: Repo, args: Record<string, unknown>): Obj {
  let list = repo.pulls.filter((p) => p.state === 'open');
  list.sort((a, b) => b.seq - a.seq);
  const first = typeof args.first === 'number' ? args.first : undefined;
  const page = first !== undefined ? list.slice(0, first) : list;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((p) => wrapPull(repo, p)),
    pageInfo: { __typename: 'PageInfo', hasNextPage: first !== undefined && list.length > first, endCursor: null },
  };
}

function pullFilesConnection(repo: Repo, pr: PullRequest, args: Record<string, unknown>): Obj {
  const baseFiles = filesAt(repo, pr.baseSha);
  const headFiles = filesAt(repo, pr.headSha);
  const changes = diffFiles(baseFiles, headFiles);
  const first = typeof args.first === 'number' ? args.first : undefined;
  const page = first !== undefined ? changes.slice(0, first) : changes;
  return {
    __typename: 'PullRequestChangedFileConnection',
    nodes: page.map((c) => ({ __typename: 'PullRequestChangedFile', path: c.path })),
    pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: null },
  };
}

// -- introspection -------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name'],
  GitRef: ['name'],
  IssueConnection: ['nodes', 'pageInfo'],
  PullRequestConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path'],
  PageInfo: ['hasNextPage', 'endCursor'],
  Comment: ['id', 'body'],
  CommentEdge: ['node'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'PROJECT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// -- resolvers -----------------------------------------------------------------

type Resolver = (obj: Obj, args: Record<string, unknown>, ctx: Ctx) => unknown;

function repoOf(obj: Obj): Repo {
  return obj.repo as Repo;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name }),
    repository: (_obj, args, ctx) => {
      const repo = findRepo(ctx, str(args.owner), str(args.name));
      return repo ? wrapRepo(repo) : null;
    },
    node: (_obj, args, ctx) => {
      const id = str(args.id);
      if (!id) return null;
      const repo = findRepoByGid(ctx, id);
      if (repo) return wrapRepo(repo);
      const issue = findIssueByGid(ctx, id);
      if (issue) return wrapIssue(issue.repo, issue.issue);
      const pr = findPullByGid(ctx, id);
      if (pr) return wrapPull(pr.repo, pr.pr);
      return null;
    },
    __type: (_obj, args) => {
      const name = str(args.name);
      if (TYPE_FIELDS[name] !== undefined || ENUM_VALUES[name] !== undefined) {
        return { __typename: '__Type', typeName: name };
      }
      return null;
    },
    __schema: () => null,
  },
  Mutation: {
    createIssue: (_obj, args, ctx) => {
      const input = isObj(args.input) ? args.input : {};
      const repo = findRepoByGid(ctx, str(input.repositoryId));
      if (!repo) throw new Error(`repository not found for id ${str(input.repositoryId)}`);
      const issue = createIssueRecord(repo, str(input.title), str(input.body));
      return { __typename: 'CreateIssuePayload', issue: wrapIssue(repo, issue) };
    },
    closeIssue: (_obj, args, ctx) => {
      const input = isObj(args.input) ? args.input : {};
      const found = findIssueByGid(ctx, str(input.issueId));
      if (!found) throw new Error(`issue not found for id ${str(input.issueId)}`);
      found.issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: wrapIssue(found.repo, found.issue) };
    },
    createPullRequest: (_obj, args, ctx) => {
      const input = isObj(args.input) ? args.input : {};
      const repo = findRepoByGid(ctx, str(input.repositoryId));
      if (!repo) throw new Error(`repository not found for id ${str(input.repositoryId)}`);
      const pr = createPullRecord(repo, str(input.headRefName), str(input.baseRefName), str(input.title), str(input.body));
      if (!pr) throw new Error(`head or base branch does not exist`);
      return { __typename: 'CreatePullRequestPayload', pullRequest: wrapPull(repo, pr) };
    },
    mergePullRequest: (_obj, args, ctx) => {
      const input = isObj(args.input) ? args.input : {};
      const found = findPullByGid(ctx, str(input.pullRequestId));
      if (!found) throw new Error(`pull request not found for id ${str(input.pullRequestId)}`);
      const out = squashMerge(found.repo, found.pr);
      if (!out.ok) throw new Error(`cannot merge pull request #${found.pr.number}: ${out.reason}`);
      return { __typename: 'MergePullRequestPayload', pullRequest: wrapPull(found.repo, found.pr) };
    },
    addComment: (_obj, args, ctx) => {
      const input = isObj(args.input) ? args.input : {};
      const found = findIssueByGid(ctx, str(input.subjectId));
      if (!found) throw new Error(`issue not found for id ${str(input.subjectId)}`);
      const { repo, issue } = found;
      repo.commentCounter += 1;
      const comment = {
        id: repo.commentCounter,
        gid: globalId('C', `${repo.owner}/${repo.name}#${issue.number}/c${repo.commentCounter}`),
        body: str(input.body),
        seq: repo.commentCounter,
      };
      issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'CommentEdge', node: wrapComment(repo, issue, comment) },
      };
    },
  },
  Repository: {
    id: (obj) => repoOf(obj).gid,
    databaseId: (obj) => repoOf(obj).id,
    name: (obj) => repoOf(obj).name,
    nameWithOwner: (obj) => `${repoOf(obj).owner}/${repoOf(obj).name}`,
    owner: (obj) => ({ __typename: 'User', login: repoOf(obj).owner, id: VIEWER.id }),
    defaultBranchRef: (obj) => {
      const repo = repoOf(obj);
      return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { __typename: 'GitRef', name: repo.defaultBranch } : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (obj) => repoOf(obj).description,
    createdAt: (obj) => repoOf(obj).seq,
    updatedAt: (obj) => repoOf(obj).seq,
    issue: (obj, args) => {
      const repo = repoOf(obj);
      const issue = repo.issues.find((i) => i.number === args.number);
      return issue ? wrapIssue(repo, issue) : null;
    },
    issues: (obj, args) => issuesConnection(repoOf(obj), args),
    pullRequests: (obj, args) => pullRequestsConnection(repoOf(obj), args),
    pullRequest: (obj, args) => {
      const repo = repoOf(obj);
      const pr = repo.pulls.find((p) => p.number === args.number);
      return pr ? wrapPull(repo, pr) : null;
    },
  },
  Issue: {
    id: (obj) => (obj.issue as Issue).gid,
    number: (obj) => (obj.issue as Issue).number,
    title: (obj) => (obj.issue as Issue).title,
    state: (obj) => ((obj.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (obj) => (obj.issue as Issue).body,
    createdAt: (obj) => (obj.issue as Issue).createdAt,
    updatedAt: (obj) => (obj.issue as Issue).updatedAt,
  },
  PullRequest: {
    id: (obj) => (obj.pr as PullRequest).gid,
    number: (obj) => (obj.pr as PullRequest).number,
    title: (obj) => (obj.pr as PullRequest).title,
    body: (obj) => (obj.pr as PullRequest).body,
    state: (obj) => {
      const pr = obj.pr as PullRequest;
      if (pr.merged) return 'MERGED';
      return pr.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (obj) => (obj.pr as PullRequest).merged,
    headRefName: (obj) => (obj.pr as PullRequest).headRef,
    baseRefName: (obj) => (obj.pr as PullRequest).baseRef,
    mergeable: (obj) => (prHasConflict(repoOf(obj), obj.pr as PullRequest) ? 'CONFLICTING' : 'MERGEABLE'),
    files: (obj, args) => pullFilesConnection(repoOf(obj), obj.pr as PullRequest, args),
    createdAt: (obj) => (obj.pr as PullRequest).createdAt,
    updatedAt: (obj) => (obj.pr as PullRequest).updatedAt,
  },
  User: {
    id: (obj) => (obj.id as number | undefined) ?? VIEWER.id,
    login: (obj) => str(obj.login, VIEWER.login),
    name: (obj) => str(obj.name, VIEWER.name),
  },
  GitRef: {
    name: (obj) => str(obj.name),
  },
  IssueConnection: {
    nodes: (obj) => obj.nodes as Obj[],
    pageInfo: (obj) => obj.pageInfo as Obj,
  },
  PullRequestConnection: {
    nodes: (obj) => obj.nodes as Obj[],
    pageInfo: (obj) => obj.pageInfo as Obj,
  },
  PullRequestChangedFileConnection: {
    nodes: (obj) => obj.nodes as Obj[],
    pageInfo: (obj) => obj.pageInfo as Obj,
  },
  PullRequestChangedFile: {
    path: (obj) => str(obj.path),
  },
  PageInfo: {
    hasNextPage: (obj) => obj.hasNextPage as boolean,
    endCursor: (obj) => (obj.endCursor as string | null) ?? null,
  },
  Comment: {
    id: (obj) => (obj.comment as { gid: string }).gid,
    body: (obj) => (obj.comment as { body: string }).body,
  },
  CommentEdge: {
    node: (obj) => obj.node as Obj,
  },
  CreateIssuePayload: {
    issue: (obj) => obj.issue as Obj,
  },
  CloseIssuePayload: {
    issue: (obj) => obj.issue as Obj,
  },
  CreatePullRequestPayload: {
    pullRequest: (obj) => obj.pullRequest as Obj,
  },
  MergePullRequestPayload: {
    pullRequest: (obj) => obj.pullRequest as Obj,
  },
  AddCommentPayload: {
    commentEdge: (obj) => obj.commentEdge as Obj,
  },
  __Type: {
    name: (obj) => str(obj.typeName),
    kind: (obj) => (ENUM_VALUES[str(obj.typeName)] !== undefined ? 'ENUM' : 'OBJECT'),
    fields: (obj, args) => {
      void args;
      const fields = TYPE_FIELDS[str(obj.typeName)];
      if (!fields) return null;
      return fields.map((name) => ({ __typename: '__Field', name }));
    },
    enumValues: (obj, args) => {
      void args;
      const values = ENUM_VALUES[str(obj.typeName)];
      if (!values) return null;
      return values.map((name) => ({ __typename: '__EnumValue', name }));
    },
  },
  __Field: {
    name: (obj) => str(obj.name),
  },
  __EnumValue: {
    name: (obj) => str(obj.name),
  },
};

// -- execution -----------------------------------------------------------------

function executeSelectionSet(
  typeName: string,
  obj: Obj,
  selections: Selection[],
  ctx: Ctx,
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name);
      if (!frag) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}".`, path });
        continue;
      }
      if (frag.typeCondition !== typeName) continue;
      Object.assign(out, executeSelectionSet(typeName, obj, frag.selections, ctx, path));
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.typeCondition !== null && sel.typeCondition !== typeName) continue;
      Object.assign(out, executeSelectionSet(typeName, obj, sel.children, ctx, path));
      continue;
    }
    const responseKey = sel.alias ?? sel.name;
    const fieldPath = [...path, responseKey];
    if (sel.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const fields = TYPE_FIELDS[typeName];
    const resolver = RESOLVERS[typeName]?.[sel.name];
    if (!fields?.includes(sel.name) || !resolver) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".`, path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(sel.args)) args[k] = resolveValue(v, ctx.variables);
    let value: unknown;
    try {
      value = resolver(obj, args, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = resolveChildren(value, sel.children, ctx, fieldPath);
  }
  return out;
}

/** Apply a field's sub-selection to its resolved value (object, list, or null). */
function resolveChildren(value: unknown, children: Selection[] | null, ctx: Ctx, path: (string | number)[]): unknown {
  if (children === null || children.length === 0) return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item, i) => resolveChildren(item, children, ctx, [...path, i]));
  }
  if (isObj(value) && typeof value.__typename === 'string') {
    return executeSelectionSet(value.__typename as string, value as Obj, children, ctx, path);
  }
  return value;
}

function executeOperation(store: Store, doc: Document, op: Operation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors: GqlError[] } {
  const ctx: Ctx = { store, variables, errors: [], fragments: doc.fragments };
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  const root: Obj = { __typename: rootType };
  const data = executeSelectionSet(rootType, root, op.selections, ctx, []);
  return { data, errors: ctx.errors };
}

// -----------------------------------------------------------------------------------------------------------
// HTTP handler
// -----------------------------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function handleGraphql(ctx: GraphqlCtx, req: Req): Resp | null {
  const seg = req.segments;
  if (seg[0] !== 'api' || seg[1] !== 'graphql') return null;
  if (req.method !== 'POST') return { status: 405, body: { message: 'Method Not Allowed' } };
  if (req.jsonError) return { status: 400, body: { message: 'Bad Request: malformed JSON' } };

  const runOne = (body: unknown): Record<string, unknown> => {
    if (!isRecord(body) || typeof body.query !== 'string') {
      return { data: null, errors: [{ message: 'A GraphQL operation document is required.' }] };
    }
    let doc: Document;
    try {
      doc = new Parser(tokenize(body.query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    const variables = isRecord(body.variables) ? body.variables : {};
    let op: Operation | undefined;
    if (typeof body.operationName === 'string' && body.operationName !== '') {
      op = doc.operations.find((o) => o.name === body.operationName);
      if (!op) return { data: null, errors: [{ message: `Unknown operation named "${body.operationName}".` }] };
    } else {
      op = doc.operations[0];
    }
    if (!op) return { data: null, errors: [{ message: 'No operation in the GraphQL document.' }] };
    const { data, errors } = executeOperation(ctx.store, doc, op, variables);
    const out: Record<string, unknown> = { data };
    if (errors.length > 0) out.errors = errors;
    return out;
  };

  if (Array.isArray(req.json)) {
    return { status: 200, body: req.json.map((entry) => runOne(entry)) };
  }
  return { status: 200, body: runOne(req.json) };
}
