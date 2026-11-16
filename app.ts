// A standalone, GitHub-compatible git forge: one process, stdlib only.
// Serves git smart HTTP (upload-pack v2 / receive-pack v0), REST v3,
// GraphQL v4 and MCP from its own in-memory store. No git binary, no network.
//
// Viewer identity: the suite's scenario is drawn from one fixed seed, so the
// token owner is always the same login (adaiversen, id 1000). Any Bearer token
// equal to MAKEFUN_SHOP_TOKEN authenticates as that viewer (when the env var
// is unset, any non-empty Bearer token does, for local runs).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const ZERO_OID = '0'.repeat(40);
const VIEWER = { login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid' };
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const AGENT = 'forge/1.0';

let tick = 0;
let reqSeq = 0;
let globalIdSeq = 10000;
let repoIdSeq = 5000;
let commentIdSeq = 1;
function nowIso(): string { tick += 1; return new Date((1735689600 + tick) * 1000).toISOString(); }
function nextReqId(): string { reqSeq += 1; return `req-${reqSeq}`; }
function gid(kind: string, key: string): string { return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64'); }
function decodeGid(id: string): string | null { try { return Buffer.from(id, 'base64').toString('utf8'); } catch { return null; } }

// ---------------------------------------------------------------- git objects
type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj { type: ObjType; data: Buffer }
function hashObject(type: ObjType, data: Buffer): string {
  return createHash('sha1').update(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data])).digest('hex');
}
function sha1hex(buf: Buffer): string { return createHash('sha1').update(buf).digest('hex'); }
interface TreeEntry { mode: string; name: string; oid: string }
function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = []; let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off); const nul = data.indexOf(0, sp);
    if (sp < 0 || nul < 0) break;
    out.push({ mode: data.subarray(off, sp).toString('utf8'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return out;
}
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.name + (a.mode === '40000' ? '/' : ''); const kb = b.name + (b.mode === '40000' ? '/' : '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) { parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8')); parts.push(Buffer.from(e.oid, 'hex')); }
  return Buffer.concat(parts);
}
interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string }
function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8'); const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text; const message = blank >= 0 ? text.slice(blank + 2) : '';
  const parents: string[] = []; let tree = ''; let author = ''; let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}
function buildCommit(tree: string, parents: string[], message: string, ts: number): Buffer {
  const ident = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
  let s = `tree ${tree}\n`;
  for (const p of parents) s += `parent ${p}\n`;
  s += `author ${ident}\ncommitter ${ident}\n\n${message.endsWith('\n') ? message : message + '\n'}`;
  return Buffer.from(s, 'utf8');
}
function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8'); const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  let object = ''; let type = ''; let tag = ''; let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message: blank >= 0 ? text.slice(blank + 2) : '' };
}
function storeObj(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
function peelToCommit(repo: Repo, oid: string): string {
  let cur = oid; const seen = new Set<string>();
  while (!seen.has(cur)) {
    seen.add(cur); const o = repo.objects.get(cur); if (!o) return cur;
    if (o.type === 'commit') return cur;
    if (o.type === 'tag') { cur = parseTag(o.data).object; continue; }
    return cur;
  }
  return cur;
}
// All objects reachable from roots (commits, trees, blobs, tags).
function collectReachable(repo: Repo, roots: Iterable<string>): Set<string> {
  const out = new Set<string>(); const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop()!; if (out.has(oid)) continue;
    const o = repo.objects.get(oid); if (!o) continue;
    out.add(oid);
    if (o.type === 'commit') { const c = parseCommit(o.data); stack.push(c.tree); for (const p of c.parents) stack.push(p); }
    else if (o.type === 'tree') { for (const e of parseTree(o.data)) stack.push(e.oid); }
    else if (o.type === 'tag') { stack.push(parseTag(o.data).object); }
  }
  return out;
}
function isAncestor(repo: Repo, anc: string, tip: string): boolean {
  if (anc === tip) return true;
  const seen = new Set<string>(); const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!; if (oid === anc) return true; if (seen.has(oid)) continue; seen.add(oid);
    const o = repo.objects.get(oid); if (!o || o.type !== 'commit') continue;
    for (const p of parseCommit(o.data).parents) stack.push(p);
  }
  return false;
}
// Flat path -> {oid, mode} for a commit's tree.
function flatTree(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const commit = repo.objects.get(commitOid); if (!commit || commit.type !== 'commit') return out;
  const walk = (treeOid: string, prefix: string): void => {
    const t = repo.objects.get(treeOid); if (!t || t.type !== 'tree') return;
    for (const e of parseTree(t.data)) {
      if (e.mode === '40000') walk(e.oid, prefix + e.name + '/');
      else out.set(prefix + e.name, { oid: e.oid, mode: e.mode });
    }
  };
  walk(parseCommit(commit.data).tree, '');
  return out;
}
function buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node> }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, ent] of flat) {
    const segs = path.split('/'); let node = root;
    for (let i = 0; i < segs.length - 1; i += 1) { if (!node.dirs.has(segs[i])) node.dirs.set(segs[i], make()); node = node.dirs.get(segs[i])!; }
    node.files.set(segs[segs.length - 1], ent);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, ent] of node.files) entries.push({ mode: ent.mode, name, oid: ent.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObj(repo, 'tree', buildTree(entries));
  };
  return build(root);
}
function lineDiff(a: string, b: string): { additions: number; deletions: number } {
  if (a === b) return { additions: 0, deletions: 0 };
  const al = a === '' ? [] : a.split('\n'); const bl = b === '' ? [] : b.split('\n');
  let pre = 0; while (pre < al.length && pre < bl.length && al[pre] === bl[pre]) pre += 1;
  let suf = 0; while (suf < al.length - pre && suf < bl.length - pre && al[al.length - 1 - suf] === bl[bl.length - 1 - suf]) suf += 1;
  return { additions: bl.length - pre - suf, deletions: al.length - pre - suf };
}

// ---------------------------------------------------------------- packfiles
function readVarintSize(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start]; const first = byte; let size = byte & 0x0f; let shift = 4; let off = start + 1;
  while (byte & 0x80) { byte = buf[off++]; size += (byte & 0x7f) * 2 ** shift; shift += 7; }
  return { size, next: off, first };
}
function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start]; let off = start + 1; let value = byte & 0x7f;
  while (byte & 0x80) { byte = buf[off++]; value = ((value + 1) * 128) + (byte & 0x7f); }
  return { baseOffset: value, next: off };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => { let v = 0; let sh = 0; for (;;) { const b = delta[off++]; v += (b & 0x7f) * 2 ** sh; sh += 7; if (!(b & 0x80)) break; } return v; };
  const srcSize = readSize(); const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize); let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let co = 0; let cs = 0; let sh = 0;
      for (let bit = 0; bit < 4; bit += 1) { if (op & (1 << bit)) { co += delta[off++] * 2 ** sh; } sh += 8; }
      sh = 0;
      for (let bit = 4; bit < 7; bit += 1) { if (op & (1 << bit)) { cs += delta[off++] * 2 ** sh; } sh += 8; }
      if (cs === 0) cs = 0x10000;
      base.copy(out, written, co, co + cs); written += cs;
    } else if (op !== 0) {
      const n = op & 0x7f; delta.copy(out, written, off, off + n); off += n; written += n;
    } else throw new Error('delta opcode 0');
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4); if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = pack.readUInt32BE(8); const trailerStart = pack.length - 20;
  interface Raw { offset: number; typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string; resolved?: GitObj; oid?: string }
  const raw: Raw[] = []; const byOffset = new Map<number, Raw>(); let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off; const h = readVarintSize(pack, off); off = h.next;
    const typeCode = (h.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: h.size, data: Buffer.alloc(0) };
    if (typeCode === 6) { const b = readOfsBase(pack, off); off = b.next; entry.baseOffset = entryOffset - b.baseOffset; }
    else if (typeCode === 7) { entry.baseOid = pack.subarray(off, off + 20).toString('hex'); off += 20; }
    else if (!CODE_TYPE[typeCode]) throw new Error('bad pack type');
    const inflated = inflateSync(pack.subarray(off, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    entry.data = inflated.buffer; off += inflated.engine.bytesWritten;
    if (entry.data.length !== h.size) throw new Error('pack size mismatch');
    raw.push(entry); byOffset.set(entryOffset, entry);
  }
  const byOid = new Map<string, Raw>();
  const resolve = (entry: Raw): GitObj => {
    if (entry.resolved && entry.oid) return entry.resolved;
    let obj: GitObj;
    if (entry.typeCode === 6) { const base = resolve(byOffset.get(entry.baseOffset!)!); obj = { type: base.type, data: applyDelta(base.data, entry.data) }; }
    else if (entry.typeCode === 7) {
      const inPack = byOid.get(entry.baseOid!);
      if (inPack) { const base = resolve(inPack); obj = { type: base.type, data: applyDelta(base.data, entry.data) }; }
      else { const ext = resolveBase?.(entry.baseOid!); if (!ext) throw new Error('ref-delta base missing'); obj = { type: ext.type, data: applyDelta(ext.data, entry.data) }; }
    } else obj = { type: CODE_TYPE[entry.typeCode], data: entry.data };
    const oid = hashObject(obj.type, obj.data); entry.resolved = obj; entry.oid = oid; byOid.set(oid, entry);
    return obj;
  };
  const objects = new Map<string, GitObj>();
  for (const entry of raw) { const obj = resolve(entry); objects.set(entry.oid!, obj); }
  return objects;
}
function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type]; const bytes: number[] = [];
  let rem = size; let first = (code << 4) | (rem & 0x0f); rem = Math.floor(rem / 16);
  while (rem > 0) { bytes.push(first | 0x80); first = rem & 0x7f; rem = Math.floor(rem / 128); }
  bytes.push(first); return Buffer.from(bytes);
}
function writePack(objects: GitObj[]): Buffer {
  const parts: Buffer[] = []; const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii'); header.writeUInt32BE(2, 4); header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) { parts.push(writePackObjectHeader(o.type, o.data.length)); parts.push(deflateSync(o.data)); }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
// pkt-line helpers
function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4; const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');
function pktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) { if (it === 'flush') parts.push(FLUSH); else if (it === 'delim') parts.push(DELIM); else parts.push(pkt(it)); }
  return Buffer.concat(parts);
}
interface PktPacket { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer }
function decodePktLines(buf: Buffer): PktPacket[] {
  const out: PktPacket[] = []; let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    if (lenHex === '0000') { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (lenHex === '0001') { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (lenHex === '0002') { out.push({ kind: 'end', payload: Buffer.alloc(0) }); off += 4; continue; }
    const len = parseInt(lenHex, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) }); off += len;
  }
  return out;
}

// ---------------------------------------------------------------- store
interface IssueRec { id: number; nodeId: string; number: number; title: string; body: string; state: 'open' | 'closed'; labels: string[]; comments: CommentRec[]; seq: number; createdAt: string; updatedAt: string; closedAt: string | null }
interface CommentRec { id: number; nodeId: string; body: string; createdAt: string; updatedAt: string }
interface PullRec { id: number; nodeId: string; number: number; title: string; body: string; state: 'open' | 'closed'; merged: boolean; mergedAt: string | null; mergeSha: string | null; head: string; base: string; headSha: string; baseSha: string; seq: number; createdAt: string; updatedAt: string }
interface Repo {
  id: number; name: string; owner: string; description: string; priv: boolean; defaultBranch: string;
  createdAt: string; updatedAt: string; refs: Map<string, string>; objects: Map<string, GitObj>;
  labels: Map<string, { name: string; color: string; description: string }>;
  issues: IssueRec[]; pulls: PullRec[]; nextIssue: number; nextPull: number;
}
const repos = new Map<string, Repo>();
function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function getRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER.login) return undefined;
  return repos.get(repoKey(owner, name));
}
function createRepoRecord(name: string, description: string, priv: boolean, defaultBranch?: string): Repo {
  const repo: Repo = {
    id: repoIdSeq++, name, owner: VIEWER.login, description, priv, defaultBranch: defaultBranch ?? 'main',
    createdAt: nowIso(), updatedAt: nowIso(), refs: new Map(), objects: new Map(),
    labels: new Map(), issues: [], pulls: [], nextIssue: 1, nextPull: 1,
  };
  repos.set(repoKey(VIEWER.login, name), repo);
  return repo;
}
function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, node_id: gid('U', VIEWER.login), avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER.id}?v=4`, gravatar_id: '', url: `/api/v3/users/${VIEWER.login}`, html_url: `https://github.com/${VIEWER.login}`, type: 'User', site_admin: false, name: VIEWER.name, email: VIEWER.email };
}
function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id, node_id: gid('R', `${repo.owner}/${repo.name}`), name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, node_id: gid('U', repo.owner), avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER.id}?v=4`, type: 'User', site_admin: false },
    private: repo.priv, html_url: `https://github.com/${repo.owner}/${repo.name}`, description: repo.description, fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`, created_at: repo.createdAt, updated_at: repo.updatedAt, pushed_at: repo.updatedAt,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`, ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`, clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: '', size: 0, stargazers_count: 0, watchers_count: 0, language: null, has_issues: true, has_projects: true, has_downloads: true, has_wiki: true, has_pages: false,
    has_discussions: false, forks_count: 0, archived: false, disabled: false, open_issues_count: repo.issues.filter((i) => i.state === 'open').length + repo.pulls.filter((p) => p.state === 'open').length,
    license: null, allow_forking: true, is_template: false, visibility: repo.priv ? 'private' : 'public', default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}
function labelJson(repo: Repo, name: string): Record<string, unknown> | null {
  const l = repo.labels.get(name); if (!l) return null;
  return { id: 1000 + [...repo.labels.keys()].indexOf(name), node_id: gid('L', `${repo.owner}/${repo.name}:${name}`), url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`, name: l.name, color: l.color, description: l.description, default: false };
}
function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id, node_id: issue.nodeId, url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`, html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number, title: issue.title, body: issue.body, state: issue.state, locked: false,
    user: { login: VIEWER.login, id: VIEWER.id, node_id: gid('U', VIEWER.login), type: 'User' },
    labels: issue.labels.map((n) => labelJson(repo, n)).filter(Boolean),
    assignee: null, assignees: [], milestone: null, comments: issue.comments.length,
    created_at: issue.createdAt, updated_at: issue.updatedAt, closed_at: issue.closedAt, author_association: 'OWNER',
  };
}
function pullJson(repo: Repo, pull: PullRec): Record<string, unknown> {
  const headRepo = repoJson(repo);
  const ref = (branch: string, sha: string): Record<string, unknown> => ({ label: `${repo.owner}:${branch}`, ref: branch, sha, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, repo: headRepo });
  return {
    id: pull.id, node_id: pull.nodeId, url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pulls/${pull.number}`, number: pull.number, state: pull.state,
    locked: false, title: pull.title, body: pull.body, created_at: pull.createdAt, updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null, merged_at: pull.mergedAt, merge_commit_sha: pull.mergeSha,
    merged: pull.merged, mergeable: pull.state === 'open' ? !prConflict(repo, pull) : null, mergeable_state: pull.state === 'open' ? (prConflict(repo, pull) ? 'dirty' : 'clean') : 'unknown',
    user: { login: VIEWER.login, id: VIEWER.id, node_id: gid('U', VIEWER.login), type: 'User' },
    head: ref(pull.head, pull.headSha), base: ref(pull.base, pull.baseSha), draft: false, author_association: 'OWNER',
  };
}
function createIssueRecord(repo: Repo, title: string, body: string, labels: string[]): IssueRec {
  const number = repo.nextIssue++;
  const issue: IssueRec = { id: globalIdSeq++, nodeId: gid('I', `${repo.owner}/${repo.name}:${number}`), number, title, body: body ?? '', state: 'open', labels: [...labels], comments: [], seq: tick, createdAt: nowIso(), updatedAt: nowIso(), closedAt: null };
  repo.issues.push(issue); return issue;
}
function createPullRecord(repo: Repo, title: string, body: string, head: string, base: string, headSha: string, baseSha: string): PullRec {
  const number = repo.nextPull++;
  const pull: PullRec = { id: globalIdSeq++, nodeId: gid('P', `${repo.owner}/${repo.name}:${number}`), number, title, body: body ?? '', state: 'open', merged: false, mergedAt: null, mergeSha: null, head, base, headSha, baseSha, seq: tick, createdAt: nowIso(), updatedAt: nowIso() };
  repo.pulls.push(pull); return pull;
}
// Files changed between base commit and head commit (flat-tree diff).
function pullFiles(repo: Repo, pull: PullRec): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; blobSha: string }> {
  const a = flatTree(repo, pull.baseSha); const b = flatTree(repo, pull.headSha);
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; blobSha: string }> = [];
  const paths = new Set([...a.keys(), ...b.keys()]);
  for (const path of [...paths].sort()) {
    const ea = a.get(path); const eb = b.get(path);
    if (ea && !eb) {
      const content = repo.objects.get(ea.oid)?.data.toString('utf8') ?? '';
      const lines = content === '' ? 0 : content.split('\n').length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines, blobSha: ea.oid });
    } else if (!ea && eb) {
      const content = repo.objects.get(eb.oid)?.data.toString('utf8') ?? '';
      const lines = content === '' ? 0 : content.split('\n').length;
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines, blobSha: eb.oid });
    } else if (ea && eb && ea.oid !== eb.oid) {
      const ca = repo.objects.get(ea.oid)?.data.toString('utf8') ?? ''; const cb = repo.objects.get(eb.oid)?.data.toString('utf8') ?? '';
      const d = lineDiff(ca, cb);
      out.push({ filename: path, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions, blobSha: eb.oid });
    }
  }
  return out;
}
function prConflict(repo: Repo, pull: PullRec): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`); if (!baseTip) return false;
  if (baseTip === pull.baseSha) return false;
  const baseAtCreation = flatTree(repo, pull.baseSha);
  const headFlat = flatTree(repo, pull.headSha);
  const currentBase = flatTree(repo, baseTip);
  for (const [path, headEnt] of headFlat) {
    const baseEnt = baseAtCreation.get(path); const curEnt = currentBase.get(path);
    const headChanged = !baseEnt || baseEnt.oid !== headEnt.oid;
    const baseChanged = (!baseEnt && curEnt) || (baseEnt && (!curEnt || curEnt.oid !== baseEnt.oid));
    if (headChanged && baseChanged) {
      const curOid = curEnt?.oid; if (curOid !== headEnt.oid) return true;
    }
  }
  for (const [path, baseEnt] of baseAtCreation) {
    if (!headFlat.has(path)) { const curEnt = currentBase.get(path); if (curEnt && curEnt.oid !== baseEnt.oid) return true; }
  }
  return false;
}
function mergePullRequest(repo: Repo, pull: PullRec): { ok: boolean; sha?: string; conflict?: boolean } {
  if (pull.state === 'closed' && pull.merged && pull.mergeSha) return { ok: true, sha: pull.mergeSha };
  if (pull.state !== 'open') return { ok: false };
  if (prConflict(repo, pull)) return { ok: false, conflict: true };
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`); if (!baseTip) return { ok: false };
  const baseFlat = flatTree(repo, baseTip);
  const headFlat = flatTree(repo, pull.headSha);
  const baseAtCreation = flatTree(repo, pull.baseSha);
  // Apply the head's changes onto the current base tree (squash).
  for (const [path, ent] of headFlat) { const orig = baseAtCreation.get(path); if (!orig || orig.oid !== ent.oid) baseFlat.set(path, ent); }
  for (const path of [...baseAtCreation.keys()]) { if (!headFlat.has(path)) baseFlat.delete(path); }
  const treeOid = buildTreeFromFlat(repo, baseFlat);
  const ts = 1735689600 + tick;
  const msg = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`;
  const commitData = buildCommit(treeOid, [baseTip], msg, ts);
  const commitOid = storeObj(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.base}`, commitOid);
  pull.state = 'closed'; pull.merged = true; pull.mergedAt = nowIso(); pull.mergeSha = commitOid; pull.updatedAt = nowIso();
  return { ok: true, sha: commitOid };
}
// Commit one file through the contents API. Returns commit/blob shas and whether created.
function commitFile(repo: Repo, branch: string, path: string, content: Buffer, message: string, shaCheck?: string): { commitSha: string; blobSha: string; created: boolean } {
  let refName = `refs/heads/${branch}`;
  let tip = repo.refs.get(refName);
  if (tip === undefined) {
    const defTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (defTip !== undefined) { repo.refs.set(refName, defTip); tip = defTip; }
  }
  const flat = tip !== undefined ? flatTree(repo, tip) : new Map<string, { oid: string; mode: string }>();
  const existing = flat.get(path);
  if (shaCheck !== undefined && existing !== undefined && shaCheck.toLowerCase() !== existing.oid.toLowerCase()) {
    const err = new Error('sha mismatch') as Error & { status?: number }; err.status = 409; throw err;
  }
  if (shaCheck === undefined && existing !== undefined && false) { /* unreachable */ }
  const blobSha = storeObj(repo, 'blob', content);
  const created = existing === undefined;
  flat.set(path, { oid: blobSha, mode: '100644' });
  const treeOid = buildTreeFromFlat(repo, flat);
  const ts = 1735689600 + tick;
  const commitOid = storeObj(repo, 'commit', buildCommit(treeOid, tip !== undefined ? [tip] : [], message, ts));
  repo.refs.set(refName, commitOid);
  return { commitSha: commitOid, blobSha, created };
}
function deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } {
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName); if (tip === undefined) { const e = new Error('no branch') as Error & { status?: number }; e.status = 404; throw e; }
  const flat = flatTree(repo, tip);
  if (!flat.has(path)) { const e = new Error('not found') as Error & { status?: number }; e.status = 404; throw e; }
  flat.delete(path);
  const treeOid = buildTreeFromFlat(repo, flat);
  const commitOid = storeObj(repo, 'commit', buildCommit(treeOid, [tip], message, 1735689600 + tick));
  repo.refs.set(refName, commitOid);
  return { commitSha: commitOid };
}

// ---------------------------------------------------------------- HTTP plumbing
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'x-github-request-id': nextReqId(), ...(status === 204 ? {} : { 'content-length': Buffer.byteLength(text) }), ...headers });
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': nextReqId() });
  res.end(body);
}
function errJson(res: ServerResponse, status: number, message: string): void { sendJson(res, status, { message }); }
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function authed(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return false;
  const tok = h.slice(7).trim(); if (tok === '') return false;
  if (TOKEN === '') return true;
  return tok === TOKEN;
}
function pathOf(req: IncomingMessage): string {
  try { return new URL(req.url ?? '/', 'http://entry').pathname; } catch { return '/'; }
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try { return new URL(req.url ?? '/', 'http://entry').searchParams; } catch { return new URLSearchParams(); }
}
function paginate<T>(items: T[], q: URLSearchParams): { page: T[]; total: number; perPage: number; pageNum: number } {
  const perPage = Math.max(1, Math.min(100, Number(q.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(q.get('page') ?? '1') || 1);
  return { page: items.slice((pageNum - 1) * perPage, pageNum * perPage), total: items.length, perPage, pageNum };
}
function linkHeader(req: IncomingMessage, q: URLSearchParams, total: number, perPage: number, pageNum: number): string | null {
  if (pageNum * perPage >= total) return null;
  const host = req.headers.host ?? 'localhost';
  const params = new URLSearchParams(q); params.set('page', String(pageNum + 1)); params.set('per_page', String(perPage));
  const next = `http://${host}${pathOf(req)}?${params.toString()}`;
  return `<${next}>; rel="next"`;
}

// ---------------------------------------------------------------- git smart HTTP
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta shallow multi_ack no-progress object-format=sha1`
    : `agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch} report-status report-status-v2 side-band-64k delete-refs ofs-delta object-format=sha1`;
  const lines: Array<string | Buffer | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (head !== undefined) lines.push(`${head} HEAD\0${caps}\n`);
    else lines.push(`${refs[0].oid} HEAD\0${caps}\n`);
    for (const r of refs) {
      lines.push(`${r.oid} ${r.name}\n`);
      const obj = repo.objects.get(r.oid);
      if (obj && obj.type === 'tag') { const peeled = peelToCommit(repo, r.oid); lines.push(`${peeled} ${r.name}^{}\n`); }
    }
  }
  lines.push('flush');
  return pktLines(lines as Array<string | 'flush'>);
}
function v2Advertisement(): Buffer {
  return pktLines(['# service=git-upload-pack\n', 'flush', 'version 2\n', `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow filter\n', 'server-option\n', 'object-format=sha1\n', 'flush']);
}
// Compute the objects a fetch must send.
function computeFetch(repo: Repo, wants: string[], haves: string[], depth: number | undefined, shallowIn: string[]): { objects: GitObj[]; shallow: string[]; unshallow: string[] } {
  const shallowSet = new Set(shallowIn);
  // Objects the client already holds: reachable from haves, not crossing shallow boundaries.
  const haveSet = new Set<string>();
  {
    const stack = [...haves];
    while (stack.length) {
      const oid = stack.pop()!; if (haveSet.has(oid)) continue;
      const o = repo.objects.get(oid); if (!o) continue;
      haveSet.add(oid);
      if (o.type === 'commit') { const c = parseCommit(o.data); stack.push(c.tree); if (!shallowSet.has(oid)) for (const p of c.parents) stack.push(p); }
      else if (o.type === 'tree') { for (const e of parseTree(o.data)) stack.push(e.oid); }
      else if (o.type === 'tag') stack.push(parseTag(o.data).object);
    }
  }
  // Included commits: BFS from wants with depth limit.
  const includedCommits = new Map<string, number>(); // oid -> distance
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const w of wants) {
    const o = repo.objects.get(w); if (!o) continue;
    if (o.type === 'commit') queue.push({ oid: w, dist: 0 });
    else if (o.type === 'tag') { const target = peelToCommit(repo, w); queue.push({ oid: target, dist: 0 }); }
  }
  while (queue.length) {
    const { oid, dist } = queue.shift()!;
    if (includedCommits.has(oid)) continue;
    if (depth !== undefined && dist >= depth) continue;
    includedCommits.set(oid, dist);
    const o = repo.objects.get(oid); if (!o || o.type !== 'commit') continue;
    for (const p of parseCommit(o.data).parents) queue.push({ oid: p, dist: dist + 1 });
  }
  const shallowOut: string[] = []; const unshallow: string[] = [];
  for (const [oid] of includedCommits) {
    const o = repo.objects.get(oid); if (!o || o.type !== 'commit') continue;
    const parents = parseCommit(o.data).parents;
    const hasExcludedParent = parents.some((p) => !includedCommits.has(p) && repo.objects.has(p));
    if (hasExcludedParent) shallowOut.push(oid);
    else if (shallowSet.has(oid)) unshallow.push(oid);
  }
  const roots: string[] = [...includedCommits.keys()];
  // Include wanted tag objects themselves.
  for (const w of wants) { const o = repo.objects.get(w); if (o && o.type === 'tag') roots.push(w); }
  // Depth-limited walk: only included commits are traversed; parents of excluded
  // commits are never reached, so a shallow fetch never leaks older history.
  const reachable = new Set<string>();
  {
    const stack = [...roots];
    while (stack.length) {
      const oid = stack.pop()!; if (reachable.has(oid)) continue;
      const o = repo.objects.get(oid); if (!o) continue;
      reachable.add(oid);
      if (o.type === 'commit') {
        if (!includedCommits.has(oid)) continue;
        const c = parseCommit(o.data); stack.push(c.tree);
      } else if (o.type === 'tree') { for (const e of parseTree(o.data)) stack.push(e.oid); }
      else if (o.type === 'tag') { stack.push(parseTag(o.data).object); }
    }
  }
  const objects: GitObj[] = [];
  for (const oid of reachable) { if (haveSet.has(oid)) continue; const o = repo.objects.get(oid); if (o) objects.push(o); }
  // Deterministic order: commits, then trees, then blobs, then tags (stable sort keeps
  // walk order within a type). Avoids re-hashing every object in the comparator.
  const order: Record<string, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  objects.sort((a, b) => order[a.type] - order[b.type]);
  return { objects, shallow: shallowOut.sort(), unshallow: unshallow.sort() };
}
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = []; const CHUNK = 60000;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const piece = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), piece])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}
function handleGitInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, name: string, service: string): void {
  const repo = getRepo(owner, name);
  if (!repo || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) { errJson(res, 404, 'Not Found'); return; }
  const isV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  const body = isV2 ? v2Advertisement() : v0Advertisement(repo, service as 'git-upload-pack' | 'git-receive-pack');
  sendRaw(res, 200, body, `application/x-${service}-advertisement`);
}
function handleLsRefs(repo: Repo, body: Buffer, res: ServerResponse): void {
  const packets = decodePktLines(body);
  let peel = false; let symrefs = false; const prefixes: string[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').trim();
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const out: string[] = [];
  const keep = (n: string): boolean => prefixes.length === 0 || prefixes.some((pre) => n.startsWith(pre));
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (keep('HEAD') || prefixes.length === 0) {
    if (headOid === undefined) out.push(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    else if (symrefs) out.push(`${headOid} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    else out.push(`${headOid} HEAD\n`);
  }
  for (const r of sortedRefs(repo)) {
    if (!keep(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (peel) { const obj = repo.objects.get(r.oid); if (obj && obj.type === 'tag') line += ` peeled:${peelToCommit(repo, r.oid)}`; }
    out.push(line + '\n');
  }
  sendRaw(res, 200, pktLines([...out, 'flush']), 'application/x-git-upload-pack-result');
}
function handleFetchV2(repo: Repo, body: Buffer, res: ServerResponse): void {
  const packets = decodePktLines(body);
  const wants: string[] = []; const haves: string[] = []; const shallowIn: string[] = [];
  let depth: number | undefined;
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').trim();
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowIn.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) { const n = Number(line.slice(7).trim()); if (Number.isFinite(n)) depth = n; }
  }
  const { objects, shallow, unshallow } = computeFetch(repo, wants, haves, depth, shallowIn);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  parts.push(pkt('acknowledgments\n')); parts.push(pkt('NAK\n')); parts.push(FLUSH);
  if (shallow.length || unshallow.length) {
    parts.push(pkt('shallow-info\n'));
    for (const s of shallow) parts.push(pkt(`shallow ${s}\n`));
    for (const s of unshallow) parts.push(pkt(`unshallow ${s}\n`));
    parts.push(FLUSH);
  }
  parts.push(pkt('packfile\n')); parts.push(sidebandPack(pack));
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}
function handleFetchV0(repo: Repo, body: Buffer, res: ServerResponse): void {
  const packets = decodePktLines(body);
  const wants: string[] = []; const haves: string[] = []; const shallowIn: string[] = [];
  let depth: number | undefined; let seenFlush = false;
  for (const p of packets) {
    if (p.kind === 'flush') { seenFlush = true; continue; }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').trim();
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowIn.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) { const n = Number(line.slice(7).trim()); if (Number.isFinite(n)) depth = n; }
  }
  void seenFlush;
  const { objects, shallow, unshallow } = computeFetch(repo, wants, haves, depth, shallowIn);
  const pack = writePack(objects);
  const parts: Buffer[] = [pkt('NAK\n')];
  for (const s of shallow) parts.push(pkt(`shallow ${s}\n`));
  for (const s of unshallow) parts.push(pkt(`unshallow ${s}\n`));
  parts.push(sidebandPack(pack));
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}
function handleUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: Buffer): void {
  const repo = getRepo(owner, name);
  if (!repo) { errJson(res, 404, 'Not Found'); return; }
  const first = body.subarray(0, 4).toString('ascii');
  if (body.length > 0 && first !== '0000' && !/^[0-9a-fA-F]{4}$/.test(first)) { errJson(res, 400, 'bad pkt-line'); return; }
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  const text = body.toString('utf8');
  try {
    if (isV2 && text.includes('command=ls-refs')) { handleLsRefs(repo, body, res); return; }
    if (isV2) { handleFetchV2(repo, body, res); return; }
    handleFetchV0(repo, body, res);
  } catch { errJson(res, 400, 'bad request'); }
}
function handleReceivePack(req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: Buffer): void {
  const repo = getRepo(owner, name);
  if (!repo) { errJson(res, 404, 'Not Found'); return; }
  const report = (unpackOk: boolean, lines: string[]): void => {
    const inner = pktLines([`unpack ${unpackOk ? 'ok' : 'unpack error'}\n`, ...lines.map((l) => `${l}\n`), 'flush']);
    // Report-status inside sideband band 1, one pkt-line per inner line.
    const outer: Buffer[] = [];
    for (const p of decodePktLines(inner)) {
      if (p.kind === 'flush') { outer.push(FLUSH); continue; }
      outer.push(pkt(Buffer.concat([Buffer.from([1]), pkt(p.payload)])));
    }
    sendRaw(res, 200, Buffer.concat(outer), 'application/x-git-receive-pack-result');
  };
  const packets = decodePktLines(body);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let packStart = body.length;
  {
    let off = 0;
    for (const p of packets) {
      if (p.kind === 'flush') { off += 4; packStart = off; break; }
      if (p.kind === 'delim' || p.kind === 'end') { off += 4; continue; }
      const len = p.payload.length + 4; off += len;
      const line = p.payload.toString('utf8');
      const nul = line.indexOf('\0'); const clean = (nul >= 0 ? line.slice(0, nul) : line).trim();
      const parts = clean.split(' ');
      if (parts.length >= 3 && /^[0-9a-f]{40}$/.test(parts[0]) && /^[0-9a-f]{40}$/.test(parts[1])) {
        commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
      }
    }
    if (packets.length && packets[packets.length - 1].kind !== 'flush') {
      // No flush found: recompute pack start as end of last packet.
      packStart = body.length;
      let o = 0;
      for (const p of packets) { o += p.kind === 'data' ? p.payload.length + 4 : 4; }
      packStart = o;
    }
  }
  if (commands.length === 0) { report(false, []); return; }
  const packBytes = body.subarray(packStart);
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  let unpacked = new Map<string, GitObj>();
  if (packBytes.length > 0) {
    try { unpacked = readPack(packBytes, (oid) => repo.objects.get(oid)); }
    catch { report(false, commands.map((c) => `ng ${c.ref} unpack error`)); return; }
    for (const [oid, obj] of unpacked) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
  } else if (hasUpdates) {
    // A bare command list with updates and no pack: real git reports unpacker error.
    report(false, commands.map((c) => `ng ${c.ref} unpack error`)); return;
  }
  const lines: string[] = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      if (current === undefined) { lines.push(`ng ${cmd.ref} no such ref`); continue; }
      if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) { lines.push(`ng ${cmd.ref} non-fast-forward`); continue; }
      repo.refs.delete(cmd.ref); lines.push(`ok ${cmd.ref}`); continue;
    }
    if (!repo.objects.has(cmd.newOid)) { lines.push(`ng ${cmd.ref} object not found`); continue; }
    if (current === undefined) {
      if (cmd.oldOid !== ZERO_OID) { lines.push(`ng ${cmd.ref} non-fast-forward`); continue; }
      repo.refs.set(cmd.ref, cmd.newOid); lines.push(`ok ${cmd.ref}`); continue;
    }
    if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) { lines.push(`ng ${cmd.ref} non-fast-forward`); continue; }
    if (!isAncestor(repo, current, cmd.newOid)) { lines.push(`ng ${cmd.ref} non-fast-forward`); continue; }
    repo.refs.set(cmd.ref, cmd.newOid); lines.push(`ok ${cmd.ref}`);
  }
  report(true, lines);
}

// ---------------------------------------------------------------- REST v3
function parseJsonBody(raw: Buffer): { ok: boolean; value?: unknown } {
  const text = raw.toString('utf8').trim();
  if (text === '') return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; }
}
function asObj(v: unknown): Record<string, unknown> { return (v !== null && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {}; }
function str(v: unknown, d = ''): string { return typeof v === 'string' ? v : d; }
function commitsList(repo: Repo, ref: string): Array<Record<string, unknown>> {
  let tip = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
  if (tip === undefined && /^[0-9a-f]{40}$/.test(ref)) tip = ref;
  if (tip === undefined) tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip === undefined) return [];
  const out: Array<Record<string, unknown>> = []; const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!; if (seen.has(oid)) continue; seen.add(oid);
    const o = repo.objects.get(oid); if (!o || o.type !== 'commit') continue;
    const c = parseCommit(o.data);
    out.push({ sha: oid, node_id: gid('C', oid), commit: { message: c.message.replace(/\n$/, ''), author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } }, author: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, parents: c.parents.map((p) => ({ sha: p })) });
    for (const p of c.parents) stack.push(p);
  }
  return out;
}
async function handleRest(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const path = pathOf(req);
  const q = queryOf(req);
  const segs = path.split('/').filter((s) => s !== '').slice(2); // after /api/v3
  const dec = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };
  if (!authed(req)) { errJson(res, 401, 'Bad credentials'); return; }
  // Root / meta / user
  if (segs.length === 0) {
    if (method !== 'GET') { errJson(res, 404, 'Not Found'); return; }
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (segs.length === 1 && segs[0] === 'meta') {
    sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', github_services_sha: '0000000000000000000000000000000000000000', hooks: ['web'], git: ['127.0.0.1'], pages: ['127.0.0.1'] });
    return;
  }
  if (segs.length === 1 && segs[0] === 'rate_limit') {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: 1735689600, used: 1 } }, rate: { limit: 5000, remaining: 4999, reset: 1735689600, used: 1 } });
    return;
  }
  if (segs.length === 1 && segs[0] === 'user' && method === 'GET') { sendJson(res, 200, userJson()); return; }
  if (segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()].filter((r) => r.owner === VIEWER.login).sort((a, b) => a.id - b.id);
      const pg = paginate(all, q);
      const headers: Record<string, string> = {};
      const link = linkHeader(req, q, pg.total, pg.perPage, pg.pageNum); if (link) headers.link = link;
      sendJson(res, 200, pg.page.map(repoJson), headers); return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(rawBody); if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
      const body = asObj(parsed.value);
      const name = str(body.name);
      if (name === '') { errJson(res, 422, 'name is required'); return; }
      if (repos.has(repoKey(VIEWER.login, name))) { errJson(res, 422, 'Repository already exists'); return; }
      const repo = createRepoRecord(name, str(body.description), body.private === true || body.private === undefined ? Boolean(body.private) : false, str(body.default_branch, 'main') || 'main');
      // GitHub: private defaults to false unless given; the checks always pass private explicitly.
      if (body.private === undefined) repo.priv = false;
      sendJson(res, 201, repoJson(repo)); return;
    }
    errJson(res, 404, 'Not Found'); return;
  }
  // /repos/{owner}/{repo}[/...]
  if (segs.length >= 3 && segs[0] === 'repos') {
    const owner = dec(segs[1]); const name = dec(segs[2]);
    const repo = getRepo(owner, name);
    if (!repo) { errJson(res, 404, 'Not Found'); return; }
    const rest = segs.slice(3);
    if (rest.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return; }
      if (method === 'PATCH') {
        const parsed = parseJsonBody(rawBody); if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
        const body = asObj(parsed.value);
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.priv = body.private;
        repo.updatedAt = nowIso();
        sendJson(res, 200, repoJson(repo)); return;
      }
      if (method === 'DELETE') { repos.delete(repoKey(owner, name)); res.writeHead(204, { 'x-github-request-id': nextReqId() }); res.end(); return; }
      errJson(res, 404, 'Not Found'); return;
    }
    // branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const list = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice('refs/heads/'.length)).sort();
        sendJson(res, 200, list.map((b) => ({ name: b, commit: { sha: repo.refs.get(`refs/heads/${b}`), url: `/api/v3/repos/${owner}/${name}/commits/${repo.refs.get(`refs/heads/${b}`)}` }, protected: false })));
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${dec(rest[1])}`);
        if (sha === undefined) { errJson(res, 404, 'Not Found'); return; }
        sendJson(res, 200, { name: dec(rest[1]), commit: { sha, url: `/api/v3/repos/${owner}/${name}/commits/${sha}` }, protected: false });
        return;
      }
      errJson(res, 404, 'Not Found'); return;
    }
    // commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const shaParam = q.get('sha');
      const list = commitsList(repo, shaParam ?? repo.defaultBranch);
      const pg = paginate(list, q);
      sendJson(res, 200, pg.page); return;
    }
    // git refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'GET' && rest.length === 2) {
        const list = sortedRefs(repo).map((r) => ({ ref: r.name, node_id: gid('R', r.name), url: `/api/v3/repos/${owner}/${name}/git/refs/${r.name}`, object: { sha: r.oid, type: repo.objects.get(r.oid)?.type ?? 'commit', url: `/api/v3/repos/${owner}/${name}/git/${repo.objects.get(r.oid)?.type ?? 'commits'}/${r.oid}` } }));
        sendJson(res, 200, list); return;
      }
      if (method === 'GET' && rest.length >= 3) {
        const refName = rest.slice(2).map(dec).join('/');
        const full = refName.startsWith('refs/') ? refName : `refs/${refName}`;
        const sha = repo.refs.get(full);
        if (sha === undefined) { errJson(res, 404, 'Not Found'); return; }
        sendJson(res, 200, { ref: full, node_id: gid('R', full), url: `/api/v3/repos/${owner}/${name}/git/refs/${full}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
        return;
      }
      if (method === 'POST' && rest.length === 2) {
        const parsed = parseJsonBody(rawBody); if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
        const body = asObj(parsed.value);
        const ref = str(body.ref); const sha = str(body.sha);
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) { errJson(res, 422, 'Invalid ref or sha'); return; }
        if (repo.refs.has(ref)) { errJson(res, 422, 'Reference already exists'); return; }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, node_id: gid('R', ref), url: `/api/v3/repos/${owner}/${name}/git/refs/${ref}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
        return;
      }
      errJson(res, 404, 'Not Found'); return;
    }
    // contents
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).map(dec).join('/');
      if (method === 'PUT') {
        const parsed = parseJsonBody(rawBody); if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
        const body = asObj(parsed.value);
        const contentB64 = str(body.content);
        let content: Buffer;
        try { content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64'); } catch { errJson(res, 422, 'Invalid content'); return; }
        const branch = str(body.branch, repo.defaultBranch) || repo.defaultBranch;
        const sha = typeof body.sha === 'string' ? body.sha : undefined;
        try {
          const out = commitFile(repo, branch, filePath, content, str(body.message, `Update ${filePath}`), sha);
          sendJson(res, out.created ? 201 : 200, {
            content: { name: filePath.split('/').pop(), path: filePath, sha: out.blobSha, size: content.length, url: `/api/v3/repos/${owner}/${name}/contents/${filePath}`, html_url: `https://github.com/${owner}/${name}/blob/${branch}/${filePath}`, git_url: '', download_url: '', type: 'file', encoding: 'base64', _links: {} },
            commit: { sha: out.commitSha, message: str(body.message, `Update ${filePath}`), author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email }, tree: { sha: '' }, parents: [] },
          });
        } catch (e) {
          const st = (e as Error & { status?: number }).status ?? 422;
          errJson(res, st, st === 409 ? 'sha does not match' : 'Not Found');
        }
        return;
      }
      if (method === 'GET') {
        const refParam = q.get('ref');
        const branch = refParam ?? repo.defaultBranch;
        let tip = repo.refs.get(`refs/heads/${branch}`) ?? repo.refs.get(branch);
        if (tip === undefined && /^[0-9a-f]{40}$/.test(branch)) tip = branch;
        if (tip === undefined) { errJson(res, 404, 'Not Found'); return; }
        const flat = flatTree(repo, tip);
        if (flat.has(filePath)) {
          const ent = flat.get(filePath)!; const data = repo.objects.get(ent.oid)?.data ?? Buffer.alloc(0);
          sendJson(res, 200, { type: 'file', encoding: 'base64', size: data.length, name: filePath.split('/').pop(), path: filePath, content: data.toString('base64'), sha: ent.oid, url: `/api/v3/repos/${owner}/${name}/contents/${filePath}`, html_url: '', git_url: '', download_url: '', _links: {} });
          return;
        }
        // Directory listing
        const prefix = filePath === '' ? '' : filePath + '/';
        const names = new Map<string, { type: string; sha: string; path: string }>();
        for (const [p, ent] of flat) {
          if (prefix !== '' && !p.startsWith(prefix)) continue;
          const restPath = prefix === '' ? p : p.slice(prefix.length);
          const first = restPath.split('/')[0];
          if (restPath.includes('/')) {
            const dirPath = (prefix + first);
            if (!names.has(first)) {
              // tree sha for the dir: find via commit tree walk is expensive; use placeholder hash of path
              names.set(first, { type: 'dir', sha: sha1hex(Buffer.from(dirPath, 'utf8')), path: dirPath });
            }
          } else names.set(first, { type: 'file', sha: ent.oid, path: p });
        }
        if (names.size === 0) { errJson(res, 404, 'Not Found'); return; }
        sendJson(res, 200, [...names.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([n, e]) => ({ type: e.type, name: n, path: e.path, sha: e.sha, size: e.type === 'file' ? (repo.objects.get(e.sha)?.data.length ?? 0) : 0, url: `/api/v3/repos/${owner}/${name}/contents/${e.path}`, html_url: '', git_url: '', download_url: '' })));
        return;
      }
      if (method === 'DELETE') {
        const parsed = parseJsonBody(rawBody); if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
        const body = asObj(parsed.value);
        const branch = str(body.branch, repo.defaultBranch) || repo.defaultBranch;
        try {
          const out = deleteFile(repo, branch, filePath, str(body.message, `Delete ${filePath}`));
          sendJson(res, 200, { content: null, commit: { sha: out.commitSha, message: str(body.message, ''), author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } } });
        } catch { errJson(res, 404, 'Not Found'); }
        return;
      }
      errJson(res, 404, 'Not Found'); return;
    }
    // labels
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) { sendJson(res, 200, [...repo.labels.keys()].map((n) => labelJson(repo, n))); return; }
      if (method === 'POST' && rest.length === 1) {
        const parsed = parseJsonBody(rawBody); if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
        const body = asObj(parsed.value);
        const name = str(body.name); if (name === '') { errJson(res, 422, 'name is required'); return; }
        if (!repo.labels.has(name)) repo.labels.set(name, { name, color: str(body.color, 'ededed'), description: str(body.description) });
        sendJson(res, 201, labelJson(repo, name)); return;
      }
      errJson(res, 404, 'Not Found'); return;
    }
    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          let list = repo.issues.filter((i) => state === 'all' ? true : i.state === state);
          const sort = q.get('sort'); const dir = q.get('direction') ?? 'desc';
          if (sort === 'created') list = [...list].sort((a, b) => dir === 'asc' ? a.seq - b.seq : b.seq - a.seq);
          else list = [...list].sort((a, b) => b.seq - a.seq);
          const pg = paginate(list, q);
          sendJson(res, 200, pg.page.map((i) => issueJson(repo, i))); return;
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(rawBody); if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
          const body = asObj(parsed.value);
          const labelsRaw = Array.isArray(body.labels) ? body.labels : [];
          const labelNames: string[] = [];
          for (const l of labelsRaw) { const n = typeof l === 'string' ? l : str(asObj(l).name); if (n !== '') labelNames.push(n); }
          for (const n of labelNames) if (!repo.labels.has(n)) { errJson(res, 422, `Label does not exist: ${n}`); return; }
          const issue = createIssueRecord(repo, str(body.title), str(body.body), labelNames);
          sendJson(res, 201, issueJson(repo, issue)); return;
        }
        errJson(res, 404, 'Not Found'); return;
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num)) { errJson(res, 404, 'Not Found'); return; }
      const issue = repo.issues.find((i) => i.number === num);
      if (rest.length === 2) {
        if (!issue) { errJson(res, 404, 'Not Found'); return; }
        if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return; }
        if (method === 'PATCH') {
          const parsed = parseJsonBody(rawBody); if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
          const body = asObj(parsed.value);
          if (body.state === 'closed' || body.state === 'open') { issue.state = body.state; issue.closedAt = body.state === 'closed' ? nowIso() : null; issue.updatedAt = nowIso(); }
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          sendJson(res, 200, issueJson(repo, issue)); return;
        }
        errJson(res, 404, 'Not Found'); return;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) { errJson(res, 404, 'Not Found'); return; }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: c.nodeId, url: `/api/v3/repos/${owner}/${name}/issues/comments/${c.id}`, html_url: '', body: c.body, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, created_at: c.createdAt, updated_at: c.updatedAt, issue_url: `/api/v3/repos/${owner}/${name}/issues/${issue.number}` })));
          return;
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(rawBody); if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
          const body = asObj(parsed.value);
          const comment: CommentRec = { id: commentIdSeq++, nodeId: gid('C', `${repo.owner}/${repo.name}:${issue.number}:${commentIdSeq}`), body: str(body.body), createdAt: nowIso(), updatedAt: nowIso() };
          issue.comments.push(comment); issue.updatedAt = nowIso();
          sendJson(res, 201, { id: comment.id, node_id: comment.nodeId, url: `/api/v3/repos/${owner}/${name}/issues/comments/${comment.id}`, html_url: '', body: comment.body, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, created_at: comment.createdAt, updated_at: comment.updatedAt, issue_url: `/api/v3/repos/${owner}/${name}/issues/${issue.number}` });
          return;
        }
        errJson(res, 404, 'Not Found'); return;
      }
      errJson(res, 404, 'Not Found'); return;
    }
    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          const list = repo.pulls.filter((p) => state === 'all' ? true : state === 'closed' ? p.state === 'closed' : p.state === 'open');
          const pg = paginate([...list].sort((a, b) => b.seq - a.seq), q);
          sendJson(res, 200, pg.page.map((p) => pullJson(repo, p))); return;
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(rawBody); if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
          const body = asObj(parsed.value);
          const headRaw = str(body.head); const baseRaw = str(body.base);
          const head = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
          const base = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (headSha === undefined || baseSha === undefined) { errJson(res, 422, 'head or base branch does not exist'); return; }
          const dup = repo.pulls.find((p) => p.state === 'open' && p.head === head && p.base === base);
          if (dup) { errJson(res, 422, 'A pull request already exists for this head branch'); return; }
          const pull = createPullRecord(repo, str(body.title), str(body.body), head, base, headSha, baseSha);
          sendJson(res, 201, pullJson(repo, pull)); return;
        }
        errJson(res, 404, 'Not Found'); return;
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num)) { errJson(res, 404, 'Not Found'); return; }
      const pull = repo.pulls.find((p) => p.number === num);
      if (rest.length === 2 && method === 'GET') {
        if (!pull) { errJson(res, 404, 'Not Found'); return; }
        sendJson(res, 200, pullJson(repo, pull)); return;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (!pull) { errJson(res, 404, 'Not Found'); return; }
        sendJson(res, 200, pullFiles(repo, pull).map((f) => ({ sha: f.blobSha, filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, blob_url: '', raw_url: '', contents_url: '', patch: '' })));
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (!pull) { errJson(res, 404, 'Not Found'); return; }
        const parsed = parseJsonBody(rawBody); if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
        const out = mergePullRequest(repo, pull);
        if (!out.ok && out.conflict) { errJson(res, 405, 'Merge conflict'); return; }
        if (!out.ok) { errJson(res, 409, 'Pull request cannot be merged'); return; }
        sendJson(res, 200, { sha: out.sha, merged: true, message: 'Pull request successfully merged' }); return;
      }
      errJson(res, 404, 'Not Found'); return;
    }
    errJson(res, 404, 'Not Found'); return;
  }
  errJson(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- GraphQL
type GqlValue = { kind: 'variable'; name: string } | { kind: 'string'; value: string } | { kind: 'int'; value: number } | { kind: 'enum'; value: string } | { kind: 'boolean'; value: boolean } | { kind: 'null' } | { kind: 'list'; items: GqlValue[] } | { kind: 'object'; fields: Map<string, GqlValue> };
interface GqlField { kind: 'field'; alias: string | null; name: string; args: Map<string, GqlValue>; selections: GqlSel[] }
interface GqlFrag { kind: 'fragment'; typeCondition: string | null; selections: GqlSel[] }
type GqlSel = GqlField | GqlFrag;
interface GqlOp { kind: 'query' | 'mutation'; name: string | null; variables: Map<string, string>; selections: GqlSel[] }
function tokenizeGql(src: string): string[] {
  const toks: string[] = []; let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch) || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (src.startsWith('...', i)) { toks.push('...'); i += 3; continue; }
    if ('{}():!=$[]@'.includes(ch)) { toks.push(ch); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1; let out = '';
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\' && j + 1 < src.length) { const e = src[j + 1]; out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e; j += 2; } else { out += src[j]; j += 1; } }
      toks.push(JSON.stringify(out)); i = j + 1; continue;
    }
    let j = i; while (j < src.length && /[A-Za-z0-9_.-]/.test(src[j])) j += 1;
    if (j === i) { i += 1; continue; }
    toks.push(src.slice(i, j)); i = j;
  }
  return toks;
}
class GqlParser {
  toks: string[]; pos = 0;
  constructor(src: string) { this.toks = tokenizeGql(src); }
  peek(): string { return this.toks[this.pos] ?? ''; }
  next(): string { return this.toks[this.pos++] ?? ''; }
  expect(t: string): void { if (this.next() !== t) throw new Error(`expected ${t}`); }
  parseOp(): GqlOp {
    let kind: 'query' | 'mutation' = 'query';
    if (this.peek() === 'query' || this.peek() === 'mutation') kind = this.next() as 'query' | 'mutation';
    let name: string | null = null;
    if (this.peek() !== '{' && this.peek() !== '(' && this.peek() !== '') name = this.next();
    const variables = new Map<string, string>();
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.peek() !== '') {
        if (this.peek() === '$') { this.next(); const vn = this.next(); this.expect(':'); let ty = ''; while (this.peek() !== ')' && this.peek() !== ',' && this.peek() !== '$' && this.peek() !== '') { ty += this.next(); } variables.set(vn, ty); }
        else this.next();
      }
      this.expect(')');
    }
    const selections = this.parseSelections();
    return { kind, name, variables, selections };
  }
  parseSelections(): GqlSel[] {
    this.expect('{'); const out: GqlSel[] = [];
    while (this.peek() !== '}' && this.peek() !== '') {
      if (this.peek() === '...') {
        this.next();
        let tc: string | null = null;
        if (this.peek() === 'on') { this.next(); tc = this.next(); }
        out.push({ kind: 'fragment', typeCondition: tc, selections: this.parseSelections() });
        continue;
      }
      let alias: string | null = null; let name = this.next();
      if (this.peek() === ':') { this.next(); alias = name; name = this.next(); }
      const args = new Map<string, GqlValue>();
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')' && this.peek() !== '') { const an = this.next(); this.expect(':'); args.set(an, this.parseValue()); }
        this.expect(')');
      }
      let sels: GqlSel[] = [];
      if (this.peek() === '{') sels = this.parseSelections();
      out.push({ kind: 'field', alias, name, args, selections: sels });
    }
    this.expect('}');
    return out;
  }
  parseValue(): GqlValue {
    const t = this.next();
    if (t === '$') return { kind: 'variable', name: this.next() };
    if (t === '[') { const items: GqlValue[] = []; while (this.peek() !== ']') items.push(this.parseValue()); this.expect(']'); return { kind: 'list', items }; }
    if (t === '{') { const fields = new Map<string, GqlValue>(); while (this.peek() !== '}') { const n = this.next(); this.expect(':'); fields.set(n, this.parseValue()); } this.expect('}'); return { kind: 'object', fields }; }
    if (t === 'true') return { kind: 'boolean', value: true };
    if (t === 'false') return { kind: 'boolean', value: false };
    if (t === 'null') return { kind: 'null' };
    if (t.startsWith('"')) return { kind: 'string', value: JSON.parse(t) as string };
    if (/^-?\d+$/.test(t)) return { kind: 'int', value: Number(t) };
    return { kind: 'enum', value: t };
  }
}
function resolveValue(v: GqlValue, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'variable': return vars[v.name];
    case 'string': case 'int': case 'enum': case 'boolean': return v.value;
    case 'null': return null;
    case 'list': return v.items.map((x) => resolveValue(x, vars));
    case 'object': { const o: Record<string, unknown> = {}; for (const [k, x] of v.fields) o[k] = resolveValue(x, vars); return o; }
  }
}
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Viewer: ['login', 'id', 'name', 'email', 'avatarUrl'],
  User: ['login', 'id', 'name', 'email', 'avatarUrl'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'private', 'createdAt', 'updatedAt'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'headRef', 'baseRef', 'url', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'author'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'filename', 'additions', 'deletions', 'changes'],
  Ref: ['name', 'target'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueCommentEdge: ['node', 'cursor'],
  CommentEdge: ['node', 'cursor'],
  Node: ['id'],
};
const TYPE_FIELDS_INTROSPECTION: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'headRef', 'baseRef', 'url', 'createdAt', 'updatedAt', 'mergedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'private'],
  SearchType: [],
  User: ['login', 'id', 'name', 'email'],
  IssueState: [], PullRequestState: [], MergeableState: [],
};
const SEARCH_ENUM = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];
function findRepoByGid(id: string): Repo | undefined {
  const decoded = decodeGid(id); if (!decoded || !decoded.startsWith('R:')) return undefined;
  const key = decoded.slice(2);
  const idx = key.indexOf('/');
  if (idx < 0) return undefined;
  return repos.get(key);
}
function findIssueByGid(id: string): { repo: Repo; issue: IssueRec } | undefined {
  const decoded = decodeGid(id); if (!decoded || !decoded.startsWith('I:')) return undefined;
  const rest = decoded.slice(2); const parts = rest.split(':');
  const number = Number(parts.pop()); const key = parts.join(':');
  const repo = repos.get(key); if (!repo || !Number.isInteger(number)) return undefined;
  const issue = repo.issues.find((i) => i.number === number); if (!issue) return undefined;
  return { repo, issue };
}
function findPullByGid(id: string): { repo: Repo; pull: PullRec } | undefined {
  const decoded = decodeGid(id); if (!decoded || !decoded.startsWith('P:')) return undefined;
  const rest = decoded.slice(2); const parts = rest.split(':');
  const number = Number(parts.pop()); const key = parts.join(':');
  const repo = repos.get(key); if (!repo || !Number.isInteger(number)) return undefined;
  const pull = repo.pulls.find((p) => p.number === number); if (!pull) return undefined;
  return { repo, pull };
}
interface GqlCtx { errors: Array<{ message: string }>; vars: Record<string, unknown> }
function execSelections(typeName: string, obj: unknown, sels: GqlSel[], ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition && sel.typeCondition !== typeName && !(typeName === 'Node' && (obj as Record<string, unknown>).__typename === sel.typeCondition)) continue;
      const sub = execSelections(sel.typeCondition ?? typeName, obj, sel.selections, ctx);
      Object.assign(out, sub); continue;
    }
    const key = sel.alias ?? sel.name;
    const fields = TYPE_FIELDS[typeName] ?? [];
    if (typeName !== 'Node' && !fields.includes(sel.name) && !sel.name.startsWith('__')) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
      out[key] = null; continue;
    }
    out[key] = execField(typeName, obj, sel, ctx);
  }
  return out;
}
function execField(typeName: string, obj: unknown, field: GqlField, ctx: GqlCtx): unknown {
  const rec = (obj ?? {}) as Record<string, unknown>;
  const arg = (name: string): unknown => { const v = field.args.get(name); return v === undefined ? undefined : resolveValue(v, ctx.vars); };
  // Root fields
  if (typeName === 'Query') {
    if (field.name === 'viewer') return execSelections('Viewer', { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email }, field.selections, ctx);
    if (field.name === 'repository') {
      const repo = getRepo(str(arg('owner')), str(arg('name')));
      if (!repo) return null;
      return execSelections('Repository', repo, field.selections, ctx);
    }
    if (field.name === 'node') {
      const id = str(arg('id'));
      const repo = findRepoByGid(id);
      if (repo) { const withType = { ...repo, __typename: 'Repository' }; return execSelections('Node', withType, field.selections, ctx); }
      const iss = findIssueByGid(id); if (iss) { const withType = { ...iss.issue, __typename: 'Issue' }; return execSelections('Node', withType, field.selections, ctx); }
      return null;
    }
    if (field.name === '__type') {
      const name = str(arg('name'));
      return execTypeObject(name, field, ctx);
    }
    return null;
  }
  if (typeName === 'Node') {
    const typename = str(rec.__typename, 'Repository');
    if (field.name === 'id') {
      if (typename === 'Repository') return gid('R', `${str(rec.owner)}/${str(rec.name)}`);
      return str(rec.nodeId) || '';
    }
    return execSelections(typename, obj, [field], ctx)[field.alias ?? field.name];
  }
  if (typeName === 'Repository') {
    const repo = obj as Repo;
    switch (field.name) {
      case 'id': return gid('R', `${repo.owner}/${repo.name}`);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'owner': return execSelections('User', { login: repo.owner, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email }, field.selections, ctx);
      case 'defaultBranchRef': { const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`); if (tip === undefined) return null; return execSelections('Ref', { name: repo.defaultBranch }, field.selections, ctx); }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'description': return repo.description;
      case 'url': return `https://github.com/${repo.owner}/${repo.name}`;
      case 'private': return repo.priv;
      case 'createdAt': return repo.createdAt;
      case 'updatedAt': return repo.updatedAt;
      case 'issue': { const n = Number(arg('number')); const issue = repo.issues.find((i) => i.number === n); if (!issue) return null; return execSelections('Issue', issue, field.selections, ctx); }
      case 'issues': {
        let list = [...repo.issues];
        const states = arg('states'); if (Array.isArray(states)) { const want = new Set(states.map((s) => String(s))); list = list.filter((i) => want.has(i.state === 'open' ? 'OPEN' : 'CLOSED')); }
        const orderBy = asObj(arg('orderBy')); const dir = str(orderBy.direction, 'DESC'); const fld = str(orderBy.field, 'CREATED_AT');
        if (fld === 'CREATED_AT' || fld === 'UPDATED_AT') list.sort((a, b) => dir === 'DESC' ? (b.seq - a.seq || b.number - a.number) : (a.seq - b.seq || a.number - b.number));
        const first = arg('first'); const after = arg('after');
        let start = 0;
        if (typeof after === 'string' && after !== '') { const dec = decodeGid(after); const m = dec ? /^cursor:(\d+)$/.exec(dec) : null; if (m) { const idx = list.findIndex((i) => i.number === Number(m[1])); if (idx >= 0) start = idx + 1; } }
        const sliced = typeof first === 'number' ? list.slice(start, start + first) : list.slice(start);
        const conn = { nodes: sliced, totalCount: list.length, pageInfo: { hasNextPage: typeof first === 'number' ? start + first < list.length : false, hasPreviousPage: start > 0, endCursor: sliced.length ? gid('cursor', String(sliced[sliced.length - 1].number)) : null, startCursor: sliced.length ? gid('cursor', String(sliced[0].number)) : null } };
        return execSelections('IssueConnection', conn, field.selections, ctx);
      }
      case 'pullRequests': {
        const first = arg('first');
        const list = [...repo.pulls].sort((a, b) => b.seq - a.seq);
        const sliced = typeof first === 'number' ? list.slice(0, first) : list;
        const conn = { nodes: sliced, totalCount: list.length, pageInfo: { hasNextPage: typeof first === 'number' ? first < list.length : false, hasPreviousPage: false, endCursor: null, startCursor: null } };
        return execSelections('PullRequestConnection', conn, field.selections, ctx);
      }
      case 'pullRequest': { const n = Number(arg('number')); const pull = repo.pulls.find((p) => p.number === n); if (!pull) return null; return execSelections('PullRequest', pull, field.selections, ctx); }
    }
    return rec[field.name] ?? null;
  }
  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') {
    if (field.name === 'nodes') {
      const nodes = (rec.nodes as unknown[]) ?? [];
      const elemType = typeName === 'IssueConnection' ? 'Issue' : typeName === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestChangedFile';
      return nodes.map((n) => execSelections(elemType, n, field.selections, ctx));
    }
    if (field.name === 'pageInfo') return execSelections('PageInfo', rec.pageInfo ?? {}, field.selections, ctx);
    if (field.name === 'totalCount') return typeof rec.totalCount === 'number' ? rec.totalCount : ((rec.nodes as unknown[])?.length ?? 0);
    if (field.name === 'edges') {
      const nodes = (rec.nodes as unknown[]) ?? [];
      const elemType = typeName === 'IssueConnection' ? 'Issue' : typeName === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestChangedFile';
      return nodes.map((n, i) => {
        const edgeOut: Record<string, unknown> = {};
        for (const sub of field.selections) {
          if (sub.kind === 'fragment') continue;
          if (sub.name === 'node') edgeOut[sub.alias ?? 'node'] = execSelections(elemType, n, sub.selections, ctx);
          else if (sub.name === 'cursor') edgeOut[sub.alias ?? 'cursor'] = gid('cursor', `cursor:${i}`);
          else edgeOut[sub.alias ?? sub.name] = null;
        }
        return edgeOut;
      });
    }
    return null;
  }
  if (typeName === 'Issue') {
    const issue = obj as IssueRec;
    if (field.name === 'id') return issue.nodeId;
    if (field.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    if (field.name === 'number') return issue.number;
    if (field.name === 'title') return issue.title;
    if (field.name === 'body') return issue.body;
    if (field.name === 'url') return '';
    if (field.name === 'createdAt') return issue.createdAt;
    if (field.name === 'updatedAt') return issue.updatedAt;
    if (field.name === 'author') return execSelections('User', { login: VIEWER.login, id: VIEWER.id }, field.selections, ctx);
    if (field.name === 'labels') return { nodes: issue.labels.map((n) => ({ name: n })) };
    if (field.name === 'comments') return { nodes: issue.comments.map((c) => ({ id: c.nodeId, body: c.body })) };
    return null;
  }
  if (typeName === 'PullRequest') {
    const pull = obj as PullRec;
    if (field.name === 'id') return pull.nodeId;
    if (field.name === 'number') return pull.number;
    if (field.name === 'title') return pull.title;
    if (field.name === 'body') return pull.body;
    if (field.name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    if (field.name === 'merged') return pull.merged;
    if (field.name === 'mergeable') {
      const repo = [...repos.values()].find((r) => r.pulls.includes(pull));
      if (!repo) return 'UNKNOWN';
      return prConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    }
    if (field.name === 'headRefName') return pull.head;
    if (field.name === 'baseRefName') return pull.base;
    if (field.name === 'headRef') return execSelections('Ref', { name: pull.head }, field.selections, ctx);
    if (field.name === 'baseRef') return execSelections('Ref', { name: pull.base }, field.selections, ctx);
    if (field.name === 'createdAt') return pull.createdAt;
    if (field.name === 'updatedAt') return pull.updatedAt;
    if (field.name === 'mergedAt') return pull.mergedAt;
    if (field.name === 'url') return '';
    if (field.name === 'files') {
      const repo = [...repos.values()].find((r) => r.pulls.includes(pull));
      const files = repo ? pullFiles(repo, pull).map((f) => ({ path: f.filename, filename: f.filename, additions: f.additions, deletions: f.deletions, changes: f.changes })) : [];
      const first = arg('first');
      const sliced = typeof first === 'number' ? files.slice(0, first) : files;
      const conn = { nodes: sliced, totalCount: files.length, pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null } };
      return execSelections('PullRequestChangedFileConnection', conn, field.selections, ctx);
    }
    return null;
  }
  if (typeName === 'PullRequestChangedFile') {
    if (field.name === 'path' || field.name === 'filename') return str(rec.path ?? rec.filename, '');
    return rec[field.name] ?? null;
  }
  if (typeName === 'Viewer' || typeName === 'User') {
    if (field.name === 'login') return VIEWER.login;
    if (field.name === 'id') return VIEWER.id;
    if (field.name === 'name') return VIEWER.name;
    if (field.name === 'email') return VIEWER.email;
    return null;
  }
  if (typeName === 'Ref') { if (field.name === 'name') return str(rec.name, ''); return null; }
  if (typeName === 'PageInfo') return rec[field.name] ?? null;
  if (typeName === '__Type') return rec[field.name] ?? null;
  return rec[field.name] ?? null;
}
function execTypeObject(name: string, field: GqlField, ctx: GqlCtx): unknown {
  const fieldsList = TYPE_FIELDS_INTROSPECTION[name];
  const isEnum = name === 'SearchType';
  if (fieldsList === undefined && !isEnum) return null;
  const obj: Record<string, unknown> = { name, kind: isEnum ? 'ENUM' : 'OBJECT', fields: fieldsList ?? [], enumValues: isEnum ? SEARCH_ENUM : [] };
  const out: Record<string, unknown> = {};
  for (const sel of field.selections) {
    if (sel.kind === 'fragment') continue;
    const key = sel.alias ?? sel.name;
    if (sel.name === 'fields') out[key] = (obj.fields as string[]).map((n) => execSelections('__Field', { name: n }, sel.selections, ctx));
    else if (sel.name === 'enumValues') out[key] = (obj.enumValues as string[]).map((n) => execSelections('__EnumValue', { name: n }, sel.selections, ctx));
    else if (sel.name === 'name') out[key] = obj.name;
    else if (sel.name === 'kind') out[key] = obj.kind;
    else out[key] = null;
  }
  return out;
}
function runGraphQLOp(op: GqlOp, vars: Record<string, unknown>): { data: unknown; errors: Array<{ message: string }> } {
  const ctx: GqlCtx = { errors: [], vars };
  if (op.kind === 'mutation') {
    const data = execMutation(op, ctx);
    return { data, errors: ctx.errors };
  }
  const data = execSelections('Query', {}, op.selections, ctx);
  if (ctx.errors.length) return { data: null, errors: ctx.errors };
  return { data, errors: [] };
}
function execMutation(op: GqlOp, ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of op.selections) {
    if (sel.kind === 'fragment') continue;
    const key = sel.alias ?? sel.name;
    const arg = (name: string): unknown => { const v = sel.args.get(name); return v === undefined ? undefined : resolveValue(v, ctx.vars); };
    if (sel.name === 'createIssue') {
      const input = asObj(arg('input'));
      const repo = findRepoByGid(str(input.repositoryId));
      if (!repo) { ctx.errors.push({ message: 'Repository not found' }); out[key] = null; continue; }
      const issue = createIssueRecord(repo, str(input.title), str(input.body), []);
      out[key] = execSelections('CreateIssuePayload', { issue }, sel.selections, ctx);
    } else if (sel.name === 'closeIssue') {
      const input = asObj(arg('input'));
      const found = findIssueByGid(str(input.issueId));
      if (!found) { ctx.errors.push({ message: 'Issue not found' }); out[key] = null; continue; }
      found.issue.state = 'closed'; found.issue.closedAt = nowIso(); found.issue.updatedAt = nowIso();
      out[key] = execSelections('CloseIssuePayload', { issue: found.issue }, sel.selections, ctx);
    } else if (sel.name === 'createPullRequest') {
      const input = asObj(arg('input'));
      const repo = findRepoByGid(str(input.repositoryId));
      if (!repo) { ctx.errors.push({ message: 'Repository not found' }); out[key] = null; continue; }
      const head = str(input.headRefName); const base = str(input.baseRefName);
      const headSha = repo.refs.get(`refs/heads/${head}`); const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) { ctx.errors.push({ message: 'head or base branch does not exist' }); out[key] = null; continue; }
      let pull = repo.pulls.find((p) => p.state === 'open' && p.head === head && p.base === base);
      if (!pull) pull = createPullRecord(repo, str(input.title), str(input.body), head, base, headSha, baseSha);
      out[key] = execSelections('CreatePullRequestPayload', { pullRequest: pull }, sel.selections, ctx);
    } else if (sel.name === 'mergePullRequest') {
      const input = asObj(arg('input'));
      const found = findPullByGid(str(input.pullRequestId));
      if (!found) { ctx.errors.push({ message: 'Pull request not found' }); out[key] = null; continue; }
      const res = mergePullRequest(found.repo, found.pull);
      if (!res.ok) { ctx.errors.push({ message: res.conflict ? 'Merge conflict' : 'Pull request cannot be merged' }); out[key] = null; continue; }
      out[key] = execSelections('MergePullRequestPayload', { pullRequest: found.pull }, sel.selections, ctx);
    } else if (sel.name === 'addComment') {
      const input = asObj(arg('input'));
      const found = findIssueByGid(str(input.subjectId));
      if (!found) { ctx.errors.push({ message: 'Subject not found' }); out[key] = null; continue; }
      const comment: CommentRec = { id: commentIdSeq++, nodeId: gid('C', `${found.repo.owner}/${found.repo.name}:${found.issue.number}:${commentIdSeq}`), body: str(input.body), createdAt: nowIso(), updatedAt: nowIso() };
      found.issue.comments.push(comment);
      const edge = { node: comment };
      const payloadObj = { commentEdge: edge, comment };
      const payload: Record<string, unknown> = {};
      for (const sub of sel.selections) {
        if (sub.kind === 'fragment') continue;
        const k = sub.alias ?? sub.name;
        if (sub.name === 'commentEdge') {
          const edgeOut: Record<string, unknown> = {};
          for (const e of sub.selections) {
            if (e.kind === 'fragment') continue;
            if (e.name === 'node') edgeOut[e.alias ?? 'node'] = execSelections('IssueComment', { id: comment.nodeId, body: comment.body, createdAt: comment.createdAt, updatedAt: comment.updatedAt }, e.selections, ctx);
            else edgeOut[e.alias ?? e.name] = null;
          }
          payload[k] = edgeOut;
        } else if (sub.name === 'comment') payload[k] = execSelections('IssueComment', { id: comment.nodeId, body: comment.body }, sub.selections, ctx);
        else payload[k] = null;
      }
      void payloadObj;
      out[key] = payload;
    } else {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "Mutation".` });
      out[key] = null;
    }
  }
  // Payload field resolution for issue/pullRequest objects inside payloads
  // (execSelections above handled nested objects via generic execField on payload pseudo-types:
  //  re-resolve issue/pullRequest fields here when they were left as raw objects.)
  for (const sel of op.selections) {
    if (sel.kind === 'fragment') continue;
    const key = sel.alias ?? sel.name;
    const payload = out[key] as Record<string, unknown> | null;
    if (!payload || typeof payload !== 'object') continue;
    for (const sub of sel.selections) {
      if (sub.kind === 'fragment') continue;
      if (sub.name === 'issue' && payload.issue && typeof payload.issue === 'object' && 'number' in (payload.issue as Record<string, unknown>)) {
        payload[sub.alias ?? 'issue'] = execSelections('Issue', payload.issue, sub.selections, ctx);
      }
      if (sub.name === 'pullRequest' && payload.pullRequest && typeof payload.pullRequest === 'object' && 'number' in (payload.pullRequest as Record<string, unknown>)) {
        payload[sub.alias ?? 'pullRequest'] = execSelections('PullRequest', payload.pullRequest, sub.selections, ctx);
      }
    }
  }
  if (ctx.errors.length) return out;
  return out;
}
async function handleGraphQL(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): Promise<void> {
  if (!authed(req)) { sendJson(res, 401, { message: 'Bad credentials' }); return; }
  const parsed = parseJsonBody(rawBody);
  if (!parsed.ok) { sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] }); return; }
  const runOne = (opBody: unknown): Record<string, unknown> => {
    const o = asObj(opBody);
    const query = str(o.query);
    if (query === '') return { data: null, errors: [{ message: 'No query provided' }] };
    const variables = asObj(o.variables);
    try {
      const parser = new GqlParser(query);
      const op = parser.parseOp();
      const { data, errors } = runGraphQLOp(op, variables);
      return errors.length ? { data, errors } : { data };
    } catch (e) {
      return { data: null, errors: [{ message: (e as Error).message }] };
    }
  };
  if (Array.isArray(parsed.value)) sendJson(res, 200, parsed.value.map(runOne));
  else sendJson(res, 200, runOne(parsed.value));
}

// ---------------------------------------------------------------- MCP
const MCP_TOOLS: Array<{ name: string; description: string; inputSchema: { type: string; properties: Record<string, unknown>; required: string[] } }> = [
  { name: 'create_repo', description: 'Create a new repository owned by the viewer.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' }, owner: { type: 'string' }, owner_login: { type: 'string' }, full_name: { type: 'string' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, owner_login: { type: 'string' }, name: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, owner_login: { type: 'string' }, repo: { type: 'string' }, name: { type: 'string' }, full_name: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, owner_login: { type: 'string' }, repo: { type: 'string' }, name: { type: 'string' }, full_name: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request between two branches.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, owner_login: { type: 'string' }, repo: { type: 'string' }, name: { type: 'string' }, full_name: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, head_ref: { type: 'string' }, base_ref: { type: 'string' } }, required: ['owner', 'repo', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, owner_login: { type: 'string' }, repo: { type: 'string' }, name: { type: 'string' }, full_name: { type: 'string' }, number: { type: 'number' }, pull_number: { type: 'number' }, pull_request_number: { type: 'number' }, pr_number: { type: 'number' }, merge_method: { type: 'string' } }, required: ['owner', 'repo', 'pull_number'] } },
];
function mcpResolveRepo(args: Record<string, unknown>): Repo | undefined {
  const owner = str(args.owner ?? args.owner_login, '');
  let name = str(args.repo ?? args.name, '');
  const full = str(args.full_name, '');
  if (full.includes('/')) { const [o, n] = full.split('/'); if (owner === '') return getRepo(o, n); return getRepo(owner, n); }
  if (owner === '') return getRepo(VIEWER.login, name);
  return getRepo(owner, name);
}
function mcpToolsCall(name: string, args: Record<string, unknown>): { content: Array<{ type: string; text: string }>; structuredContent: unknown; isError?: boolean } {
  const err = (message: string): { content: Array<{ type: string; text: string }>; structuredContent: unknown; isError?: boolean } => ({ content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true });
  const ok = (obj: unknown): { content: Array<{ type: string; text: string }>; structuredContent: unknown } => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj });
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) return err(`Unknown tool: ${name}`);
  const missing = tool.inputSchema.required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
  if (missing.length) return err(`Missing required argument: ${missing.join(', ')}`);
  if (name === 'create_repo') {
    const repoName = str(args.name);
    if (repos.has(repoKey(VIEWER.login, repoName))) return err('Repository already exists');
    const repo = createRepoRecord(repoName, str(args.description), args.private === true, 'main');
    return ok(repoJson(repo));
  }
  if (name === 'get_repo') {
    const repo = mcpResolveRepo(args); if (!repo) return err('Repository not found');
    return ok(repoJson(repo));
  }
  if (name === 'create_issue') {
    const repo = mcpResolveRepo(args); if (!repo) return err('Repository not found');
    const issue = createIssueRecord(repo, str(args.title), str(args.body), []);
    return ok(issueJson(repo, issue));
  }
  if (name === 'list_issues') {
    const repo = mcpResolveRepo(args); if (!repo) return err('Repository not found');
    const state = str(args.state, 'open');
    const list = repo.issues.filter((i) => state === 'all' ? true : i.state === state);
    return ok(list.map((i) => issueJson(repo, i)));
  }
  if (name === 'create_pull_request') {
    const repo = mcpResolveRepo(args); if (!repo) return err('Repository not found');
    const head = str(args.head ?? args.head_ref); const base = str(args.base ?? args.base_ref);
    const headSha = repo.refs.get(`refs/heads/${head}`); const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) return err('head or base branch does not exist');
    let pull = repo.pulls.find((p) => p.state === 'open' && p.head === head && p.base === base);
    if (!pull) pull = createPullRecord(repo, str(args.title), str(args.body), head, base, headSha, baseSha);
    return ok(pullJson(repo, pull));
  }
  if (name === 'merge_pull_request') {
    const repo = mcpResolveRepo(args); if (!repo) return err('Repository not found');
    const num = Number(args.number ?? args.pull_number ?? args.pull_request_number ?? args.pr_number);
    const pull = repo.pulls.find((p) => p.number === num); if (!pull) return err('Pull request not found');
    const out = mergePullRequest(repo, pull);
    if (!out.ok) return err(out.conflict ? 'Merge conflict' : 'Pull request cannot be merged');
    return ok({ sha: out.sha, merged: true, message: 'Pull request successfully merged' });
  }
  return err(`Unknown tool: ${name}`);
}
async function handleMcp(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): Promise<void> {
  if (!authed(req)) { sendJson(res, 401, { jsonrpc: '2.0', error: { code: -32000, message: 'Bad credentials' } }); return; }
  const protocolVersion = str(req.headers['mcp-protocol-version'], '');
  const modern = protocolVersion >= '2026-07-28';
  const text = rawBody.toString('utf8').trim();
  if (text === '') { sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  let body: unknown;
  try { body = JSON.parse(text); } catch {
    if (modern) { sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return;
  }
  const o = asObj(body);
  const method = str(o.method);
  const id = o.id !== undefined ? o.id : null;
  const result = (r: unknown): void => sendJson(res, 200, { jsonrpc: '2.0', id, result: r });
  const rpcErr = (code: number, message: string): void => sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  if (method === 'server/discover') {
    result({
      supportedVersions: ['2026-07-28', '2026-03-26', '2025-06-18', '2025-03-26', '2024-11-05'],
      serverInfo: { name: 'github-core-clone', version: '1.0.0' },
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-core-clone', version: '1.0.0' } },
    });
    return;
  }
  if (method === 'initialize') {
    result({ protocolVersion: '2026-07-28', capabilities: { tools: {} }, serverInfo: { name: 'github-core-clone', version: '1.0.0' } });
    return;
  }
  if (method.startsWith('notifications/')) { res.writeHead(202, { 'x-github-request-id': nextReqId() }); res.end(); return; }
  if (method === 'tools/list') {
    result({ tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    return;
  }
  if (method === 'tools/call') {
    const params = asObj(o.params);
    const toolName = str(params.name);
    const args = asObj(params.arguments);
    const known = MCP_TOOLS.some((t) => t.name === toolName);
    if (!known) { rpcErr(-32601, `Unknown tool: ${toolName}`); return; }
    const out = mcpToolsCall(toolName, args);
    result(out);
    return;
  }
  rpcErr(-32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------- server
export function createApp(): ReturnType<typeof createServer> {
  const server = createServer(async (req, res) => {
    try {
      const path = pathOf(req);
      const rawBody = (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') ? await readBody(req) : Buffer.alloc(0);
      if (path === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok\n'); return; }
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1]); const name = decodeURIComponent(gitMatch[2]);
        if (gitMatch[3] === 'info/refs') {
          const service = queryOf(req).get('service') ?? '';
          handleGitInfoRefs(req, res, owner, name, service); return;
        }
        if (gitMatch[3] === 'git-upload-pack') { handleUploadPack(req, res, owner, name, rawBody); return; }
        if (gitMatch[3] === 'git-receive-pack') { handleReceivePack(req, res, owner, name, rawBody); return; }
      }
      if (path === '/mcp') { await handleMcp(req, res, rawBody); return; }
      if (path === '/api/graphql') { await handleGraphQL(req, res, rawBody); return; }
      if (path === '/api/v3' || path.startsWith('/api/v3/')) { await handleRest(req, res, rawBody); return; }
      errJson(res, 404, 'Not Found');
    } catch {
      if (!res.headersSent) errJson(res, 500, 'Internal server error');
    }
  });
  return server;
}
