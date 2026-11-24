// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
  /** Moves a successful move edit made, in order, for the `R` output rows. */
  readonly moves: { old: string; new: string }[] = [];
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

type Edit = (tree: Tree) => void;

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
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

/** A file's text as lines (SPEC.md section 3). */
interface Split {
  lines: string[];
  br: '\r\n' | '\n';
  finalBreak: boolean;
}

function splitText(text: string): Split {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinText(s: Split): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.finalBreak ? s.br : '');
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function stripTrailing(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** One line of a hunk or chunk body; `backslash` is set when a `\` line follows it. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  backslash: boolean;
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailing(a) === stripTrailing(b);
  return stripBoth(a) === stripBoth(b);
}

function findOccurrences(file: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= file.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!lineEq(file[i + j]!, O[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(file: string[], O: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(file, O, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Split a body into old lines O, new lines N and, for each N line, the O index it is a context of (else null). */
function splitBody(body: BodyLine[]): { O: string[]; N: string[]; nSrc: (number | null)[] } {
  const O: string[] = [];
  const N: string[] = [];
  const nSrc: (number | null)[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') { nSrc.push(O.length); O.push(b.text); N.push(b.text); }
    else if (b.kind === 'old') O.push(b.text);
    else { N.push(b.text); nSrc.push(null); }
  }
  return { O, N, nSrc };
}

/** The lines N writes when it replaces O at position `at` (SPEC.md section 5). */
function buildReplacement(file: string[], at: number, O: string[], N: string[], nSrc: (number | null)[], tier: number): string[] {
  const F = tier === 2 ? leadingWS(file[at] ?? '') : '';
  const P = tier === 2 ? leadingWS(O[0] ?? '') : '';
  return N.map((line, j) => {
    const src = nSrc[j];
    if (src !== null && src !== undefined) return file[at + src]!;
    if (tier === 2 && line !== '' && !/^[ \t]+$/.test(line) && line.startsWith(P)) return F + line.slice(P.length);
    return line;
  });
}

function lastCtxOrNew(body: BodyLine[]): BodyLine | null {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') return body[i]!;
  }
  return null;
}

/* ---------- Unified diffs (SPEC.md section 6) ---------- */

interface UHunk {
  A: number;
  body: BodyLine[];
}

interface USection {
  oldPath: string;
  newPath: string;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UHunk[];
}

function parseDiffGit(line: string, lineNo: number): { x: string; y: string } {
  const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return { x: m[1]!, y: m[2]! };
}

/** The path of a `--- ` / `+++ ` line: after the four characters, up to the first tab, spaces removed. */
function headerPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

/** A leading `a/` or `b/` is removed from either path. */
function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function parseHunkHeader(line: string, lineNo: number): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return Number(m[1]);
}

function collectHunkBody(lines: string[], i: number): { body: BodyLine[]; next: number } {
  const body: BodyLine[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') { body.push({ kind: 'ctx', text: '', backslash: false }); j += 1; continue; }
    const c = l[0]!;
    if (c === ' ') { body.push({ kind: 'ctx', text: l.slice(1), backslash: false }); j += 1; continue; }
    if (c === '-') { body.push({ kind: 'old', text: l.slice(1), backslash: false }); j += 1; continue; }
    if (c === '+') { body.push({ kind: 'new', text: l.slice(1), backslash: false }); j += 1; continue; }
    if (c === '\\') { if (body.length > 0) body[body.length - 1]!.backslash = true; j += 1; continue; }
    break;
  }
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') body.pop();
    else break;
  }
  return { body, next: j };
}

function parseUnifiedSection(lines: string[], start: number, git: { x: string; y: string } | null): { section: USection; next: number } {
  let i = start;
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let renameOld: string | null = null;
  let renameNew: string | null = null;
  let isCreate = false;
  let isDelete = false;
  let havePair = false;
  const hunks: UHunk[] = [];
  if (git !== null) {
    i += 1;
  } else {
    oldPath = stripAB(headerPath(lines[i]!));
    newPath = stripAB(headerPath(lines[i + 1]!));
    havePair = true;
    i += 2;
  }
  for (;;) {
    if (i >= lines.length) break;
    const l = lines[i]!;
    if (l.startsWith('@@')) { parseHunkHeader(l, i + 1); break; }
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (!havePair) {
        oldPath = stripAB(headerPath(l));
        newPath = stripAB(headerPath(lines[i + 1]!));
        havePair = true;
        i += 2;
        continue;
      }
      break;
    }
    if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (l.startsWith('+++ ')) { newPath = stripAB(headerPath(l)); i += 1; continue; }
    if (l.startsWith('rename from ')) { renameOld = l.slice('rename from '.length).trim(); i += 1; continue; }
    if (l.startsWith('rename to ')) { renameNew = l.slice('rename to '.length).trim(); i += 1; continue; }
    if (l.startsWith('new file mode')) { isCreate = true; i += 1; continue; }
    if (l.startsWith('deleted file mode')) { isDelete = true; i += 1; continue; }
    i += 1;
  }
  for (;;) {
    if (i >= lines.length) break;
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) {
      const A = parseHunkHeader(l, i + 1);
      const r = collectHunkBody(lines, i + 1);
      hunks.push({ A, body: r.body });
      i = r.next;
      continue;
    }
    i += 1;
  }
  const oldP = oldPath ?? renameOld ?? (git === null ? null : git.x);
  const newP = newPath ?? renameNew ?? (git === null ? null : git.y);
  return { section: { oldPath: oldP!, newPath: newP!, isCreate, isDelete, hunks }, next: i };
}

function applyUnifiedHunks(before: string, hunks: UHunk[], strict: boolean, path: string): string {
  let cur = splitText(before);
  let d = 0;
  for (const h of hunks) {
    const { O, N, nSrc } = splitBody(h.body);
    if (O.length === 0) {
      const at = Math.max(0, Math.min(h.A + d, cur.lines.length));
      const newLines = [...cur.lines.slice(0, at), ...N, ...cur.lines.slice(at)];
      let finalBreak = cur.finalBreak;
      if (at === cur.lines.length) {
        const last = lastCtxOrNew(h.body);
        finalBreak = !(last !== null && last.backslash);
      }
      cur = { lines: newLines, br: cur.br, finalBreak };
      d += N.length;
    } else {
      const found = findTier(cur.lines, O, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let at = found.occ[0]!;
      let best = Math.abs(at - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < best) { at = pos; best = dist; }
      }
      const rep = buildReplacement(cur.lines, at, O, N, nSrc, found.tier);
      const newLines = [...cur.lines.slice(0, at), ...rep, ...cur.lines.slice(at + O.length)];
      let finalBreak = cur.finalBreak;
      if (at + O.length === cur.lines.length) {
        const last = lastCtxOrNew(h.body);
        finalBreak = !(last !== null && last.backslash);
      }
      cur = { lines: newLines, br: cur.br, finalBreak };
      d += N.length - O.length;
    }
  }
  return joinText(cur);
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== '/dev/null' && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== '/dev/null' && !safe(newP)) throw new Fail('unsafe', newP);
    const create = (oldP === '/dev/null' || sec.isCreate) && newP !== '/dev/null';
    const del = (newP === '/dev/null' || sec.isDelete) && oldP !== '/dev/null';
    if (create) {
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastBack = false;
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.kind === 'new') { plus.push(b.text); lastBack = b.backslash; }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastBack ? '' : '\n'));
      return;
    }
    if (del) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyUnifiedHunks(before, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push({ old: oldP, new: newP });
      return;
    }
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyUnifiedHunks(before, sec.hunks, strict, oldP));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const git = parseDiffGit(l, i + 1);
      const r = parseUnifiedSection(lines, i, git);
      edits.push(unifiedEdit(r.section, strict));
      i = r.next;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const r = parseUnifiedSection(lines, i, null);
      edits.push(unifiedEdit(r.section, strict));
      i = r.next;
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---------- SEARCH/REPLACE blocks (SPEC.md section 7) ---------- */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchIdx = i;
      let path: string | null = null;
      for (let j = searchIdx - 1; j > prevReplace; j -= 1) {
        const l = lines[j]!;
        if (blank(l)) continue;
        const t = l.trim();
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath !== null) path = prevPath;
        else throw new Exit2(`error: parse ${searchIdx + 1}`);
      }
      let k = searchIdx + 1;
      const oldLines: string[] = [];
      let foundSep = false;
      while (k < lines.length) {
        const t = lines[k]!.trimEnd();
        if (t === '=======') { foundSep = true; k += 1; break; }
        if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
        oldLines.push(lines[k]!);
        k += 1;
      }
      if (!foundSep) throw new Exit2(`error: parse ${searchIdx + 1}`);
      const newLines: string[] = [];
      let foundEnd = false;
      while (k < lines.length) {
        const t = lines[k]!.trimEnd();
        if (t === '>>>>>>> REPLACE') { foundEnd = true; k += 1; break; }
        if (t === '<<<<<<< SEARCH') break;
        newLines.push(lines[k]!);
        k += 1;
      }
      if (!foundEnd) throw new Exit2(`error: parse ${searchIdx + 1}`);
      blocks.push({ path, oldLines, newLines });
      prevPath = path;
      prevReplace = k - 1;
      i = k;
    } else {
      i += 1;
    }
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const cur = splitText(before);
    const found = findTier(cur.lines, b.oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const at = found.occ[0]!;
    const nSrc = b.newLines.map(() => null as number | null);
    const rep = buildReplacement(cur.lines, at, b.oldLines, b.newLines, nSrc, found.tier);
    const newLines = [...cur.lines.slice(0, at), ...rep, ...cur.lines.slice(at + b.oldLines.length)];
    tree.now.set(b.path, joinText({ lines: newLines, br: cur.br, finalBreak: cur.finalBreak }));
  };
}

/* ---------- V4A patches (SPEC.md section 8) ---------- */

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aAddEdit(path: string, fileLines: string[], hasNoEol = false): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + (hasNoEol ? '' : '\n'));
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4AChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let cur = splitText(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(cur.lines, [ch.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      const { O, N, nSrc } = splitBody(ch.body);
      if (O.length === 0) {
        const at = ch.eof ? cur.lines.length : cursor;
        const newLines = [...cur.lines.slice(0, at), ...N, ...cur.lines.slice(at)];
        cur = { lines: newLines, br: cur.br, finalBreak: cur.finalBreak };
        cursor = at + N.length;
      } else {
        const found = findTier(cur.lines, O, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        let at = found.occ[0]!;
        if (ch.eof) {
          const want = cur.lines.length - O.length;
          if (want < cursor || !found.occ.includes(want)) throw new Fail('no-match', path);
          at = want;
        }
        const rep = buildReplacement(cur.lines, at, O, N, nSrc, found.tier);
        const newLines = [...cur.lines.slice(0, at), ...rep, ...cur.lines.slice(at + O.length)];
        cur = { lines: newLines, br: cur.br, finalBreak: cur.finalBreak };
        cursor = at + rep.length;
      }
    }
    const text = joinText(cur);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  const end = last;
  let i = first + 1;
  while (i < end) {
    const line = lines[i]!;
    if (blank(line)) { i += 1; continue; }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const fileLines: string[] = [];
      let hasNoEol = false;
      i += 1;
      while (i < end) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l === '') { fileLines.push(''); i += 1; continue; }
        // A `\` line follows the last `+` line: the created file ends
        // without a break. A later `+` line supersedes it.
        if (l.startsWith('\\')) { hasNoEol = true; i += 1; continue; }
        if (l.startsWith('+')) { fileLines.push(l.slice(1)); hasNoEol = false; i += 1; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(v4aAddEdit(path, fileLines, hasNoEol));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < end) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (blank(l)) { i += 1; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLineNo = i + 1;
      i += 1;
      let moveTo: string | null = null;
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      let firstLine = true;
      const close = (): void => {
        if (cur !== null) { chunks.push(cur); cur = null; }
      };
      while (i < end) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (firstLine && l.startsWith('*** Move to: ')) {
          moveTo = l.slice('*** Move to: '.length).trim();
          firstLine = false;
          i += 1;
          continue;
        }
        firstLine = false;
        if (l.startsWith('@@')) {
          close();
          const a = l.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, body: [] };
          i += 1;
          continue;
        }
        if (l.trimEnd() === '*** End of File') {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          cur.eof = true;
          close();
          i += 1;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          // Only the first chunk may start at a body line; a later chunk
          // must start at an `@@` line. A blank line after a closed chunk
          // is ignored; any other body line there is a parse error.
          if (cur === null && chunks.length > 0) {
            if (l === '') { i += 1; continue; }
            throw new Exit2(`error: parse ${i + 1}`);
          }
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          if (l === '') cur.body.push({ kind: 'ctx', text: '', backslash: false });
          else if (l[0] === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1), backslash: false });
          else if (l[0] === '-') cur.body.push({ kind: 'old', text: l.slice(1), backslash: false });
          else cur.body.push({ kind: 'new', text: l.slice(1), backslash: false });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      close();
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.body.length > 0) {
          const b = lastChunk.body[lastChunk.body.length - 1]!;
          if (b.kind === 'ctx' && b.text === '') lastChunk.body.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

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
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const covered = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const m of tree.moves) {
    if (covered.has(m.old) || covered.has(m.new)) continue;
    if (tree.original(m.old) !== null && finalOf(m.old) === null && tree.original(m.new) === null && finalOf(m.new) !== null) {
      covered.add(m.old);
      covered.add(m.new);
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
    }
  }
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = finalOf(p);
    if (was === now) continue;
    if (covered.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = finalOf(p);
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
