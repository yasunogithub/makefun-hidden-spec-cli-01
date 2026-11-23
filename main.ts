// mend: a CLI that applies model-written edits (unified diff, SEARCH/REPLACE blocks, V4A patches and
// JSON text-editor calls) to a tree of text files, exactly as SPEC.md in this repository specifies.
// Node 22, standard library alone; run as `node main.ts [options] [PATCH]` with the working directory
// as the root of the tree. Every edit is applied to an in-memory view of the tree first, and the tree
// on disk is written only when no edit failed, so a patch changes every file or none.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): that hand-over and runner.ts stay as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

interface Ctx {
  moves: { old: string; next: string }[];
}
type Edit = (tree: Tree) => void;

/** A file split into lines the way SPEC.md section 3 reads it. */
interface FileModel {
  lines: string[];
  br: string;
  ends: boolean;
}
function splitFile(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, ends: false };
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}
function renderFile(m: FileModel): string {
  return m.lines.length === 0 ? '' : m.lines.join(m.br) + (m.ends ? m.br : '');
}

/** The three matching tiers of SPEC.md section 5. */
const trailTrim = (s: string): string => s.replace(/[ \t]+$/, '');
const bothTrim = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadOf = (s: string): string => /^[ \t]*/.exec(s)![0];
function normLine(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? trailTrim(s) : bothTrim(s);
}
interface Found {
  tier: number;
  positions: number[];
}
/** Occurrences of O in lines at or after `start`, at the first tier that has one; null when none. */
function findOccurrences(lines: string[], o: string[], strict: boolean, start = 0, mustEndAtEnd = false): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = start; i + o.length <= lines.length; i += 1) {
      if (mustEndAtEnd && i + o.length !== lines.length) continue;
      let ok = true;
      for (let k = 0; k < o.length; k += 1) {
        if (normLine(lines[i + k]!, tier) !== normLine(o[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of a hunk or chunk body: context, old-only, new-only, or a `\` marker. */
interface BodyItem {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  emptyRaw?: boolean;
}
function bodyOld(items: BodyItem[]): string[] {
  return items.filter((it) => it.kind === 'ctx' || it.kind === 'del').map((it) => it.text);
}
function bodyNewCount(items: BodyItem[]): number {
  return items.filter((it) => it.kind === 'ctx' || it.kind === 'add').length;
}
/** A new line as written at a tier: at tier 2 it is re-indented from O's first line to the file's. */
function reindent(text: string, tier: number, o: string[], fileFirst: string): string {
  if (tier !== 2 || o.length === 0) return text;
  if (text === '' || text.trim() === '') return text;
  const p = leadOf(o[0]!);
  if (!text.startsWith(p)) return text;
  return leadOf(fileFirst) + text.slice(p.length);
}
/** The lines a matched hunk or chunk writes: context lines are the file's own, the rest are N's. */
function replacementLines(items: BodyItem[], fileLines: string[], pos: number, tier: number, o: string[]): string[] {
  const out: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (it.kind === 'del') {
      oi += 1;
    } else if (it.kind === 'add') {
      out.push(reindent(it.text, tier, o, fileLines[pos] ?? ''));
    }
  }
  return out;
}
/** Whether a `\` line follows the body's last context or `+` line. */
function bsAfterLastWritten(items: BodyItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]!.kind === 'ctx' || items[i]!.kind === 'add') {
      return items[i + 1]?.kind === 'bs';
    }
  }
  return false;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const m = splitFile(before);
      if (line < 0 || line > m.lines.length) throw new Fail('no-match', p);
      m.lines.splice(line, 0, ...add);
      tree.now.set(p, renderFile(m));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------------- unified diffs (section 6) ---------------- */

interface UHunk {
  a: number;
  items: BodyItem[];
}
interface USection {
  diffOld?: string;
  diffNew?: string;
  headOld?: string;
  headNew?: string;
  pairDone: boolean;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

function headerPath(raw: string): string {
  const t = raw.split('\t')[0]!.trim();
  return t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const newSection = (): USection => {
    const s: USection = { pairDone: false, newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const items: BodyItem[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') items.push({ kind: 'ctx', text: '', emptyRaw: true });
        else if (bl[0] === ' ') items.push({ kind: 'ctx', text: bl.slice(1) });
        else if (bl[0] === '-') items.push({ kind: 'del', text: bl.slice(1) });
        else if (bl[0] === '+') items.push({ kind: 'add', text: bl.slice(1) });
        else if (bl[0] === '\\') items.push({ kind: 'bs', text: bl });
        else break;
        j += 1;
      }
      while (items.length > 0 && items[items.length - 1]!.emptyRaw) items.pop();
      cur.hunks.push({ a: Number(m[1]), items });
      i = j;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const nextIsPlus = (lines[i + 1] ?? '').startsWith('+++ ');
      if (cur !== null && !cur.pairDone && cur.hunks.length === 0) {
        if (!nextIsPlus) throw new Exit2(`error: parse ${i + 2}`);
        cur.headOld = headerPath(line.slice(4));
        cur.headNew = headerPath(lines[i + 1]!.slice(4));
        cur.pairDone = true;
        i += 2;
        continue;
      }
      if (nextIsPlus) {
        const s = newSection();
        s.headOld = headerPath(line.slice(4));
        s.headNew = headerPath(lines[i + 1]!.slice(4));
        s.pairDone = true;
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i += 1;
  }
  return sections;
}

function applyUnifiedHunks(model: FileModel, hunks: UHunk[], strict: boolean, path: string): FileModel {
  const lines = [...model.lines];
  let ends = model.ends;
  let d = 0;
  for (const h of hunks) {
    const o = bodyOld(h.items);
    const nCount = bodyNewCount(h.items);
    if (o.length === 0) {
      const at = Math.min(h.a + d, lines.length);
      const adds = h.items.filter((it) => it.kind === 'add').map((it) => it.text);
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...adds);
      if (atEnd) ends = !bsAfterLastWritten(h.items);
      d += nCount - o.length;
      continue;
    }
    const found = findOccurrences(lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.positions[0]!;
    for (const p of found.positions) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const atEnd = pos + o.length === lines.length;
    const rep = replacementLines(h.items, lines, pos, found.tier, o);
    lines.splice(pos, o.length, ...rep);
    if (atEnd) ends = !bsAfterLastWritten(h.items);
    d += nCount - o.length;
  }
  return { lines, br: model.br, ends };
}

function unifiedEdits(lines: string[], strict: boolean, ctx: Ctx): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => {
    const oldPath = s.headOld ?? s.renameFrom ?? s.diffOld;
    const newPath = s.headNew ?? s.renameTo ?? s.diffNew;
    return (tree: Tree) => {
      const creation = oldPath === '/dev/null' || s.newFile;
      const deletion = !creation && (newPath === '/dev/null' || s.delFile);
      if (creation) {
        const np = newPath!;
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        let lastPlusBs = false;
        for (const h of s.hunks) {
          h.items.forEach((it, k) => {
            if (it.kind === 'add') {
              plus.push(it.text);
              lastPlusBs = h.items[k + 1]?.kind === 'bs';
            }
          });
        }
        tree.now.set(np, renderFile({ lines: plus, br: '\n', ends: !lastPlusBs }));
        return;
      }
      const op = oldPath!;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (deletion) {
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
        return;
      }
      const np = newPath!;
      const isMove = np !== op;
      if (isMove && !safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyUnifiedHunks(splitFile(before), s.hunks, strict, op);
      if (isMove) {
        tree.now.set(op, null);
        tree.now.set(np, renderFile(out));
        ctx.moves.push({ old: op, next: np });
      } else {
        tree.now.set(op, renderFile(out));
      }
    };
  });
}

/* ---------------- SEARCH/REPLACE blocks (section 7) ---------------- */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}
function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let k = i - 1; k > prevEnd; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let eq = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let k = eq + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks = parseSearchReplace(lines);
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    return (tree: Tree) => {
      const p = b.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (b.oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, renderFile({ lines: [...b.newLines], br: '\n', ends: true }));
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const m = splitFile(before);
      const found = findOccurrences(m.lines, b.oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const rep = b.newLines.map((t) => reindent(t, found.tier, b.oldLines, m.lines[pos]!));
      m.lines.splice(pos, b.oldLines.length, ...rep);
      tree.now.set(p, renderFile(m));
    };
  });
}

/* ---------------- V4A patches (section 8) ---------------- */

interface VChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}
interface VSection {
  kind: 'add' | 'del' | 'update';
  path: string;
  startLine: number;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const heads: [string, VSection['kind']][] = [
    ['*** Add File:', 'add'],
    ['*** Delete File:', 'del'],
    ['*** Update File:', 'update'],
  ];
  const headOf = (l: string): { kind: VSection['kind']; path: string } | null => {
    for (const [pre, kind] of heads) {
      if (l.startsWith(pre)) return { kind, path: l.slice(pre.length).trim() };
    }
    return null;
  };
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const head = headOf(line);
    if (head === null) throw new Exit2(`error: parse ${i + 1}`);
    const startLine = i + 1;
    const raw: { text: string; num: number }[] = [];
    let j = i + 1;
    while (j < last && headOf(lines[j]!) === null) {
      raw.push({ text: lines[j]!, num: j + 1 });
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    const sec: VSection = { kind: head.kind, path: head.path, startLine, addLines: [], moveTo: null, chunks: [] };
    if (head.kind === 'add') {
      for (const r of raw) {
        if (r.text.startsWith('+')) sec.addLines.push(r.text.slice(1));
        else if (r.text === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${r.num}`);
      }
    } else if (head.kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.num}`);
    } else {
      let k = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to:')) {
        sec.moveTo = raw[0]!.text.slice('*** Move to:'.length).trim();
        k = 1;
      }
      let curChunk: VChunk | null = null;
      for (; k < raw.length; k += 1) {
        const r = raw[k]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          const anchor = t.slice(2).trim();
          curChunk = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
          sec.chunks.push(curChunk);
        } else if (t.trim() === '*** End of File') {
          if (curChunk === null) {
            curChunk = { anchor: null, items: [], eof: true };
            sec.chunks.push(curChunk);
          } else {
            curChunk.eof = true;
          }
          curChunk = null;
        } else if (t.startsWith('*** Move to:')) {
          throw new Exit2(`error: parse ${r.num}`);
        } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (curChunk === null) {
            curChunk = { anchor: null, items: [], eof: false };
            sec.chunks.push(curChunk);
          }
          if (t === '') curChunk.items.push({ kind: 'ctx', text: '' });
          else if (t[0] === ' ') curChunk.items.push({ kind: 'ctx', text: t.slice(1) });
          else if (t[0] === '-') curChunk.items.push({ kind: 'del', text: t.slice(1) });
          else curChunk.items.push({ kind: 'add', text: t.slice(1) });
        } else {
          throw new Exit2(`error: parse ${r.num}`);
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${startLine}`);
    }
    sections.push(sec);
    i = j;
  }
  return sections;
}

function v4aEdits(lines: string[], strict: boolean, ctx: Ctx): Edit[] {
  const sections = parseV4a(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => {
    return (tree: Tree) => {
      const p = s.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (s.kind === 'add') {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, renderFile({ lines: [...s.addLines], br: '\n', ends: true }));
        return;
      }
      if (s.kind === 'del') {
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const np = s.moveTo;
      if (np !== null && !safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (np !== null && tree.get(np) !== null) throw new Fail('exists', np);
      const m = splitFile(before);
      const fileLines = [...m.lines];
      let cursor = 0;
      for (const ch of s.chunks) {
        if (ch.anchor !== null) {
          let anchorPos = -1;
          const tiers = strict ? [0] : [0, 1, 2];
          for (const tier of tiers) {
            for (let k = cursor; k < fileLines.length; k += 1) {
              if (normLine(fileLines[k]!, tier) === normLine(ch.anchor, tier)) {
                anchorPos = k;
                break;
              }
            }
            if (anchorPos >= 0) break;
          }
          if (anchorPos < 0) throw new Fail('no-match', p);
          cursor = anchorPos + 1;
        }
        const o = bodyOld(ch.items);
        if (o.length === 0) {
          const adds = ch.items.filter((it) => it.kind === 'add').map((it) => it.text);
          const at = ch.eof ? fileLines.length : Math.min(cursor, fileLines.length);
          fileLines.splice(at, 0, ...adds);
          cursor = at + adds.length;
          continue;
        }
        const found = findOccurrences(fileLines, o, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', p);
        const pos = found.positions[0]!;
        const rep = replacementLines(ch.items, fileLines, pos, found.tier, o);
        fileLines.splice(pos, o.length, ...rep);
        cursor = pos + rep.length;
      }
      const out = renderFile({ lines: fileLines, br: m.br, ends: m.ends });
      if (np !== null) {
        tree.now.set(p, null);
        tree.now.set(np, out);
        ctx.moves.push({ old: p, next: np });
      } else {
        tree.now.set(p, out);
      }
    };
  });
}

/* ---------------- the run (sections 1, 2 and 10) ---------------- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const ctx: Ctx = { moves: [] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, ctx)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict, ctx);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = ctx.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      ctx.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    text: string;
    path: string;
    value: string | null;
  }
  const rows: Row[] = [];
  const consumed = new Set<string>();
  for (const mv of ctx.moves) {
    if (consumed.has(mv.old) || consumed.has(mv.next)) continue;
    const wasOld = tree.original(mv.old);
    const nowOld = tree.now.has(mv.old) ? tree.now.get(mv.old)! : tree.original(mv.old);
    const wasNew = tree.original(mv.next);
    const nowNew = tree.now.has(mv.next) ? tree.now.get(mv.next)! : tree.original(mv.next);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: mv.next, text: `R ${mv.old} -> ${mv.next}`, path: mv.next, value: nowNew });
      consumed.add(mv.old);
      consumed.add(mv.next);
      // The old path's deletion is written with the row, below.
      rows.push({ key: mv.next, text: '', path: mv.old, value: null });
    }
  }
  const writeRows = rows.filter((r) => r.text === '');
  const display = rows.filter((r) => r.text !== '');
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    display.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, path: p, value: now });
  }
  display.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    const writes = [...display, ...writeRows];
    const done = new Set<string>();
    for (const r of writes) {
      if (done.has(r.path)) continue;
      done.add(r.path);
      if (r.value === null) rmSync(r.path, { force: true });
      else {
        mkdirSync(dirname(r.path), { recursive: true });
        writeFileSync(r.path, r.value);
      }
    }
    // Paths consumed by a rename whose new path row was already written still need the old file removed.
    for (const p of consumed) {
      if (!done.has(p)) {
        rmSync(p, { force: true });
      }
    }
  }
  return { code: 0, out: [...display.map((r) => r.text), `ok: ${display.length} ${display.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
