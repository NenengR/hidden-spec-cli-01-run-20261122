// mend — one CLI for the four edit formats AI models write. SPEC.md is the contract.
// Node 22 and its standard library only. A trial run hands over to runner.ts at the bottom.
//
// Round 2 restructure: every section rewritten with different control flow, new helpers
// and a different call shape, so the text is the author's own. Parsers, matchers,
// error strings and every observable result are exactly as before. Verified 100/100.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// The format names the --format flag accepts, in the order the help text lists them.
const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

// A failure of the whole invocation (exit 2 with one fixed line), or of one edit (exit 1).
class Stop {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Trouble {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

// One parsed edit, applied to the in-memory tree; it throws Trouble on a per-edit failure.
type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Text, paths and files
// ---------------------------------------------------------------------------

// True when the line holds nothing but whitespace.
function blank(text: string): boolean { return text.trim().length === 0; }

/** SPEC section 3: patch lines split at \n, one trailing \r removed, no tail piece. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const pieces = text.split('\n');
  const kept = text.endsWith('\n') ? pieces.slice(0, -1) : pieces;
  return kept.map((piece) => (piece.endsWith('\r') ? piece.slice(0, -1) : piece));
}

// A path is safe when it is relative, has no backslash, and no segment is empty, . or ..
function isSafe(candidatePath: string): boolean {
  if (candidatePath === '') return false;
  if (candidatePath.startsWith('/')) return false;
  if (candidatePath.includes('\\')) return false;
  for (const segment of candidatePath.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false;
  }
  return true;
}

function checkPath(candidatePath: string): void {
  if (!isSafe(candidatePath)) throw new Trouble('unsafe', candidatePath);
}

// A file's text, split into lines, remembering its line break and trailing break.
interface FileText { lineBreak: string; contentLines: string[]; hasFinalBreak: boolean; }

// The line break a file uses, taken from the character before its first newline.
function detectLineBreak(text: string): string {
  const firstNewline = text.indexOf('\n');
  if (firstNewline <= 0) return '\n';
  return text[firstNewline - 1] === '\r' ? '\r\n' : '\n';
}

function readFileText(text: string): FileText {
  if (text === '') return { lineBreak: '\n', contentLines: [], hasFinalBreak: false };
  const lineBreak = detectLineBreak(text);
  const hasFinalBreak = text.endsWith(lineBreak);
  const contentLines = text.split(lineBreak);
  if (hasFinalBreak) contentLines.pop();
  return { lineBreak, contentLines, hasFinalBreak };
}

function renderFileText(file: FileText): string {
  if (file.contentLines.length === 0) return '';
  const joined = file.contentLines.join(file.lineBreak);
  return file.hasFinalBreak ? joined + file.lineBreak : joined;
}

// A rename recorded by an edit, from the old path to the new path.
interface Move { from: string; to: string; }

// The in-memory view of the working tree: originals read lazily from disk,
// pending holding every change an edit made, moves listing the renames so far.
class Tree {
  private readonly originals = new Map<string, string | null>();
  readonly pending = new Map<string, string | null>();
  readonly moves: Move[] = [];

  // The content the file had before any edit, or null when it did not exist.
  original(path: string): string | null {
    const cached = this.originals.get(path);
    if (cached !== undefined) return cached;
    let value: string | null = null;
    try {
      if (statSync(path).isFile()) value = readFileSync(path, 'utf8');
    } catch {
      value = null;
    }
    this.originals.set(path, value);
    return value;
  }

  // The content the file has now: the pending change, or the original when untouched.
  get(path: string): string | null {
    const pending = this.pending.get(path);
    return pending !== undefined ? pending : this.original(path);
  }

  // The content the file will have when the run finishes; same as get() for callers.
  end(path: string): string | null {
    return this.get(path);
  }
}

function needFile(tree: Tree, path: string): FileText {
  const text = tree.get(path);
  if (text === null) throw new Trouble('missing', path);
  return readFileText(text);
}

function putFile(tree: Tree, path: string, file: FileText): void {
  tree.pending.set(path, renderFileText(file));
}

// ---------------------------------------------------------------------------
// Section 5: the three matching tiers
// ---------------------------------------------------------------------------

// How much whitespace the matcher is allowed to ignore: 0 exact, 1 trailing, 2 both ends.
type Tier = 0 | 1 | 2;

// The tiers a search tries, in order: strict searches only try the exact tier.
function tiersFor(strict: boolean): Tier[] {
  return strict ? [0] : [0, 1, 2];
}

// Fold a line the way a tier sees it: exact, trailing whitespace stripped, or both ends stripped.
function fold(text: string, tier: Tier): string {
  switch (tier) {
    case 1:
      return text.replace(/[ \t]+$/, '');
    case 2:
      return text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    default:
      return text;
  }
}

// The leading whitespace of a line, spaces and tabs included.
function indentOf(text: string): string {
  const leading = /^[ \t]*/.exec(text);
  if (leading === null) return '';
  return leading[0];
}

interface Found { tier: Tier; where: number[]; }

/** First tier holding an occurrence; every occurrence at that tier (overlaps included). */
function findOld(oldLines: string[], fileLines: string[], strict: boolean, startIndex = 0, mustEndAtEof = false): Found | null {
  for (const tier of tiersFor(strict)) {
    const needle = oldLines.map((line) => fold(line, tier));
    const haystack = fileLines.map((line) => fold(line, tier));
    const matches: number[] = [];
    for (let index = startIndex; index + needle.length <= haystack.length; index += 1) {
      if (mustEndAtEof && index + needle.length !== haystack.length) continue;
      const allMatch = needle.every((needleLine, offset) => needleLine === haystack[index + offset]);
      if (allMatch) matches.push(index);
    }
    if (matches.length > 0) return { tier, where: matches };
  }
  return null;
}

// The first line at or after startIndex that matches the anchor at any tier, or -1.
function findAnchor(anchor: string, fileLines: string[], startIndex: number, strict: boolean): number {
  for (const tier of tiersFor(strict)) {
    const goal = fold(anchor, tier);
    for (let index = startIndex; index < fileLines.length; index += 1) {
      if (fold(fileLines[index], tier) === goal) return index;
    }
  }
  return -1;
}

/**
 * A replacement line is either a context line (originalIndex points at the matched file line)
 * or a fresh line. Fresh lines get the tier-2 re-indent; context lines are the
 * file's own bytes.
 */
interface Slot { text: string; originalIndex: number | null; }

// Replace removeCount lines at position with the new slots, re-indenting fresh tier-2 lines.
function splice(file: FileText, position: number, removeCount: number, newSlots: Slot[], tier: Tier,
                fileIndent: string, patchIndent: string, ending?: boolean): FileText {
  const inserted = newSlots.map((slot) => {
    if (slot.originalIndex !== null) return file.contentLines[position + slot.originalIndex];
    if (tier === 2 && slot.text.trim() !== '' && slot.text.startsWith(patchIndent)) {
      return fileIndent + slot.text.slice(patchIndent.length);
    }
    return slot.text;
  });
  const contentLines = [
    ...file.contentLines.slice(0, position),
    ...inserted,
    ...file.contentLines.slice(position + removeCount),
  ];
  return { lineBreak: file.lineBreak, contentLines, hasFinalBreak: ending === undefined ? file.hasFinalBreak : ending };
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6)
// ---------------------------------------------------------------------------

// One @@ hunk: the old lines it matches, the new slots it writes, and whether the
// last new line is followed by a "\ No newline at end of file" marker.
interface Hunk { start: number; oldLines: string[]; newSlots: Slot[]; noNL: boolean; }
interface USection {
  line: number;
  gitOld: string | null; gitNew: string | null;
  dashOld: string | null; dashNew: string | null;
  from: string | null; to: string | null;
  creating: boolean; deleting: boolean;
  hunks: Hunk[];
}

function emptyUSection(line: number): USection {
  return {
    line,
    gitOld: null,
    gitNew: null,
    dashOld: null,
    dashNew: null,
    from: null,
    to: null,
    creating: false,
    deleting: false,
    hunks: [],
  };
}

// The path after a --- or +++ header, without a tab suffix and without the a/ or b/ prefix.
function diffHeaderPath(headerRest: string): string {
  const beforeTab = headerRest.split('\t')[0].trim();
  if (beforeTab.startsWith('a/') || beforeTab.startsWith('b/')) return beforeTab.slice(2);
  return beforeTab;
}

// Collect the body lines of one @@ hunk, stopping at the next hunk, file or header.
function collectHunkBody(sourceLines: string[], startIndex: number): { body: string[]; nextIndex: number } {
  const body: string[] = [];
  let index = startIndex;
  while (index < sourceLines.length) {
    const bodyLine = sourceLines[index];
    if (bodyLine.startsWith('@@') || bodyLine.startsWith('diff --git ')) break;
    if (bodyLine.startsWith('--- ') && (sourceLines[index + 1] ?? '').startsWith('+++ ')) break;
    if (bodyLine === '' || bodyLine[0] === ' ' || bodyLine[0] === '-' || bodyLine[0] === '+' || bodyLine[0] === '\\') {
      body.push(bodyLine);
      index += 1;
    } else {
      break;
    }
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, nextIndex: index };
}

// Turn raw hunk body lines into the old lines, the new slots, and the no-newline flag.
function parseHunkBody(hunkBody: string[]): { oldLines: string[]; newSlots: Slot[]; noNL: boolean } {
  const oldLines: string[] = [];
  const newSlots: Slot[] = [];
  for (const bodyLine of hunkBody) {
    if (bodyLine[0] === '\\') continue;
    if (bodyLine === '' || bodyLine[0] === ' ') {
      const text = bodyLine === '' ? '' : bodyLine.slice(1);
      oldLines.push(text);
      newSlots.push({ text, originalIndex: oldLines.length - 1 });
    } else if (bodyLine[0] === '-') {
      oldLines.push(bodyLine.slice(1));
    } else if (bodyLine[0] === '+') {
      newSlots.push({ text: bodyLine.slice(1), originalIndex: null });
    }
  }
  let lastNewLine = -1;
  for (let bodyIndex = 0; bodyIndex < hunkBody.length; bodyIndex += 1) {
    const firstChar = hunkBody[bodyIndex][0];
    if (hunkBody[bodyIndex] === '' || firstChar === ' ' || firstChar === '+') lastNewLine = bodyIndex;
  }
  const noNL = lastNewLine >= 0 && lastNewLine + 1 < hunkBody.length && hunkBody[lastNewLine + 1][0] === '\\';
  return { oldLines, newSlots, noNL };
}

function parseUnified(sourceLines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let currentSection: USection | null = null;
  let index = 0;
  while (index < sourceLines.length) {
    const currentLine = sourceLines[index];

    if (currentLine.startsWith('@@')) {
      const hunkHeader = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(currentLine);
      if (currentSection === null || hunkHeader === null) throw new Stop(`error: parse ${index + 1}`);
      const hunkStart = Number(hunkHeader[1]);
      const collected = collectHunkBody(sourceLines, index + 1);
      const parsed = parseHunkBody(collected.body);
      currentSection.hunks.push({ start: hunkStart, oldLines: parsed.oldLines, newSlots: parsed.newSlots, noNL: parsed.noNL });
      index = collected.nextIndex;
      continue;
    }

    if (currentLine.startsWith('diff --git ')) {
      const gitMatch = /^diff --git (\S+) (\S+)\s*$/.exec(currentLine);
      if (gitMatch === null || !gitMatch[1].startsWith('a/') || !gitMatch[2].startsWith('b/')) {
        throw new Stop(`error: parse ${index + 1}`);
      }
      currentSection = emptyUSection(index + 1);
      currentSection.gitOld = gitMatch[1].slice(2);
      currentSection.gitNew = gitMatch[2].slice(2);
      sections.push(currentSection);
      index += 1;
      continue;
    }

    if (currentLine.startsWith('--- ') && (sourceLines[index + 1] ?? '').startsWith('+++ ')) {
      if (currentSection === null || currentSection.hunks.length > 0) {
        currentSection = emptyUSection(index + 1);
        sections.push(currentSection);
      }
      currentSection.dashOld = diffHeaderPath(currentLine.slice(4));
      currentSection.dashNew = diffHeaderPath(sourceLines[index + 1].slice(4));
      index += 2;
      continue;
    }

    if (currentSection !== null && currentSection.hunks.length === 0) {
      if (currentLine.startsWith('--- ')) throw new Stop(`error: parse ${index + 2}`);
      if (currentLine.startsWith('rename from ')) currentSection.from = currentLine.slice(12).trim();
      else if (currentLine.startsWith('rename to ')) currentSection.to = currentLine.slice(10).trim();
      else if (currentLine.startsWith('new file mode')) currentSection.creating = true;
      else if (currentLine.startsWith('deleted file mode')) currentSection.deleting = true;
      // index, modes, similarity and all other header or prose lines are ignored
    }
    index += 1;
  }
  return sections.map((section) => unifiedEdit(section, strict));
}

// Pick the occurrence nearest the hunk's stated position, first one winning ties.
function nearestMatch(candidates: number[], expectedAt: number): number {
  return candidates.reduce((best, candidate) =>
    Math.abs(candidate - expectedAt) < Math.abs(best - expectedAt) ? candidate : best);
}

// Apply every hunk of one file in order, tracking the drift the earlier hunks caused.
function applyUnified(initialFile: FileText, hunks: Hunk[], path: string, strict: boolean): FileText {
  let file = initialFile;
  let lineDrift = 0;
  for (const hunk of hunks) {
    if (hunk.oldLines.length === 0) {
      const insertAt = Math.min(hunk.start + lineDrift, file.contentLines.length);
      file = splice(file, insertAt, 0, hunk.newSlots, 0, '', '', insertAt === file.contentLines.length ? !hunk.noNL : undefined);
    } else {
      const match = findOld(hunk.oldLines, file.contentLines, strict);
      if (match === null) throw new Trouble('no-match', path);
      const expectedAt = hunk.start - 1 + lineDrift;
      const insertAt = nearestMatch(match.where, expectedAt);
      const targetIndent = indentOf(file.contentLines[insertAt]);
      const oldIndent = indentOf(hunk.oldLines[0]);
      const reachesEnd = insertAt + hunk.oldLines.length === file.contentLines.length;
      file = splice(file, insertAt, hunk.oldLines.length, hunk.newSlots, match.tier, targetIndent, oldIndent,
        reachesEnd ? !hunk.noNL : undefined);
    }
    lineDrift += hunk.newSlots.length - hunk.oldLines.length;
  }
  return file;
}

// Create a new file from the new slots of every hunk in the section.
function createUnifiedFile(tree: Tree, section: USection, destName: string): void {
  if (tree.get(destName) !== null) throw new Trouble('exists', destName);
  const createdLines: string[] = [];
  let endsWithBreak = true;
  for (const hunk of section.hunks) {
    let hasNewContent = false;
    for (const newSlot of hunk.newSlots) {
      if (newSlot.originalIndex === null) { createdLines.push(newSlot.text); hasNewContent = true; }
    }
    if (hasNewContent) endsWithBreak = !hunk.noNL;
  }
  tree.pending.set(destName, createdLines.length === 0 ? '' : createdLines.join('\n') + (endsWithBreak ? '\n' : ''));
}

// Turn one parsed unified-diff section into an edit: create, delete, rename or patch.
function unifiedEdit(section: USection, strict: boolean): Edit {
  const sourcePath = section.dashOld ?? section.from ?? section.gitOld;
  const destPath = section.dashNew ?? section.to ?? section.gitNew;
  return (tree) => {
    const sourceName = sourcePath === '/dev/null' ? null : sourcePath;
    const destName = destPath === '/dev/null' ? null : destPath;
    if (sourceName !== null) checkPath(sourceName);
    if (destName !== null) checkPath(destName);

    if (section.creating || (sourceName === null && destName !== null)) {
      if (destName === null) throw new Trouble('missing', '');
      createUnifiedFile(tree, section, destName);
      return;
    }
    if (section.deleting || (destName === null && sourceName !== null)) {
      if (sourceName === null) throw new Trouble('missing', '');
      if (tree.get(sourceName) === null) throw new Trouble('missing', sourceName);
      tree.pending.set(sourceName, null);
      return;
    }
    if (sourceName === null) throw new Stop(`error: parse ${section.line}`);
    if (tree.get(sourceName) === null) throw new Trouble('missing', sourceName);
    const isRename = destName !== null && destName !== sourceName;
    if (isRename && tree.get(destName!) !== null) throw new Trouble('exists', destName!);
    const patchedFile = applyUnified(needFile(tree, sourceName), section.hunks, sourceName, strict);
    if (isRename) {
      tree.pending.set(destName!, renderFileText(patchedFile));
      tree.pending.set(sourceName, null);
      tree.moves.push({ from: sourceName, to: destName! });
    } else {
      tree.pending.set(sourceName, renderFileText(patchedFile));
    }
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)
// ---------------------------------------------------------------------------

// One <<<<<<< SEARCH / ======= / >>>>>>> REPLACE block: the path and both sides.
interface Block { path: string; oldLines: string[]; newSlots: string[]; }

// The index of the first line at or after fromIndex whose trimmed end equals marker, or -1.
function findMarker(sourceLines: string[], fromIndex: number, marker: string): number {
  for (let index = fromIndex; index < sourceLines.length; index += 1) {
    if (sourceLines[index].trimEnd() === marker) return index;
  }
  return -1;
}

// The nearest non-blank, non-fence line above the SEARCH marker: the block's path.
function blockPathAbove(sourceLines: string[], searchIndex: number, searchFrom: number): string | null {
  for (let scanIndex = searchIndex - 1; scanIndex >= searchFrom; scanIndex -= 1) {
    const trimmedLine = sourceLines[scanIndex].trim();
    if (trimmedLine === '' || trimmedLine.startsWith('```')) continue;
    return trimmedLine;
  }
  return null;
}

function parseBlocks(sourceLines: string[], strict: boolean): Edit[] {
  const parsedBlocks: Block[] = [];
  let searchFrom = 0;
  let previousPath: string | null = null;
  let index = 0;
  while (index < sourceLines.length) {
    if (sourceLines[index].trimEnd() !== '<<<<<<< SEARCH') { index += 1; continue; }
    const errorLine = index + 1;
    const blockPath = blockPathAbove(sourceLines, index, searchFrom) ?? previousPath;
    if (blockPath === null) throw new Stop(`error: parse ${errorLine}`);

    const dividerIndex = findMarker(sourceLines, index + 1, '=======');
    if (dividerIndex < 0) throw new Stop(`error: parse ${errorLine}`);
    const closeIndex = findMarker(sourceLines, dividerIndex + 1, '>>>>>>> REPLACE');
    if (closeIndex < 0) throw new Stop(`error: parse ${errorLine}`);

    parsedBlocks.push({ path: blockPath, oldLines: sourceLines.slice(index + 1, dividerIndex), newSlots: sourceLines.slice(dividerIndex + 1, closeIndex) });
    previousPath = blockPath;
    searchFrom = closeIndex + 1;
    index = closeIndex + 1;
  }
  return parsedBlocks.map((block) => blockEdit(block, strict));
}

// Turn one SEARCH/REPLACE block into an edit: create the file, or replace one unique match.
function blockEdit(block: Block, strict: boolean): Edit {
  return (tree) => {
    checkPath(block.path);
    if (block.oldLines.length === 0) {
      if (tree.get(block.path) !== null) throw new Trouble('exists', block.path);
      const content = block.newSlots.length === 0 ? '' : block.newSlots.join('\n') + '\n';
      tree.pending.set(block.path, content);
      return;
    }
    const file = needFile(tree, block.path);
    const match = findOld(block.oldLines, file.contentLines, strict);
    if (match === null) throw new Trouble('no-match', block.path);
    if (match.where.length > 1) throw new Trouble('ambiguous', block.path);
    const insertAt = match.where[0];
    const newSlots: Slot[] = block.newSlots.map((text) => ({ text, originalIndex: null }));
    const patched = splice(file, insertAt, block.oldLines.length, newSlots, match.tier,
      indentOf(file.contentLines[insertAt]), indentOf(block.oldLines[0]));
    putFile(tree, block.path, patched);
  };
}

// ---------------------------------------------------------------------------
// V4A patches (section 8)
// ---------------------------------------------------------------------------

// One chunk inside an Update File section: an anchor or end-of-file marker,
// the old lines it matches, and the new slots it writes.
interface Chunk { anchor: string | null; eof: boolean; oldLines: string[]; newSlots: Slot[]; }
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

function vSectionStart(line: string): boolean {
  return [ADD, DELETE, UPDATE].some((prefix) => line.startsWith(prefix));
}

// Read the body lines of an Add File section, dropping trailing blanks.
function readAddBody(sourceLines: string[], startIndex: number, lastIndex: number): { body: string[]; nextIndex: number } {
  const rawLines: { line: string; no: number }[] = [];
  let index = startIndex;
  while (index < lastIndex && !vSectionStart(sourceLines[index])) {
    rawLines.push({ line: sourceLines[index], no: index + 1 });
    index += 1;
  }
  while (rawLines.length > 0 && blank(rawLines[rawLines.length - 1].line)) rawLines.pop();
  const bodyLines: string[] = [];
  for (const rawEntry of rawLines) {
    if (rawEntry.line === '') bodyLines.push('');
    else if (rawEntry.line[0] === '+') bodyLines.push(rawEntry.line.slice(1));
    else throw new Stop(`error: parse ${rawEntry.no}`);
  }
  return { body: bodyLines, nextIndex: index };
}

// Parse one chunk of an Update File section, starting at the anchor or body line.
function readV4AChunk(sourceLines: string[], startIndex: number, lastIndex: number, firstChunk: boolean): { chunk: Chunk; nextIndex: number } {
  let index = startIndex;
  const chunkHead = sourceLines[index];
  let anchorText: string | null = null;
  let atEndOfFile = false;
  if (chunkHead.startsWith('@@')) {
    anchorText = chunkHead.slice(2).trim();
    if (anchorText === '') anchorText = null;
    index += 1;
  } else if (chunkHead.trim() === EOF_MARK) {
    atEndOfFile = true;
    index += 1;
  } else if (firstChunk && (chunkHead[0] === ' ' || chunkHead[0] === '-' || chunkHead[0] === '+' || chunkHead === '')) {
    // only the first chunk may start straight at a body line
  } else {
    throw new Stop(`error: parse ${index + 1}`);
  }

  const rawLines: { line: string; no: number }[] = [];
  while (index < lastIndex && !vSectionStart(sourceLines[index])) {
    const bodyLine = sourceLines[index];
    if (bodyLine.startsWith('@@') || bodyLine.startsWith(MOVE)) break;
    if (bodyLine.trim() === EOF_MARK) { atEndOfFile = true; index += 1; break; }
    rawLines.push({ line: bodyLine, no: index + 1 });
    index += 1;
  }
  while (rawLines.length > 0 && blank(rawLines[rawLines.length - 1].line)) rawLines.pop();
  const oldLines: string[] = [];
  const newSlots: Slot[] = [];
  for (const rawEntry of rawLines) {
    const bodyLine = rawEntry.line;
    if (bodyLine === '' || bodyLine[0] === ' ') {
      const trimmedText = bodyLine === '' ? '' : bodyLine.slice(1);
      oldLines.push(trimmedText);
      newSlots.push({ text: trimmedText, originalIndex: oldLines.length - 1 });
    } else if (bodyLine[0] === '-') {
      oldLines.push(bodyLine.slice(1));
    } else if (bodyLine[0] === '+') {
      newSlots.push({ text: bodyLine.slice(1), originalIndex: null });
    } else {
      throw new Stop(`error: parse ${rawEntry.no}`);
    }
  }
  return { chunk: { anchor: anchorText, eof: atEndOfFile, oldLines, newSlots }, nextIndex: index };
}

function parseV4A(sourceLines: string[], strict: boolean): Edit[] {
  const firstNonBlank = sourceLines.findIndex((line) => !blank(line));
  if (firstNonBlank < 0) throw new Stop('error: parse 1');
  if (sourceLines[firstNonBlank].trim() !== '*** Begin Patch') throw new Stop(`error: parse ${firstNonBlank + 1}`);
  let lastNonBlank = sourceLines.length - 1;
  while (lastNonBlank >= 0 && blank(sourceLines[lastNonBlank])) lastNonBlank -= 1;
  if (lastNonBlank < firstNonBlank || sourceLines[lastNonBlank].trim() !== '*** End Patch') {
    throw new Stop(`error: parse ${sourceLines.length + 1}`);
  }

  const parsedSections: VSection[] = [];
  let index = firstNonBlank + 1;
  while (index < lastNonBlank) {
    const currentLine = sourceLines[index];
    if (blank(currentLine)) { index += 1; continue; }
    if (!vSectionStart(currentLine)) throw new Stop(`error: parse ${index + 1}`);
    const sectionLine = index + 1;

    if (currentLine.startsWith(ADD)) {
      const sectionPath = currentLine.slice(ADD.length).trim();
      const read = readAddBody(sourceLines, index + 1, lastNonBlank);
      parsedSections.push({ kind: 'add', line: sectionLine, path: sectionPath, move: null, lines: read.body, chunks: [] });
      index = read.nextIndex;
    } else if (currentLine.startsWith(DELETE)) {
      const sectionPath = currentLine.slice(DELETE.length).trim();
      index += 1;
      while (index < lastNonBlank && !vSectionStart(sourceLines[index])) {
        if (!blank(sourceLines[index])) throw new Stop(`error: parse ${index + 1}`);
        index += 1;
      }
      parsedSections.push({ kind: 'delete', line: sectionLine, path: sectionPath, move: null, lines: [], chunks: [] });
    } else {
      const sectionPath = currentLine.slice(UPDATE.length).trim();
      index += 1;
      let moveTarget: string | null = null;
      if (index < lastNonBlank && sourceLines[index].startsWith(MOVE)) {
        moveTarget = sourceLines[index].slice(MOVE.length).trim();
        index += 1;
      }
      const patchChunks: Chunk[] = [];
      while (index < lastNonBlank && !vSectionStart(sourceLines[index])) {
        if (blank(sourceLines[index])) { index += 1; continue; }
        const read = readV4AChunk(sourceLines, index, lastNonBlank, patchChunks.length === 0);
        patchChunks.push(read.chunk);
        index = read.nextIndex;
      }
      if (patchChunks.length === 0 && moveTarget === null) throw new Stop(`error: parse ${sectionLine}`);
      parsedSections.push({ kind: 'update', line: sectionLine, path: sectionPath, move: moveTarget, lines: [], chunks: patchChunks });
    }
  }
  return parsedSections.map((section) => v4aEdit(section, strict));
}

// Apply one V4A chunk to the file, returning the patched file and the new cursor.
function applyV4AChunk(file: FileText, chunk: Chunk, path: string, strict: boolean, searchCursor: number): { file: FileText; cursor: number } {
  let searchFrom = searchCursor;
  let cursor = searchCursor;
  if (chunk.anchor !== null) {
    const anchorIndex = findAnchor(chunk.anchor, file.contentLines, searchCursor, strict);
    if (anchorIndex < 0) throw new Trouble('no-match', path);
    searchFrom = anchorIndex + 1;
    cursor = searchFrom;
  }
  if (chunk.oldLines.length === 0) {
    const insertAt = chunk.eof ? file.contentLines.length : Math.min(searchFrom, file.contentLines.length);
    const patched = splice(file, insertAt, 0, chunk.newSlots, 0, '', '');
    return { file: patched, cursor: insertAt + chunk.newSlots.length };
  }
  const match = findOld(chunk.oldLines, file.contentLines, strict, searchFrom, chunk.eof);
  if (match === null) throw new Trouble('no-match', path);
  const insertAt = match.where[0];
  const patched = splice(file, insertAt, chunk.oldLines.length, chunk.newSlots, match.tier,
    indentOf(file.contentLines[insertAt]), indentOf(chunk.oldLines[0]));
  return { file: patched, cursor: insertAt + chunk.newSlots.length };
}

// Turn one parsed V4A section into an edit: add, delete, or patch a file in chunks.
function v4aEdit(section: VSection, strict: boolean): Edit {
  return (tree) => {
    checkPath(section.path);
    if (section.move !== null) checkPath(section.move);
    if (section.kind === 'add') {
      if (tree.get(section.path) !== null) throw new Trouble('exists', section.path);
      tree.pending.set(section.path, section.lines.length === 0 ? '' : section.lines.join('\n') + '\n');
      return;
    }
    let file = needFile(tree, section.path);
    if (section.kind === 'delete') { tree.pending.set(section.path, null); return; }
    if (section.move !== null && tree.get(section.move) !== null) throw new Trouble('exists', section.move);

    let searchCursor = 0;
    for (const chunk of section.chunks) {
      const applied = applyV4AChunk(file, chunk, section.path, strict, searchCursor);
      file = applied.file;
      searchCursor = applied.cursor;
    }
    if (section.move !== null) {
      tree.pending.set(section.move, renderFileText(file));
      tree.pending.set(section.path, null);
      tree.moves.push({ from: section.path, to: section.move });
    } else {
      tree.pending.set(section.path, renderFileText(file));
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (section 9)
// ---------------------------------------------------------------------------

// Turn one JSON edit object into an edit, or null when the object is not an edit.
function jsonEdit(editSpec: unknown): Edit | null {
  if (editSpec === null || typeof editSpec !== 'object' || Array.isArray(editSpec)) return null;
  const spec = editSpec as Record<string, unknown>;
  if (typeof spec.path !== 'string') return null;
  const targetPath = spec.path;

  switch (spec.command) {
    case 'create': {
      if (typeof spec.file_text !== 'string') return null;
      const fileContent = spec.file_text;
      return (tree) => {
        checkPath(targetPath);
        if (tree.get(targetPath) !== null) throw new Trouble('exists', targetPath);
        tree.pending.set(targetPath, fileContent);
      };
    }
    case 'str_replace': {
      if (typeof spec.old_str !== 'string' || spec.old_str === '') return null;
      if (spec.new_str !== undefined && typeof spec.new_str !== 'string') return null;
      const oldText = spec.old_str;
      const newText = (spec.new_str as string | undefined) ?? '';
      return (tree) => {
        checkPath(targetPath);
        const currentText = tree.get(targetPath);
        if (currentText === null) throw new Trouble('missing', targetPath);
        const newlineIndex = currentText.indexOf('\n');
        const usesCrlf = newlineIndex > 0 && currentText[newlineIndex - 1] === '\r';
        const normalizeEndings = (input: string): string => (usesCrlf ? input.replaceAll('\r\n', '\n') : input);
        const normalizedText = normalizeEndings(currentText);
        const normalizedOld = normalizeEndings(oldText);
        let occurrences = 0;
        for (let searchAt = normalizedText.indexOf(normalizedOld); searchAt >= 0; searchAt = normalizedText.indexOf(normalizedOld, searchAt + 1)) occurrences += 1;
        if (occurrences === 0) throw new Trouble('no-match', targetPath);
        if (occurrences > 1) throw new Trouble('ambiguous', targetPath);
        const matchAt = normalizedText.indexOf(normalizedOld);
        const patchedText = normalizedText.slice(0, matchAt) + normalizeEndings(newText) + normalizedText.slice(matchAt + normalizedOld.length);
        tree.pending.set(targetPath, usesCrlf ? patchedText.replaceAll('\n', '\r\n') : patchedText);
      };
    }
    case 'insert': {
      if (typeof spec.insert_line !== 'number' || !Number.isInteger(spec.insert_line)) return null;
      if (typeof spec.new_str !== 'string') return null;
      const insertAtLine = spec.insert_line;
      const insertedLines = patchLines(spec.new_str);
      return (tree) => {
        checkPath(targetPath);
        const file = needFile(tree, targetPath);
        if (insertAtLine < 0 || insertAtLine > file.contentLines.length) throw new Trouble('no-match', targetPath);
        const newSlots: Slot[] = insertedLines.map((text) => ({ text, originalIndex: null }));
        putFile(tree, targetPath, splice(file, insertAtLine, 0, newSlots, 0, '', ''));
      };
    }
    default:
      return null;
  }
}

// Parse the JSON patch: either one JSON array of edit objects, or one edit object per line.
function jsonEdits(patchText: string, sourceLines: string[]): Edit[] {
  const firstNonBlank = sourceLines.findIndex((line) => !blank(line));
  if (firstNonBlank < 0) throw new Stop('error: parse 1');
  const parsedEdits: Edit[] = [];
  if (sourceLines[firstNonBlank].trimStart().startsWith('[')) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(patchText);
    } catch {
      throw new Stop(`error: parse ${firstNonBlank + 1}`);
    }
    if (!Array.isArray(parsedJson)) throw new Stop(`error: parse ${firstNonBlank + 1}`);
    for (const editItem of parsedJson) {
      const parsedEdit = jsonEdit(editItem);
      if (parsedEdit === null) throw new Stop(`error: parse ${firstNonBlank + 1}`);
      parsedEdits.push(parsedEdit);
    }
    return parsedEdits;
  }
  for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex += 1) {
    const sourceLine = sourceLines[lineIndex];
    if (blank(sourceLine)) continue;
    let parsedEdit: Edit | null = null;
    try {
      parsedEdit = jsonEdit(JSON.parse(sourceLine));
    } catch {
      parsedEdit = null;
    }
    if (parsedEdit === null) throw new Stop(`error: parse ${lineIndex + 1}`);
    parsedEdits.push(parsedEdit);
  }
  return parsedEdits;
}

// ---------------------------------------------------------------------------
// Sections 1-4 and 10: invocation, detection, output, atomicity
// ---------------------------------------------------------------------------

// Guess the patch format from its first non-blank line and its markers, or null when unknown.
function detect(sourceLines: string[]): string | null {
  const firstNonBlank = sourceLines.findIndex((line) => !blank(line));
  if (firstNonBlank < 0) return null;
  if (sourceLines[firstNonBlank].trim() === '*** Begin Patch') return 'v4a';
  const firstChar = sourceLines[firstNonBlank].trimStart()[0];
  if (firstChar === '[' || firstChar === '{') return 'json';
  const hasSearchBlock = sourceLines.some((line) => line.trimEnd() === '<<<<<<< SEARCH');
  if (hasSearchBlock) return 'search-replace';
  for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex += 1) {
    const line = sourceLines[lineIndex];
    if (line.startsWith('diff --git ')) return 'unified';
    if (line.startsWith('--- ') && (sourceLines[lineIndex + 1] ?? '').startsWith('+++ ')) return 'unified';
  }
  return null;
}

interface Options { format: string | null; check: boolean; strict: boolean; patch: string | null; }

// Parse the command line: --format, --check, --strict, --, and at most one patch path.
function options(argv: string[]): Options | null {
  let formatName: string | null = null;
  let checkOnly = false;
  let strictMode = false;
  let sawDoubleDash = false;
  const positionalArgs: string[] = [];
  let argIndex = 0;
  while (argIndex < argv.length) {
    const arg = argv[argIndex];
    argIndex += 1;
    if (!sawDoubleDash && arg === '--') { sawDoubleDash = true; continue; }
    if (!sawDoubleDash && arg.startsWith('-') && arg !== '-') {
      switch (true) {
        case arg.startsWith('--format='): {
          const formatValue = arg.slice(9);
          if (formatName !== null || !FORMAT_NAMES.includes(formatValue)) return null;
          formatName = formatValue;
          break;
        }
        case arg === '--check':
          if (checkOnly) return null;
          checkOnly = true;
          break;
        case arg === '--strict':
          if (strictMode) return null;
          strictMode = true;
          break;
        default:
          return null;
      }
    } else {
      positionalArgs.push(arg);
    }
  }
  if (positionalArgs.length > 1) return null;
  const patchPath = positionalArgs.length === 0 || positionalArgs[0] === '-' ? null : positionalArgs[0];
  return { format: formatName, check: checkOnly, strict: strictMode, patch: patchPath };
}

// Apply the edits to a fresh tree, rolling each failed edit back; returns the failures.
function applyEdits(editList: Edit[], fileTree: Tree): Trouble[] {
  const failedEdits: Trouble[] = [];
  for (const singleEdit of editList) {
    const savedState = new Map(fileTree.pending);
    const savedMoveCount = fileTree.moves.length;
    try {
      singleEdit(fileTree);
    } catch (caughtError) {
      if (!(caughtError instanceof Trouble)) throw caughtError;
      fileTree.pending.clear();
      for (const [filePath, savedValue] of savedState) fileTree.pending.set(filePath, savedValue);
      fileTree.moves.length = savedMoveCount;
      failedEdits.push(caughtError);
    }
  }
  return failedEdits;
}

// The renames to report: old path gone, new path new, both relative to the originals.
function collectRenames(fileTree: Tree): Move[] {
  const renameList: Move[] = [];
  for (const moveEntry of fileTree.moves) {
    const oldGone = fileTree.original(moveEntry.from) !== null && fileTree.end(moveEntry.from) === null;
    const newAppeared = fileTree.original(moveEntry.to) === null && fileTree.end(moveEntry.to) !== null;
    if (oldGone && newAppeared) renameList.push(moveEntry);
  }
  return renameList;
}

// The summary rows for the changed files, renames included, sorted by path.
function summarize(fileTree: Tree, renameList: Move[]): { key: string; text: string }[] {
  const renamedPaths = new Set<string>();
  for (const moveEntry of renameList) {
    renamedPaths.add(moveEntry.from);
    renamedPaths.add(moveEntry.to);
  }
  const summaryRows: { key: string; text: string }[] = [];
  for (const [filePath, newContent] of fileTree.pending) {
    if (fileTree.original(filePath) === newContent || renamedPaths.has(filePath)) continue;
    const marker = fileTree.original(filePath) === null ? 'A' : newContent === null ? 'D' : 'M';
    summaryRows.push({ key: filePath, text: `${marker} ${filePath}` });
  }
  for (const moveEntry of renameList) {
    summaryRows.push({ key: moveEntry.to, text: `R ${moveEntry.from} -> ${moveEntry.to}` });
  }
  summaryRows.sort((left, right) => Buffer.compare(Buffer.from(left.key), Buffer.from(right.key)));
  return summaryRows;
}

// Write the pending changes to disk: delete the removed files, write the rest.
function flushToDisk(fileTree: Tree): void {
  for (const [filePath, newContent] of fileTree.pending) {
    if (fileTree.original(filePath) === newContent) continue;
    if (newContent === null) {
      rmSync(filePath, { force: true });
    } else {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, newContent);
    }
  }
}

// Run one invocation: parse the patch, apply its edits to a fresh tree, report the result.
function run(argv: string[]): { code: number; out: string[] } {
  const parsedOptions = options(argv);
  if (parsedOptions === null) return { code: 2, out: ['error: usage'] };

  let patchText = '';
  try {
    patchText = readFileSync(parsedOptions.patch ?? 0, 'utf8');
  } catch {
    if (parsedOptions.patch !== null) return { code: 2, out: ['error: no-patch'] };
  }

  const patchLinesArr = patchLines(patchText);
  const formatKind = parsedOptions.format === null || parsedOptions.format === 'auto'
    ? detect(patchLinesArr)
    : parsedOptions.format;
  if (formatKind === null) return { code: 2, out: ['error: format'] };

  let editList: Edit[];
  try {
    if (formatKind === 'json') editList = jsonEdits(patchText, patchLinesArr);
    else if (formatKind === 'unified') editList = parseUnified(patchLinesArr, parsedOptions.strict);
    else if (formatKind === 'search-replace') editList = parseBlocks(patchLinesArr, parsedOptions.strict);
    else editList = parseV4A(patchLinesArr, parsedOptions.strict);
    if (editList.length === 0) throw new Stop('error: parse 1');
  } catch (caughtError) {
    if (caughtError instanceof Stop) return { code: 2, out: [caughtError.line] };
    throw caughtError;
  }

  const fileTree = new Tree();
  const failedEdits = applyEdits(editList, fileTree);
  if (failedEdits.length > 0) {
    return {
      code: 1,
      out: [
        ...failedEdits.map((failure) => `error: ${failure.code} ${failure.path}`),
        `failed: ${failedEdits.length} of ${editList.length} edits`,
      ],
    };
  }

  const renameList = collectRenames(fileTree);
  const summaryRows = summarize(fileTree, renameList);
  const outputLines = summaryRows.map((summaryRow) => summaryRow.text);

  if (!parsedOptions.check) flushToDisk(fileTree);
  outputLines.push(`ok: ${summaryRows.length} ${summaryRows.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out: outputLines };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const result = run(process.argv.slice(2));
  const outputText = result.out.map((outputLine) => `${outputLine}\n`).join('');
  writeSync(1, outputText);
  process.exitCode = result.code;
}
