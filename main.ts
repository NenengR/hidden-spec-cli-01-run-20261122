// mend — one CLI for the four edit formats AI models write. SPEC.md is the contract.
// Node 22 and its standard library only. A trial run hands over to runner.ts at the bottom.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

// A failure of the whole invocation (exit 2 with one fixed line), or of one edit (exit 1).
class Stop {
  line: string;
  constructor(line: string) { this.line = line; }
}
class Trouble {
  code: string;
  path: string;
  constructor(code: string, path: string) { this.code = code; this.path = path; }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Text, paths and files
// ---------------------------------------------------------------------------

function blank(s: string): boolean { return s.trim() === ''; }

/** SPEC section 3: patch lines split at \n, one trailing \r removed, no tail piece. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const pieces = text.split('\n');
  if (text.endsWith('\n')) pieces.pop();
  return pieces.map((s) => (s.endsWith('\r') ? s.slice(0, -1) : s));
}

function isSafe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') &&
    p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function checkPath(p: string): void {
  if (!isSafe(p)) throw new Trouble('unsafe', p);
}

interface FileText { br: string; lines: string[]; final: boolean; }

function readFileText(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], final: false };
  const firstLf = text.indexOf('\n');
  const br = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function renderFileText(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

interface Move { from: string; to: string; }

class Tree {
  private readonly base = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Move[] = [];

  original(p: string): string | null {
    if (!this.base.has(p)) {
      let value: string | null = null;
      try { if (statSync(p).isFile()) value = readFileSync(p, 'utf8'); } catch { value = null; }
      this.base.set(p, value);
    }
    return this.base.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  end(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

function needFile(tree: Tree, p: string): FileText {
  const text = tree.get(p);
  if (text === null) throw new Trouble('missing', p);
  return readFileText(text);
}

function putFile(tree: Tree, p: string, f: FileText): void {
  tree.now.set(p, renderFileText(f));
}

// ---------------------------------------------------------------------------
// Section 5: the three matching tiers
// ---------------------------------------------------------------------------

type Tier = 0 | 1 | 2;

function fold(s: string, tier: Tier): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function indentOf(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

interface Found { tier: Tier; where: number[]; }

/** First tier holding an occurrence; every occurrence at that tier (overlaps included). */
function findOld(old: string[], lines: string[], strict: boolean, from = 0, atEof = false): Found | null {
  const top: Tier = strict ? 0 : 2;
  for (let tier = 0 as Tier; tier <= top; tier = (tier + 1) as Tier) {
    const needle = old.map((s) => fold(s, tier));
    const hay = lines.map((s) => fold(s, tier));
    const where: number[] = [];
    for (let i = from; i + needle.length <= hay.length; i += 1) {
      if (atEof && i + needle.length !== hay.length) continue;
      let hit = true;
      for (let j = 0; j < needle.length; j += 1) {
        if (needle[j] !== hay[i + j]) { hit = false; break; }
      }
      if (hit) where.push(i);
    }
    if (where.length > 0) return { tier, where };
  }
  return null;
}

function findAnchor(anchor: string, lines: string[], from: number, strict: boolean): number {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    const goal = fold(anchor, tier as Tier);
    for (let i = from; i < lines.length; i += 1) {
      if (goal === fold(lines[i], tier as Tier)) return i;
    }
  }
  return -1;
}

/**
 * A replacement line is either a context line (oi points at the matched file line)
 * or a fresh line. Fresh lines get the tier-2 re-indent; context lines are the
 * file's own bytes.
 */
interface Slot { text: string; oi: number | null; }

function splice(f: FileText, at: number, remove: number, added: Slot[], tier: Tier,
                fileIndent: string, patchIndent: string, ending?: boolean): FileText {
  const lines = f.lines.slice(0, at);
  for (const slot of added) {
    if (slot.oi !== null) { lines.push(f.lines[at + slot.oi]); continue; }
    if (tier === 2 && slot.text.trim() !== '' && slot.text.startsWith(patchIndent)) {
      lines.push(fileIndent + slot.text.slice(patchIndent.length));
    } else {
      lines.push(slot.text);
    }
  }
  for (let i = at + remove; i < f.lines.length; i += 1) lines.push(f.lines[i]);
  return { br: f.br, lines, final: ending === undefined ? f.final : ending };
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

interface Hunk { start: number; old: string[]; neu: Slot[]; noNL: boolean; }
interface USection {
  line: number;
  gitOld: string | null; gitNew: string | null;
  dashOld: string | null; dashNew: string | null;
  from: string | null; to: string | null;
  creating: boolean; deleting: boolean;
  hunks: Hunk[];
}

function emptyUSection(line: number): USection {
  return { line, gitOld: null, gitNew: null, dashOld: null, dashNew: null,
    from: null, to: null, creating: false, deleting: false, hunks: [] };
}

function diffHeaderPath(rest: string): string {
  const p = rest.split('\t')[0].trim();
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let current: USection | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('@@')) {
      const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (current === null || head === null) throw new Stop(`error: parse ${i + 1}`);
      const start = Number(head[1]);
      i += 1;
      const body: string[] = [];
      while (i < lines.length) {
        const b = lines[i];
        if (b.startsWith('@@') || b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          body.push(b); i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();

      const old: string[] = [];
      const neu: Slot[] = [];
      for (const b of body) {
        if (b[0] === '\\') continue;
        if (b === '' || b[0] === ' ') {
          const text = b === '' ? '' : b.slice(1);
          old.push(text);
          neu.push({ text, oi: old.length - 1 });
        } else if (b[0] === '-') old.push(b.slice(1));
        else if (b[0] === '+') neu.push({ text: b.slice(1), oi: null });
      }
      let lastNew = -1;
      for (let j = 0; j < body.length; j += 1) {
        const c = body[j][0];
        if (body[j] === '' || c === ' ' || c === '+') lastNew = j;
      }
      const noNL = lastNew >= 0 && lastNew + 1 < body.length && body[lastNew + 1][0] === '\\';
      current.hunks.push({ start, old, neu, noNL });
      continue;
    }

    if (line.startsWith('diff --git ')) {
      const m = /^diff --git (\S+) (\S+)\s*$/.exec(line);
      if (m === null || !m[1].startsWith('a/') || !m[2].startsWith('b/')) {
        throw new Stop(`error: parse ${i + 1}`);
      }
      current = emptyUSection(i + 1);
      current.gitOld = m[1].slice(2);
      current.gitNew = m[2].slice(2);
      sections.push(current);
      i += 1;
      continue;
    }

    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (current === null || current.hunks.length > 0) {
        current = emptyUSection(i + 1);
        sections.push(current);
      }
      current.dashOld = diffHeaderPath(line.slice(4));
      current.dashNew = diffHeaderPath(lines[i + 1].slice(4));
      i += 2;
      continue;
    }

    if (current !== null && current.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Stop(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) current.from = line.slice(12).trim();
      else if (line.startsWith('rename to ')) current.to = line.slice(10).trim();
      else if (line.startsWith('new file mode')) current.creating = true;
      else if (line.startsWith('deleted file mode')) current.deleting = true;
      // index, modes, similarity and all other header or prose lines are ignored
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function applyUnified(f0: FileText, hunks: Hunk[], path: string, strict: boolean): FileText {
  let f = f0;
  let drift = 0;
  for (const h of hunks) {
    if (h.old.length === 0) {
      const at = Math.min(h.start + drift, f.lines.length);
      f = splice(f, at, 0, h.neu, 0, '', '', at === f.lines.length ? !h.noNL : undefined);
    } else {
      const hit = findOld(h.old, f.lines, strict);
      if (hit === null) throw new Trouble('no-match', path);
      const target = h.start - 1 + drift;
      let at = hit.where[0];
      let best = Infinity;
      for (const p of hit.where) {
        const distance = Math.abs(p - target);
        if (distance < best) { best = distance; at = p; }
      }
      const fileIndent = indentOf(f.lines[at]);
      const patchIndent = indentOf(h.old[0]);
      const touchesEnd = at + h.old.length === f.lines.length;
      f = splice(f, at, h.old.length, h.neu, hit.tier, fileIndent, patchIndent,
        touchesEnd ? !h.noNL : undefined);
    }
    drift += h.neu.length - h.old.length;
  }
  return f;
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  const oldPath = s.dashOld ?? s.from ?? s.gitOld;
  const newPath = s.dashNew ?? s.to ?? s.gitNew;
  return (tree) => {
    const oldName = oldPath === '/dev/null' ? null : oldPath;
    const newName = newPath === '/dev/null' ? null : newPath;
    if (oldName !== null) checkPath(oldName);
    if (newName !== null) checkPath(newName);

    if (s.creating || (oldName === null && newName !== null)) {
      if (newName === null) throw new Trouble('missing', '');
      if (tree.get(newName) !== null) throw new Trouble('exists', newName);
      const made: string[] = [];
      let ending = true;
      for (const h of s.hunks) {
        let any = false;
        for (const slot of h.neu) if (slot.oi === null) { made.push(slot.text); any = true; }
        if (any) ending = !h.noNL;
      }
      tree.now.set(newName, made.length === 0 ? '' : made.join('\n') + (ending ? '\n' : ''));
      return;
    }
    if (s.deleting || (newName === null && oldName !== null)) {
      if (oldName === null) throw new Trouble('missing', '');
      if (tree.get(oldName) === null) throw new Trouble('missing', oldName);
      tree.now.set(oldName, null);
      return;
    }
    if (oldName === null) throw new Stop(`error: parse ${s.line}`);
    if (tree.get(oldName) === null) throw new Trouble('missing', oldName);
    const moving = newName !== null && newName !== oldName;
    if (moving && tree.get(newName!) !== null) throw new Trouble('exists', newName!);
    const result = applyUnified(needFile(tree, oldName), s.hunks, oldName, strict);
    if (moving) {
      tree.now.set(newName!, renderFileText(result));
      tree.now.set(oldName, null);
      tree.moves.push({ from: oldName, to: newName! });
    } else {
      tree.now.set(oldName, renderFileText(result));
    }
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

interface Block { path: string; old: string[]; neu: string[]; }

function parseBlocks(lines: string[], strict: boolean): Edit[] {
  const blocks: Block[] = [];
  let after = 0;
  let previous: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const report = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= after; j -= 1) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t; break;
    }
    if (path === null) path = previous;
    if (path === null) throw new Stop(`error: parse ${report}`);

    let divider = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trimEnd() === '=======') { divider = j; break; }
    }
    if (divider < 0) throw new Stop(`error: parse ${report}`);
    let close = -1;
    for (let j = divider + 1; j < lines.length; j += 1) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') { close = j; break; }
    }
    if (close < 0) throw new Stop(`error: parse ${report}`);

    blocks.push({ path, old: lines.slice(i + 1, divider), neu: lines.slice(divider + 1, close) });
    previous = path;
    after = close + 1;
    i = close + 1;
  }
  return blocks.map((b) => blockEdit(b, strict));
}

function blockEdit(b: Block, strict: boolean): Edit {
  return (tree) => {
    checkPath(b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Trouble('exists', b.path);
      tree.now.set(b.path, b.neu.length === 0 ? '' : b.neu.join('\n') + '\n');
      return;
    }
    const f = needFile(tree, b.path);
    const hit = findOld(b.old, f.lines, strict);
    if (hit === null) throw new Trouble('no-match', b.path);
    if (hit.where.length > 1) throw new Trouble('ambiguous', b.path);
    const at = hit.where[0];
    const added: Slot[] = b.neu.map((text) => ({ text, oi: null }));
    putFile(tree, b.path, splice(f, at, b.old.length, added, hit.tier,
      indentOf(f.lines[at]), indentOf(b.old[0])));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

interface Chunk { anchor: string | null; eof: boolean; old: string[]; neu: Slot[]; }
interface VSection {
  kind: 'add' | 'delete' | 'update';
  line: number; path: string; move: string | null;
  lines: string[]; chunks: Chunk[];
}

const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';
const EOF_MARK = '*** End of File';

function vSectionStart(s: string): boolean {
  return s.startsWith(ADD) || s.startsWith(DELETE) || s.startsWith(UPDATE);
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const start = lines.findIndex((l) => !blank(l));
  if (start < 0) throw new Stop('error: parse 1');
  if (lines[start].trim() !== '*** Begin Patch') throw new Stop(`error: parse ${start + 1}`);
  let stop = lines.length - 1;
  while (stop >= 0 && blank(lines[stop])) stop -= 1;
  if (stop < start || lines[stop].trim() !== '*** End Patch') {
    throw new Stop(`error: parse ${lines.length + 1}`);
  }

  const sections: VSection[] = [];
  let i = start + 1;
  while (i < stop) {
    const line = lines[i];
    if (blank(line)) { i += 1; continue; }
    if (!vSectionStart(line)) throw new Stop(`error: parse ${i + 1}`);
    const at = i + 1;

    if (line.startsWith(ADD)) {
      const path = line.slice(ADD.length).trim();
      i += 1;
      const raw: { line: string; no: number }[] = [];
      while (i < stop && !vSectionStart(lines[i])) { raw.push({ line: lines[i], no: i + 1 }); i += 1; }
      while (raw.length > 0 && blank(raw[raw.length - 1].line)) raw.pop();
      const body: string[] = [];
      for (const r of raw) {
        if (r.line === '') body.push('');
        else if (r.line[0] === '+') body.push(r.line.slice(1));
        else throw new Stop(`error: parse ${r.no}`);
      }
      sections.push({ kind: 'add', line: at, path, move: null, lines: body, chunks: [] });
    } else if (line.startsWith(DELETE)) {
      const path = line.slice(DELETE.length).trim();
      i += 1;
      while (i < stop && !vSectionStart(lines[i])) {
        if (!blank(lines[i])) throw new Stop(`error: parse ${i + 1}`);
        i += 1;
      }
      sections.push({ kind: 'delete', line: at, path, move: null, lines: [], chunks: [] });
    } else {
      const path = line.slice(UPDATE.length).trim();
      i += 1;
      let move: string | null = null;
      if (i < stop && lines[i].startsWith(MOVE)) { move = lines[i].slice(MOVE.length).trim(); i += 1; }
      const chunks: Chunk[] = [];

      while (i < stop && !vSectionStart(lines[i])) {
        if (blank(lines[i])) { i += 1; continue; }
        const head = lines[i];
        let anchor: string | null = null;
        let eof = false;
        if (head.startsWith('@@')) {
          anchor = head.slice(2).trim();
          if (anchor === '') anchor = null;
          i += 1;
        } else if (head.trim() === EOF_MARK) {
          eof = true; i += 1;
        } else if (chunks.length === 0 && (head[0] === ' ' || head[0] === '-' || head[0] === '+' || head === '')) {
          // only the first chunk may start straight at a body line
        } else throw new Stop(`error: parse ${i + 1}`);

        const raw: { line: string; no: number }[] = [];
        while (i < stop && !vSectionStart(lines[i])) {
          const b = lines[i];
          if (b.startsWith('@@') || b.startsWith(MOVE)) break;
          if (b.trim() === EOF_MARK) { eof = true; i += 1; break; }
          raw.push({ line: b, no: i + 1 }); i += 1;
        }
        while (raw.length > 0 && blank(raw[raw.length - 1].line)) raw.pop();
        const old: string[] = [];
        const neu: Slot[] = [];
        for (const r of raw) {
          const b = r.line;
          if (b === '' || b[0] === ' ') {
            const t = b === '' ? '' : b.slice(1);
            old.push(t); neu.push({ text: t, oi: old.length - 1 });
          } else if (b[0] === '-') old.push(b.slice(1));
          else if (b[0] === '+') neu.push({ text: b.slice(1), oi: null });
          else throw new Stop(`error: parse ${r.no}`);
        }
        chunks.push({ anchor, eof, old, neu });
      }
      if (chunks.length === 0 && move === null) throw new Stop(`error: parse ${at}`);
      sections.push({ kind: 'update', line: at, path, move, lines: [], chunks });
    }
  }
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    checkPath(s.path);
    if (s.move !== null) checkPath(s.move);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Trouble('exists', s.path);
      tree.now.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      return;
    }
    let f = needFile(tree, s.path);
    if (s.kind === 'delete') { tree.now.set(s.path, null); return; }
    if (s.move !== null && tree.get(s.move) !== null) throw new Trouble('exists', s.move);

    let cursor = 0;
    for (const ch of s.chunks) {
      let from = cursor;
      if (ch.anchor !== null) {
        const a = findAnchor(ch.anchor, f.lines, cursor, strict);
        if (a < 0) throw new Trouble('no-match', s.path);
        from = a + 1;
        cursor = from;
      }
      if (ch.old.length === 0) {
        const at = ch.eof ? f.lines.length : Math.min(from, f.lines.length);
        f = splice(f, at, 0, ch.neu, 0, '', '');
        cursor = at + ch.neu.length;
      } else {
        const hit = findOld(ch.old, f.lines, strict, from, ch.eof);
        if (hit === null) throw new Trouble('no-match', s.path);
        const at = hit.where[0];
        f = splice(f, at, ch.old.length, ch.neu, hit.tier,
          indentOf(f.lines[at]), indentOf(ch.old[0]));
        cursor = at + ch.neu.length;
      }
    }
    if (s.move !== null) {
      tree.now.set(s.move, renderFileText(f));
      tree.now.set(s.path, null);
      tree.moves.push({ from: s.path, to: s.move });
    } else {
      tree.now.set(s.path, renderFileText(f));
    }
  };
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits
// ---------------------------------------------------------------------------

function jsonEdit(value: unknown): Edit | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const path = o.path;

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const content = o.file_text;
    return (tree) => {
      checkPath(path);
      if (tree.get(path) !== null) throw new Trouble('exists', path);
      tree.now.set(path, content);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' &&
      (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      checkPath(path);
      const before = tree.get(path);
      if (before === null) throw new Trouble('missing', path);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Trouble('no-match', path);
      if (count > 1) throw new Trouble('ambiguous', path);
      const k = text.indexOf(old);
      const out = text.slice(0, k) + lf(newStr) + text.slice(k + old.length);
      tree.now.set(path, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' &&
      Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const added = patchLines(o.new_str);
    return (tree) => {
      checkPath(path);
      const f = needFile(tree, path);
      if (line < 0 || line > f.lines.length) throw new Trouble('no-match', path);
      const slots: Slot[] = added.map((text) => ({ text, oi: null }));
      putFile(tree, path, splice(f, line, 0, slots, 0, '', ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Stop('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Stop(`error: parse ${first + 1}`); }
    if (!Array.isArray(value)) throw new Stop(`error: parse ${first + 1}`);
    for (const item of value) {
      const e = jsonEdit(item);
      if (e === null) throw new Stop(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((line, i) => {
    if (blank(line)) return;
    let e: Edit | null = null;
    try { e = jsonEdit(JSON.parse(line)); } catch { e = null; }
    if (e === null) throw new Stop(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Sections 1-4 and 10: invocation, detection, output, atomicity
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return 'unified';
  }
  return null;
}

interface Options { format: string | null; check: boolean; strict: boolean; patch: string | null; }

function options(args: string[]): Options | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let ended = false;
  const positional: string[] = [];
  for (const a of args) {
    if (!ended && a === '--') { ended = true; continue; }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice(9);
        if (format !== null || !FORMAT_NAMES.includes(v)) return null;
        format = v;
      } else if (a === '--check') {
        if (check) return null;
        check = true;
      } else if (a === '--strict') {
        if (strict) return null;
        strict = true;
      } else return null;
    } else positional.push(a);
  }
  if (positional.length > 1) return null;
  const patch = positional.length === 0 || positional[0] === '-' ? null : positional[0];
  return { format, check, strict, patch };
}

function run(args: string[]): { code: number; out: string[] } {
  const opt = options(args);
  if (opt === null) return { code: 2, out: ['error: usage'] };

  let text = '';
  try { text = readFileSync(opt.patch ?? 0, 'utf8'); }
  catch { if (opt.patch !== null) return { code: 2, out: ['error: no-patch'] }; }

  const lines = patchLines(text);
  const kind = opt.format === null || opt.format === 'auto' ? detect(lines) : opt.format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, opt.strict);
    else if (kind === 'search-replace') edits = parseBlocks(lines, opt.strict);
    else edits = parseV4A(lines, opt.strict);
    if (edits.length === 0) throw new Stop('error: parse 1');
  } catch (e) {
    if (e instanceof Stop) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const failures: Trouble[] = [];
  for (const edit of edits) {
    const saved = new Map(tree.now);
    const moveCount = tree.moves.length;
    try { edit(tree); }
    catch (e) {
      if (!(e instanceof Trouble)) throw e;
      tree.now.clear();
      for (const [p, v] of saved) tree.now.set(p, v);
      tree.moves.length = moveCount;
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return { code: 1, out: [
      ...failures.map((f) => `error: ${f.code} ${f.path}`),
      `failed: ${failures.length} of ${edits.length} edits`,
    ] };
  }

  // A move is shown as one R line when the old path is gone and the new one is new.
  const renames: Move[] = [];
  for (const m of tree.moves) {
    if (tree.original(m.from) !== null && tree.end(m.from) === null &&
        tree.original(m.to) === null && tree.end(m.to) !== null) renames.push(m);
  }
  const insideRename = new Set<string>();
  for (const m of renames) { insideRename.add(m.from); insideRename.add(m.to); }

  const rows: { key: string; text: string }[] = [];
  for (const [p, value] of tree.now) {
    if (tree.original(p) === value || insideRename.has(p)) continue;
    rows.push({ key: p, text: `${tree.original(p) === null ? 'A' : value === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of renames) rows.push({ key: m.to, text: `R ${m.from} -> ${m.to}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.text);

  if (!opt.check) {
    for (const [p, value] of tree.now) {
      if (tree.original(p) === value) continue;
      if (value === null) rmSync(p, { force: true });
      else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, value); }
    }
  }
  out.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
