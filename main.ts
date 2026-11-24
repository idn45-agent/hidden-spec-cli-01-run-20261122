// main.ts is mend, the CLI SPEC.md specifies: one tool that applies AI-written edits in four formats
// (unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls) to a tree of text files.
// It implements SPEC.md sections 1 to 10: the command line, output and exit codes, safe paths, format
// detection, three-tier line matching, all four format readers, and the all-or-nothing write.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over
// to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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
const rtrimWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A text file split the way SPEC.md section 3 splits it: its own break, its lines, its final break. */
interface Split {
  br: string;
  lines: string[];
  final: boolean;
}
function splitFile(text: string): Split {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}
function joinFile(sp: Split): string {
  if (sp.lines.length === 0) return '';
  return sp.lines.join(sp.br) + (sp.final ? sp.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
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

/** Strict is a run-wide flag the matchers read (SPEC.md section 5: tier 0 only). */
let strictMode = false;

/** Does one file line equal one patch line at a tier? */
function lineEq(fileLine: string, patchLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === patchLine;
  if (tier === 1) return rtrimWs(fileLine) === rtrimWs(patchLine);
  return trimWs(fileLine) === trimWs(patchLine);
}

/** Every start position where O matches the file lines at a tier, positions in [from, limit). */
function occurrencesAt(fileLines: string[], O: string[], tier: number, from: number, endAtLast: boolean): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= fileLines.length; i += 1) {
    if (endAtLast && i + O.length !== fileLines.length) continue;
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!lineEq(fileLines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * Find O in the file lines: the first tier that has an occurrence in range wins.
 * Returns the tier and every position at that tier, or null when O occurs at no tier.
 */
function findOccurrences(fileLines: string[], O: string[], from = 0, endAtLast = false): { tier: number; positions: number[] } | null {
  const tiers = strictMode ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrencesAt(fileLines, O, tier, from, endAtLast);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** Find a single anchor line at or after `from`: the first tier with a hit wins. */
function findAnchor(fileLines: string[], anchor: string, from: number): number | null {
  const tiers = strictMode ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < fileLines.length; i += 1) {
      if (lineEq(fileLines[i]!, anchor, tier)) return i;
    }
  }
  return null;
}

/**
 * Build the lines that replace the matched ones. `repl` walks N in order; an entry flagged as context
 * takes the file's own matched line at `ctxIndex`. At tier 2 the other lines are re-indented the way
 * SPEC.md section 5 describes: the first matched line's file indent F replaces O's first line's
 * indent P on every non-blank line of N that starts with P.
 */
function buildReplacement(fileLines: string[], pos: number, O: string[], repl: Array<{ text: string; ctx: number }>, tier: number): string[] {
  const F = leadWs(fileLines[pos] ?? '');
  const P = leadWs(O[0] ?? '');
  return repl.map((r) => {
    if (r.ctx >= 0) return fileLines[pos + r.ctx]!;
    if (tier === 2) {
      const t = r.text;
      // Every string starts with an empty P, so an unindented O still re-indents N by F.
      if (t !== '' && trimWs(t) !== '' && t.startsWith(P)) return F + t.slice(P.length);
      return t;
    }
    return r.text;
  });
}

/** Replace the matched block at `pos` with `built` inside a Split, keeping its break and final flag. */
function spliceLines(sp: Split, pos: number, count: number, built: string[]): void {
  sp.lines.splice(pos, count, ...built);
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

// ---------------------------------------------------------------- unified diffs (section 6)

interface HunkEntry {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}
interface Hunk {
  a: number;
  entries: HunkEntry[];
}
interface Section {
  gitOld: string | null;
  gitNew: string | null;
  hdrOld: string | null;
  hdrNew: string | null;
  sawPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

/** The path a --- or +++ line names: after the marker, up to a tab, spaces removed, /dev/null kept. */
function headerPath(raw: string): string {
  let t = raw.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return t;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}
function gitPaths(line: string, lineNo: number): [string, string] {
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return [m[1]!, m[2]!];
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const newSection = (): Section => {
    const s: Section = { gitOld: null, gitNew: null, hdrOld: null, hdrNew: null, sawPair: false, renameFrom: null, renameTo: null, isNew: false, isDel: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (line.startsWith('diff --git ')) {
      const [x, y] = gitPaths(line, lineNo);
      const s = newSection();
      s.gitOld = x;
      s.gitNew = y;
      i += 1;
      continue;
    }
    if (line.startsWith('diff --git')) {
      // A line that means to open a section but is not of the form is a parse fault.
      if (line.startsWith('diff --git')) throw new Exit2(`error: parse ${lineNo}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${lineNo}`);
      inHeader = false;
      const hunk: Hunk = { a: Number(m[1]), entries: [] };
      cur.hunks.push(hunk);
      i += 1;
      // The body: lines starting with ' ', '-', '+', '\' or empty, ending at the first other line,
      // at a diff --git line, or at a --- line followed by a +++ line.
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') hunk.entries.push({ kind: 'ctx', text: '' });
        else if (b[0] === ' ') hunk.entries.push({ kind: 'ctx', text: b.slice(1) });
        else if (b[0] === '-') hunk.entries.push({ kind: 'old', text: b.slice(1) });
        else if (b[0] === '+') hunk.entries.push({ kind: 'new', text: b.slice(1) });
        else if (b[0] === '\\') hunk.entries.push({ kind: 'bs', text: b.slice(1) });
        else break;
        i += 1;
      }
      // Empty lines at the end of a body are not part of it.
      while (hunk.entries.length > 0) {
        const last = hunk.entries[hunk.entries.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.entries.pop();
        else break;
      }
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (inHeader && cur !== null) {
        // Inside a section's header a --- line must be followed by a +++ line.
        if (!next.startsWith('+++ ')) throw new Exit2(`error: parse ${lineNo + 1}`);
        cur.hdrOld = headerPath(line);
        cur.hdrNew = headerPath(next);
        cur.sawPair = true;
        i += 2;
        continue;
      }
      if (next.startsWith('+++ ')) {
        const s = newSection();
        s.hdrOld = headerPath(line);
        s.hdrNew = headerPath(next);
        s.sawPair = true;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inHeader && cur !== null) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDel = true;
      // index, mode, similarity and every other header line are ignored.
    }
    i += 1;
  }
  return sections;
}

/** Does a backslash entry follow the last context-or-new entry of a hunk? */
function bsAfterLastWrite(hunk: Hunk): boolean {
  let lastWrite = -1;
  hunk.entries.forEach((e, idx) => {
    if (e.kind === 'ctx' || e.kind === 'new') lastWrite = idx;
  });
  if (lastWrite < 0) return false;
  return hunk.entries[lastWrite + 1]?.kind === 'bs';
}
function bsAfterLastPlus(hunks: Hunk[]): boolean {
  let found: HunkEntry[] = [];
  for (const h of hunks) {
    h.entries.forEach((e, idx) => {
      if (e.kind === 'new') found = h.entries.slice(0, idx + 2);
    });
  }
  // Recompute plainly: walk every entry, remember whether a \ followed the most recent + line.
  let lastPlusBs = false;
  let prevPlus = false;
  for (const h of hunks) {
    for (const e of h.entries) {
      if (e.kind === 'new') {
        prevPlus = true;
        lastPlusBs = false;
      } else if (e.kind === 'bs' && prevPlus) {
        lastPlusBs = true;
        prevPlus = false;
      } else {
        prevPlus = false;
      }
    }
  }
  void found;
  return lastPlusBs;
}

/** Apply one section's hunks to a Split; `reportPath` is the path failures name. Returns the result. */
function applyHunks(sp: Split, hunks: Hunk[], reportPath: string): Split {
  const out: Split = { br: sp.br, lines: [...sp.lines], final: sp.final };
  let d = 0;
  for (const hunk of hunks) {
    const O: string[] = [];
    const repl: Array<{ text: string; ctx: number }> = [];
    for (const e of hunk.entries) {
      if (e.kind === 'ctx') {
        repl.push({ text: e.text, ctx: O.length });
        O.push(e.text);
      } else if (e.kind === 'old') {
        O.push(e.text);
      } else if (e.kind === 'new') {
        repl.push({ text: e.text, ctx: -1 });
      }
    }
    if (O.length === 0) {
      const at = Math.min(Math.max(hunk.a + d, 0), out.lines.length);
      const atEnd = at === out.lines.length;
      const built = repl.map((r) => r.text);
      out.lines.splice(at, 0, ...built);
      if (atEnd) out.final = !bsAfterLastWrite(hunk);
      d += built.length;
      continue;
    }
    const found = findOccurrences(out.lines, O);
    if (found === null) throw new Fail('no-match', reportPath);
    const target = hunk.a - 1 + d;
    let pos = found.positions[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.positions) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        best = dist;
        pos = p;
      }
    }
    const built = buildReplacement(out.lines, pos, O, repl, found.tier);
    const atEnd = pos + O.length === out.lines.length;
    spliceLines(out, pos, O.length, built);
    if (atEnd) out.final = !bsAfterLastWrite(hunk);
    d += built.length - O.length;
  }
  return out;
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => {
    const oldPath = s.sawPair ? s.hdrOld : s.renameFrom ?? s.gitOld;
    const newPath = s.sawPair ? s.hdrNew : s.renameTo ?? s.gitNew;
    const creation = s.isNew || oldPath === '/dev/null';
    const deletion = s.isDel || newPath === '/dev/null';
    return (tree: Tree) => {
      // Safety of every path the edit names comes before anything else about it.
      if (oldPath !== null && oldPath !== '/dev/null' && !safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (newPath !== null && newPath !== '/dev/null' && !safe(newPath)) throw new Fail('unsafe', newPath);
      if (creation) {
        const p = newPath!;
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const made: string[] = [];
        for (const h of s.hunks) for (const e of h.entries) if (e.kind === 'new') made.push(e.text);
        const text = made.length === 0 ? '' : made.join('\n') + (bsAfterLastPlus(s.hunks) ? '' : '\n');
        tree.now.set(p, text);
        return;
      }
      if (deletion) {
        const p = oldPath!;
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const from = oldPath!;
      const to = newPath ?? from;
      const before = tree.get(from);
      if (before === null) throw new Fail('missing', from);
      if (to !== from && tree.get(to) !== null) throw new Fail('exists', to);
      const result = applyHunks(splitFile(before), s.hunks, from);
      if (to !== from) {
        tree.now.set(from, null);
        tree.now.set(to, joinFile(result));
        tree.moves.push([from, to]);
      } else {
        tree.now.set(from, joinFile(result));
      }
    };
  });
}

// ---------------------------------------------------------------- SEARCH/REPLACE blocks (section 7)

interface SRBlock {
  path: string | null;
  searchLine: number;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevPath: string | null = null;
  let boundary = 0; // first line index a block's path may come from
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    // The path: the nearest line before SEARCH, at or after the boundary, that is not blank
    // and whose trimmed text does not start with three backticks.
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= boundary; j -= 1) {
      const cand = lines[j]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    // Find ======= and then >>>>>>> REPLACE after the SEARCH line.
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, searchLine: searchIdx + 1, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, end) });
    prevPath = path;
    boundary = end + 1;
    i = end + 1;
  }
  return blocks;
}

function searchReplaceEdits(lines: string[]): Edit[] {
  const blocks = parseSearchReplace(lines);
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    const p = b.path!;
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (b.oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const sp = splitFile(before);
      const found = findOccurrences(sp.lines, b.oldLines);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const repl = b.newLines.map((t) => ({ text: t, ctx: -1 }));
      const built = buildReplacement(sp.lines, pos, b.oldLines, repl, found.tier);
      spliceLines(sp, pos, b.oldLines.length, built);
      tree.now.set(p, joinFile(sp));
    };
  });
}

// ---------------------------------------------------------------- V4A patches (section 8)

interface VChunk {
  anchor: string | null;
  eof: boolean;
  entries: Array<{ kind: 'ctx' | 'old' | 'new'; text: string }>;
}
interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  lineNo: number;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  const headerOf = (l: string): { kind: VSection['kind']; path: string } | null => {
    if (l.startsWith('*** Add File:')) return { kind: 'add', path: l.slice('*** Add File:'.length).trim() };
    if (l.startsWith('*** Delete File:')) return { kind: 'del', path: l.slice('*** Delete File:'.length).trim() };
    if (l.startsWith('*** Update File:')) return { kind: 'upd', path: l.slice('*** Update File:'.length).trim() };
    return null;
  };
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const hdr = headerOf(line);
    if (hdr === null) throw new Exit2(`error: parse ${i + 1}`);
    const sec: VSection = { kind: hdr.kind, path: hdr.path, lineNo: i + 1, addLines: [], moveTo: null, chunks: [] };
    sections.push(sec);
    i += 1;
    // Collect this section's raw lines, up to the next section or the End Patch line.
    const raw: Array<{ text: string; lineNo: number }> = [];
    while (i < last && headerOf(lines[i]!) === null) {
      raw.push({ text: lines[i]!, lineNo: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (sec.kind === 'add') {
      for (const r of raw) {
        if (r.text.startsWith('+')) sec.addLines.push(r.text.slice(1));
        else if (r.text === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${r.lineNo}`);
      }
    } else if (sec.kind === 'del') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.lineNo}`);
      }
    } else {
      // Update File: an optional Move to first, then chunks of body lines.
      let idx = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to:')) {
        sec.moveTo = raw[0]!.text.slice('*** Move to:'.length).trim();
        idx = 1;
      }
      let chunk: VChunk | null = null;
      const startChunk = (anchor: string | null): VChunk => {
        const c: VChunk = { anchor, eof: false, entries: [] };
        sec.chunks.push(c);
        return c;
      };
      for (; idx < raw.length; idx += 1) {
        const r = raw[idx]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          chunk = startChunk(t.slice(2).trim() === '' ? null : t.slice(2).trim());
        } else if (t.trim() === '*** End of File') {
          if (chunk === null) chunk = startChunk(null);
          chunk.eof = true;
          chunk = null;
        } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (chunk === null) chunk = startChunk(null);
          if (t === '') chunk.entries.push({ kind: 'ctx', text: '' });
          else if (t[0] === ' ') chunk.entries.push({ kind: 'ctx', text: t.slice(1) });
          else if (t[0] === '-') chunk.entries.push({ kind: 'old', text: t.slice(1) });
          else chunk.entries.push({ kind: 'new', text: t.slice(1) });
        } else {
          throw new Exit2(`error: parse ${r.lineNo}`);
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
    }
  }
  return sections;
}

function v4aEdits(lines: string[]): Edit[] {
  const sections = parseV4a(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => {
    const p = s.path;
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
      if (s.kind === 'add') {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
        return;
      }
      if (s.kind === 'del') {
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
      const sp = splitFile(before);
      let cursor = 0;
      for (const chunk of s.chunks) {
        if (chunk.anchor !== null) {
          const at = findAnchor(sp.lines, chunk.anchor, cursor);
          if (at === null) throw new Fail('no-match', p);
          cursor = at + 1;
        }
        const O: string[] = [];
        const repl: Array<{ text: string; ctx: number }> = [];
        for (const e of chunk.entries) {
          if (e.kind === 'ctx') {
            repl.push({ text: e.text, ctx: O.length });
            O.push(e.text);
          } else if (e.kind === 'old') O.push(e.text);
          else repl.push({ text: e.text, ctx: -1 });
        }
        if (O.length === 0) {
          const at = chunk.eof ? sp.lines.length : Math.min(cursor, sp.lines.length);
          const built = repl.map((r) => r.text);
          sp.lines.splice(at, 0, ...built);
          cursor = at + built.length;
          continue;
        }
        const found = findOccurrences(sp.lines, O, cursor, chunk.eof);
        if (found === null) throw new Fail('no-match', p);
        const pos = found.positions[0]!;
        const built = buildReplacement(sp.lines, pos, O, repl, found.tier);
        spliceLines(sp, pos, O.length, built);
        cursor = pos + built.length;
      }
      if (s.moveTo !== null) {
        tree.now.set(p, null);
        tree.now.set(s.moveTo, joinFile(sp));
        tree.moves.push([p, s.moveTo]);
      } else {
        tree.now.set(p, joinFile(sp));
      }
    };
  });
}

// ---------------------------------------------------------------- JSON edits (section 9)

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
      const sp = splitFile(before);
      if (line < 0 || line > sp.lines.length) throw new Fail('no-match', p);
      sp.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(sp));
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

// ---------------------------------------------------------------- invocation, output, atomicity (sections 1, 2, 10)

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
  strictMode = strict;
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
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines);
    else edits = v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One line per changed path, in byte order; a qualifying move replaces its D and A lines
  // with one R line that sorts by the new path, and counts once in the ok total.
  interface Row {
    key: string;
    line: string;
    paths: string[];
  }
  const rows: Row[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (covered.has(oldP) || covered.has(newP)) continue;
    const wasOld = tree.original(oldP);
    const nowOld = tree.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}`, paths: [oldP, newP] });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, paths: [p] });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const row of rows) {
      for (const p of row.paths) {
        const now = tree.get(p);
        if (now === null) rmSync(p, { force: true });
        else if (tree.original(p) !== now) {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, now);
        }
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
