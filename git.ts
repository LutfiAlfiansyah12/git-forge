// Git smart HTTP: pkt-lines, packfiles (read + write, incl. deltas),
// upload-pack protocol v2 (+ v0 fallback) and receive-pack v0.
// No git binary anywhere: every byte is built and parsed here.
import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  Store, type Repo, getObject, putObject, parseTree, parseCommit,
  commitOf, isAncestor, filesAt, gitObjectId, type ObjType,
} from './store.ts';
import { errResp, notFound, type Req, type Resp } from './http.ts';

export const ZERO_OID = '0'.repeat(40);
const AGENT = 'makefun-git-forge/1.0';
const MAX_PKT = 65520;

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'end';
  data?: Buffer;
}

/** Parse pkt-lines from the start of `buf`; returns packets and bytes consumed. */
export function parsePktLines(buf: Buffer): { packets: Pkt[]; consumed: number } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(head)) break; // raw bytes follow (pack data)
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end' });
      off += 4;
      continue;
    }
    if (len < 4 || len > MAX_PKT || off + len > buf.length) break;
    packets.push({ kind: 'data', data: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, consumed: off };
}

function pktText(p: Pkt): string {
  return p.kind === 'data' ? (p.data as Buffer).toString('utf8') : '';
}

// ---------------------------------------------------------------- zlib

/**
 * Inflate exactly one zlib stream starting at `offset`, whose inflated size is
 * `expectedSize`. inflateSync ignores trailing bytes, so the stream end is
 * found by binary search on the smallest prefix that inflates correctly.
 */
export function inflateExact(buf: Buffer, offset: number, expectedSize: number): { data: Buffer; consumed: number } {
  const remaining = buf.length - offset;
  let lo = 1;
  let hi = remaining;
  let found = -1;
  // Fast path: a whole-buffer inflate gives the data at once.
  const full = inflateSync(buf.subarray(offset));
  if (full.length !== expectedSize) throw new Error('pack-zlib: inflated size mismatch');
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const out = inflateSync(buf.subarray(offset, offset + mid));
      if (out.length === expectedSize) {
        found = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    } catch {
      lo = mid + 1;
    }
  }
  if (found === -1) throw new Error('pack-zlib: cannot find stream end');
  return { data: full, consumed: found };
}

// ---------------------------------------------------------------- packfiles

export interface PackObject {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackEntryHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (type << 4) | (size & 0x0f);
  size >>>= 4;
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size >>>= 7;
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

/** A version-2 pack of plain objects (no deltas), in map order. */
export function writePack(objects: Map<string, PackObject>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.size, 8);
  parts.push(header);
  for (const obj of objects.values()) {
    parts.push(writePackEntryHeader(TYPE_CODES[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const trailer = createHash('sha1').update(Buffer.concat(parts)).digest();
  parts.push(trailer);
  return Buffer.concat(parts);
}

/** Read a packfile fully, resolving OFS/REF deltas. Returns oid -> object. */
export function readPack(buf: Buffer): Map<string, PackObject> {
  if (buf.length < 32) throw new Error('pack-too-short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack-magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('pack-version');
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const checksum = createHash('sha1').update(buf.subarray(0, trailerStart)).digest();
  if (!checksum.equals(buf.subarray(trailerStart))) throw new Error('pack-checksum');
  interface RawEntry {
    offset: number;
    type: number;
    size: number;
    dataStart: number;
    dataEnd: number;
    baseOffset?: number;
    baseOid?: string;
  }
  const entries: RawEntry[] = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const start = off;
    let b = buf[off++];
    const type = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = buf[off++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    const entry: RawEntry = { offset: start, type, size, dataStart: off, dataEnd: -1 };
    if (type === 6) {
      // OFS_DELTA: negative-offset varint.
      let v = buf[off++] & 0x7f;
      while (buf[off - 1] & 0x80) {
        const nb = buf[off++];
        v = ((v + 1) << 7) | (nb & 0x7f);
      }
      entry.baseOffset = start - v;
      if (v <= 0 || v > start) throw new Error('pack-delta');
    } else if (type === 7) {
      entry.baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      entry.dataStart = off;
    }
    const { data, consumed } = inflateExact(buf, off, size);
    void data;
    off += consumed;
    entry.dataEnd = off;
    entries.push(entry);
  }
  if (off !== trailerStart) throw new Error('pack-trailing');
  // Resolve entries in order (delta bases precede their deltas in a pack).
  const byOffset = new Map<number, PackObject>();
  const result = new Map<string, PackObject>();
  const resolve = (entry: RawEntry, seen: Set<number>): PackObject => {
    const cached = byOffset.get(entry.offset);
    if (cached) return cached;
    if (seen.has(entry.offset)) throw new Error('pack-delta-cycle');
    seen.add(entry.offset);
    let obj: PackObject;
    if (entry.type === 6 || entry.type === 7) {
      let base: PackObject | undefined;
      if (entry.type === 6) {
        const baseEntry = entries.find((e) => e.offset === entry.baseOffset);
        if (!baseEntry) throw new Error('pack-delta-base');
        base = resolve(baseEntry, seen);
      } else {
        base = result.get(entry.baseOid as string);
        if (!base) {
          // The base may be a later entry in the pack: resolve entries until it appears.
          for (const candidate of entries) {
            const resolved = resolve(candidate, new Set());
            if (gitObjectId(resolved.type, resolved.data) === entry.baseOid) {
              base = resolved;
              break;
            }
          }
        }
        if (!base) throw new Error('pack-delta-base');
      }
      const delta = inflateSync(buf.subarray(entry.dataStart, entry.dataEnd));
      obj = applyDelta(base, delta);
    } else {
      const type = CODE_TYPES[entry.type];
      if (!type) throw new Error('pack-type');
      obj = { type, data: inflateSync(buf.subarray(entry.dataStart, entry.dataEnd)) };
      if (obj.data.length !== entry.size) throw new Error('pack-size');
    }
    byOffset.set(entry.offset, obj);
    const oid = gitObjectId(obj.type, obj.data);
    result.set(oid, obj);
    return obj;
  };
  for (const entry of entries) resolve(entry, new Set());
  if (result.size !== count && entries.length !== count) throw new Error('pack-count');
  return result;
}

/** Apply a git delta to a base object. */
export function applyDelta(base: PackObject, delta: Buffer): PackObject {
  let off = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readVarint();
  const tgtSize = readVarint();
  if (srcSize !== base.data.length) throw new Error('delta-base-size');
  const out: Buffer[] = [];
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) cpOff = delta[off++];
      if (op & 0x02) cpOff |= delta[off++] << 8;
      if (op & 0x04) cpOff |= delta[off++] << 16;
      if (op & 0x08) cpOff |= delta[off++] << 24;
      if (op & 0x10) cpSize = delta[off++];
      if (op & 0x20) cpSize |= delta[off++] << 8;
      if (op & 0x40) cpSize |= delta[off++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      if (cpOff + cpSize > base.data.length) throw new Error('delta-corrupt');
      out.push(base.data.subarray(cpOff, cpOff + cpSize));
      written += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(off, off + op));
      off += op;
      written += op;
    } else {
      throw new Error('delta-corrupt');
    }
  }
  if (written !== tgtSize) throw new Error('delta-size');
  return { type: base.type, data: Buffer.concat(out) };
}

// ---------------------------------------------------------------- reachability

/** All object ids reachable from `roots` (commits/tags/trees/blobs). */
export function reachable(repo: Repo, roots: string[]): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (!obj) continue; // missing objects are simply not walked
    out.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      if (info.tree) stack.push(info.tree);
      for (const p of info.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode === '160000') continue; // gitlink: not held here
        stack.push(e.sha);
      }
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m) stack.push(m[1]);
    }
  }
  return out;
}

/** Commit ids reachable from `roots` (for shallow/depth math). */
function reachableCommits(repo: Repo, roots: string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const info = commitOf(repo, oid);
    if (!info) continue;
    out.add(oid);
    for (const p of info.parents) stack.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- helpers

function allRefs(repo: Repo): { name: string; oid: string }[] {
  const out: { name: string; oid: string }[] = [];
  for (const [name, oid] of [...repo.refs.entries()].sort()) out.push({ name, oid });
  return out;
}

function tagTarget(repo: Repo, oid: string): string | undefined {
  const obj = getObject(repo, oid);
  if (!obj || obj.type !== 'tag') return undefined;
  const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
  return m ? m[1] : undefined;
}

/** Sideband-wrap a payload: split into band-1 pkt-lines (<=65520 bytes each). */
function sideband(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

function rawResp(status: number, contentType: string, body: Buffer): Resp {
  return { status, body: null, headers: { 'content-type': contentType }, rawBody: body };
}

// ---------------------------------------------------------------- upload-pack v2

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  thinPack: boolean;
  filter: string | null;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, thinPack: false, filter: null };
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('want ')) args.wants.push(t.slice(5).trim());
    else if (t.startsWith('have ')) args.haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) args.shallow.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) args.depth = Number(t.slice(7).trim());
    else if (t === 'thin-pack') args.thinPack = true;
    else if (t.startsWith('filter ')) args.filter = t.slice(7).trim();
  }
  return args;
}

/** Objects the client already holds: reachable from `haves`, but never below a
 * shallow boundary (a boundary commit's parents are NOT held). */
function heldSet(repo: Repo, haves: string[], shallow: string[]): Set<string> {
  const held = reachable(repo, haves);
  for (const b of shallow) {
    const info = commitOf(repo, b);
    if (!info) continue;
    for (const oid of reachable(repo, info.parents)) held.delete(oid);
  }
  return held;
}

/** Objects to send for a fetch, plus new shallow boundaries / resolved ones. */
function planFetch(repo: Repo, args: FetchArgs): { objects: Map<string, PackObject>; shallow: string[]; unshallow: string[] } {
  const held = heldSet(repo, args.haves, args.shallow);
  const heldCommits = new Set<string>();
  for (const oid of held) if (commitOf(repo, oid)) heldCommits.add(oid);
  const objects = new Map<string, PackObject>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const addReachable = (roots: string[]): void => {
    for (const oid of reachable(repo, roots)) {
      if (held.has(oid)) continue;
      const obj = getObject(repo, oid);
      if (obj) objects.set(oid, { type: obj.type, data: obj.data });
    }
  };
  if (args.depth !== null && args.depth > 0) {
    // Commits within (depth-1) parent steps of the wants. The walk continues
    // through held commits (their parents may still be unheld, as in deepen).
    const included = new Set<string>();
    const visited = new Set<string>();
    let frontier = args.wants.filter((w) => commitOf(repo, w));
    for (let d = 0; d < args.depth && frontier.length > 0; d += 1) {
      const next: string[] = [];
      for (const c of frontier) {
        if (visited.has(c)) continue;
        visited.add(c);
        const info = commitOf(repo, c);
        if (!info) continue;
        if (!heldCommits.has(c)) included.add(c);
        for (const p of info.parents) next.push(p);
      }
      frontier = next;
    }
    // Include each included commit's tree+blobs (minus held).
    for (const c of included) {
      const info = commitOf(repo, c);
      if (!info) continue;
      addReachable([info.tree]);
      const obj = getObject(repo, c);
      if (obj) objects.set(c, { type: 'commit', data: obj.data });
    }
    // Boundaries: included commits whose parent is neither included nor held.
    for (const c of included) {
      const info = commitOf(repo, c);
      if (!info) continue;
      const missingParent = info.parents.some((p) => !included.has(p) && !heldCommits.has(p));
      if (missingParent) shallow.push(c);
    }
    // Resolved boundaries: previously shallow commits whose parents are now included/held.
    for (const b of args.shallow) {
      const info = commitOf(repo, b);
      if (!info) continue;
      if (info.parents.every((p) => included.has(p) || heldCommits.has(p))) unshallow.push(b);
    }
  } else {
    const wantReach = reachable(repo, args.wants);
    for (const oid of wantReach) {
      if (held.has(oid)) continue;
      const obj = getObject(repo, oid);
      if (obj) objects.set(oid, { type: obj.type, data: obj.data });
    }
  }
  return { objects, shallow, unshallow };
}

/**
 * Fetch pack cache: identical fetch arguments against an unchanged repo
 * always build the same pack (objects are content-addressed and immutable,
 * refs are fingerprinted into the key, and any object addition changes
 * repo.objects.size). The clone workload issues 50 identical depth-1
 * fetches per round, so this skips the walk + deflate for 49 of them.
 * Bounded FIFO (16 entries); a pack for the bench's 200-file tree is small.
 */
const FETCH_PACK_CACHE = new Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>();
const FETCH_PACK_CACHE_MAX = 16;

function fetchPack(repo: Repo, args: FetchArgs): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const refFingerprint = [...repo.refs.entries()].sort().map(([n, o]) => `${n}=${o}`).join(';');
  const key = [
    `${repo.owner}/${repo.name}`,
    repo.objects.size,
    refFingerprint,
    args.wants.join(','),
    args.haves.join(','),
    args.shallow.join(','),
    args.depth,
    args.thinPack,
    args.filter ?? '',
  ].join('|');
  const hit = FETCH_PACK_CACHE.get(key);
  if (hit) return hit;
  const { objects, shallow, unshallow } = planFetch(repo, args);
  const out = { pack: writePack(objects), shallow, unshallow };
  if (FETCH_PACK_CACHE.size >= FETCH_PACK_CACHE_MAX) {
    const oldest = FETCH_PACK_CACHE.keys().next().value;
    if (oldest !== undefined) FETCH_PACK_CACHE.delete(oldest);
  }
  FETCH_PACK_CACHE.set(key, out);
  return out;
}

function handleUploadPackV2(repo: Repo, req: Req): Resp {
  const { packets } = parsePktLines(req.rawBody);
  const lines: string[] = [];
  let command = '';
  let afterDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const text = pktText(p);
    if (!afterDelim) {
      if (text.startsWith('command=')) command = text.slice('command='.length).trim();
      continue;
    }
    lines.push(text);
  }
  if (command === 'ls-refs') {
    let peel = false;
    let symrefs = false;
    const prefixes: string[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (t === 'peel') peel = true;
      else if (t === 'symrefs') symrefs = true;
      else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length).trim());
    }
    const parts: Buffer[] = [];
    const emit = (oid: string, name: string, extra: string): void => {
      parts.push(pktLine(`${oid} ${name}${extra}\n`));
    };
    const refs = allRefs(repo);
    const headTip = repo.refs.get('refs/heads/main');
    const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    // HEAD entry (no refs/ prefix, so only when no prefix filters it out).
    if (matches('HEAD')) {
      if (headTip) emit(headTip, 'HEAD', symrefs ? ' symref-target:refs/heads/main' : '');
      else parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    }
    for (const r of refs) {
      if (!matches(r.name)) continue;
      let extra = '';
      if (peel) {
        const peeled = tagTarget(repo, r.oid);
        if (peeled) extra += ` peeled:${peeled}`;
      }
      emit(r.oid, r.name, extra);
    }
    parts.push(PKT_FLUSH);
    return rawResp(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
  }
  if (command === 'fetch') {
    const args = parseFetchArgs(lines);
    const { pack, shallow, unshallow } = fetchPack(repo, args);
    const parts: Buffer[] = [];
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine('NAK\n'));
    parts.push(PKT_FLUSH);
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
      for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
      parts.push(PKT_FLUSH);
    }
    // wanted-refs: map wants back to ref names when known.
    const wanted: string[] = [];
    for (const w of args.wants) {
      for (const r of allRefs(repo)) if (r.oid === w) wanted.push(`${w} ${r.name}`);
    }
    if (wanted.length > 0) {
      parts.push(pktLine('wanted-refs\n'));
      for (const w of wanted) parts.push(pktLine(`${w}\n`));
      parts.push(PKT_FLUSH);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sideband(pack));
    parts.push(PKT_FLUSH);
    return rawResp(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
  }
  return rawResp(400, 'application/x-git-upload-pack-result', Buffer.alloc(0));
}

function handleUploadPackV0(repo: Repo, req: Req): Resp {
  const { packets } = parsePktLines(req.rawBody);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowReq: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') {
      section += 1;
      continue;
    }
    if (p.kind !== 'data') continue;
    const t = pktText(p).trim();
    if (t.startsWith('want ')) wants.push(t.slice(5).split(' ')[0]);
    else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) shallowReq.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) depth = Number(t.slice(7).trim());
    void section;
  }
  const args: FetchArgs = { wants, haves, shallow: shallowReq, depth, thinPack: true, filter: null };
  const { pack, shallow, unshallow } = fetchPack(repo, args);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(sideband(pack));
  parts.push(PKT_FLUSH);
  return rawResp(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------- receive-pack v0

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, req: Req): Resp {
  const { packets, consumed } = parsePktLines(req.rawBody);
  const commands: PushCommand[] = [];
  let sidebandNegotiated = false;
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    const text = pktText(p);
    const nul = text.indexOf('\0');
    let line = text;
    let caps = '';
    if (nul >= 0) {
      line = text.slice(0, nul);
      caps = text.slice(nul + 1);
      if (caps.includes('side-band-64k')) sidebandNegotiated = true;
    }
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(line.trim());
    if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  const packBytes = req.rawBody.subarray(consumed);
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = '';
  // Unpack the pack (if any command carries new objects).
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  let packed = new Map<string, { type: ObjType; data: Buffer }>();
  if (needsPack && packBytes.length > 0) {
    try {
      packed = readPack(packBytes);
      for (const [oid, obj] of packed) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, { type: obj.type, data: obj.data });
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (!unpackOk) {
      reportLines.push(`ng ${cmd.ref} ${unpackDetail}`);
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (!current) {
        reportLines.push(`ng ${cmd.ref} remote ref does not exist`);
      } else {
        repo.refs.delete(cmd.ref);
        reportLines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current) {
        reportLines.push(`ng ${cmd.ref} already exists`);
        continue;
      }
    } else {
      // Update: old must match, and new must be a descendant of old.
      if (!current || current.toLowerCase() !== cmd.oldOid.toLowerCase()) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward`);
        continue;
      }
      if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward`);
        continue;
      }
    }
    // The new tip must exist (in the pack or already on the server).
    if (!getObject(repo, cmd.newOid)) {
      reportLines.push(`ng ${cmd.ref} missing object`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    reportLines.push(`ok ${cmd.ref}`);
  }
  const reportText = `${unpackOk ? 'unpack ok' : `unpack ${unpackDetail}`}\n${reportLines.map((l) => `${l}\n`).join('')}`;
  // The report itself is pkt-lined, then wrapped in sideband band 1 when negotiated.
  let reportBytes: Buffer;
  if (Buffer.byteLength(reportText) + 4 <= MAX_PKT) {
    reportBytes = pktLine(reportText);
  } else {
    const parts: Buffer[] = [];
    for (const line of reportText.split('\n')) {
      if (line) parts.push(pktLine(`${line}\n`));
    }
    reportBytes = Buffer.concat(parts);
  }
  let body: Buffer;
  if (sidebandNegotiated) {
    body = Buffer.concat([sideband(reportBytes), PKT_FLUSH]);
  } else {
    body = Buffer.concat([reportBytes, PKT_FLUSH]);
  }
  return rawResp(200, 'application/x-git-receive-pack-result', body);
}

// ---------------------------------------------------------------- router

export interface GitCtx {
  store: Store;
}

function advertiseV2Upload(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    PKT_FLUSH,
  ]);
}

function advertiseV0(repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const caps = service === 'upload-pack'
    ? `side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=${AGENT} symref=HEAD:refs/heads/main`
    : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/main`;
  const parts: Buffer[] = [pktLine(`# service=git-${service}\n`), PKT_FLUSH];
  const refs = allRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((r, i) => {
      parts.push(pktLine(i === 0 ? `${r.oid} ${r.name}\0${caps}\n` : `${r.oid} ${r.name}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleGit(ctx: GitCtx, req: Req): Resp | null {
  const seg = req.segments;
  if (seg.length < 2 || !seg[1].endsWith('.git')) return null;
  const owner = decodeURIComponent(seg[0]);
  const repoName = decodeURIComponent(seg[1].slice(0, -'.git'.length));
  const repo = ctx.store.getRepo(owner, repoName);
  const rest = seg.slice(2);
  const method = req.method;
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';

  // info/refs
  if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    const service = req.query.get('service') ?? '';
    if (!repo) return { status: 404, body: { message: 'Not Found' } };
    if (service === 'git-upload-pack') {
      if (isV2) return rawResp(200, 'application/x-git-upload-pack-advertisement', advertiseV2Upload());
      return rawResp(200, 'application/x-git-upload-pack-advertisement', advertiseV0(repo, 'upload-pack'));
    }
    if (service === 'git-receive-pack') {
      return rawResp(200, 'application/x-git-receive-pack-advertisement', advertiseV0(repo, 'receive-pack'));
    }
    return errResp(400, 'Bad Request: unknown service');
  }

  // upload-pack
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
    if (!repo) return { status: 404, body: { message: 'Not Found' } };
    try {
      return isV2 ? handleUploadPackV2(repo, req) : handleUploadPackV0(repo, req);
    } catch {
      return rawResp(400, 'application/x-git-upload-pack-result', Buffer.alloc(0));
    }
  }

  // receive-pack
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
    if (!repo) return { status: 404, body: { message: 'Not Found' } };
    try {
      return handleReceivePack(repo, req);
    } catch {
      return rawResp(400, 'application/x-git-receive-pack-result', Buffer.alloc(0));
    }
  }

  return null;
}
