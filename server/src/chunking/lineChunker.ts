// Line chunker (ARCHITECTURE §7.2): cuts a file into overlapping windows of lines.
// Each window is about 60 lines, the next one starts 10 lines before the previous
// one ended (so code at a boundary appears in both), and no chunk is bigger than
// MAX_CHUNK_TOKENS. It works for every language, config file and doc.
// The syntax chunker also uses lineRanges() and makeChunk() from this file.
import { CHARS_PER_TOKEN, LINE_CHUNK_OVERLAP, LINE_CHUNK_SIZE, MAX_CHUNK_TOKENS } from "../config.js";
import type { Chunk, SourceFile, SymbolType } from "../types.js";

/** Largest chunk in characters (4 characters ≈ 1 token). */
export const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * CHARS_PER_TOKEN;

/** Room kept for the "File: … | Lines …" header at the top of each chunk. */
const HEADER_ROOM = 200;

/**
 * Splits lines[from..to] (0-based, inclusive) into windows of up to 60 lines with
 * 10 lines of overlap. A window also stops early if adding a line would make it
 * longer than maxChars. Returns [start, end] index pairs.
 */
export function lineRanges(
  lines: string[],
  from = 0,
  to = lines.length - 1,
  maxChars = MAX_CHUNK_CHARS - HEADER_ROOM,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = from;
  while (start <= to) {
    // Grow the window one line at a time until it hits the line limit or the size limit.
    let end = start;
    let chars = lines[start].length + 1;
    while (end + 1 <= to && end + 1 - start < LINE_CHUNK_SIZE && chars + lines[end + 1].length + 1 <= maxChars) {
      end++;
      chars += lines[end].length + 1;
    }
    ranges.push([start, end]);
    if (end >= to) break;
    // Step back by the overlap for the next window, but always move forward at least one line.
    start = Math.max(end + 1 - LINE_CHUNK_OVERLAP, start + 1);
  }
  return ranges;
}

/** The details needed to build one chunk. Line numbers are 1-based, like in an editor. */
interface ChunkInput {
  file: SourceFile;
  index: number; // position of this chunk in the file, used to make the ID unique
  startLine: number;
  endLine: number;
  code: string;
  symbol?: string;
  symbolType?: SymbolType;
  chunker?: "syntax" | "lines";
}

/**
 * Builds a Chunk. Its text starts with a header such as
 * "File: src/auth.ts | Symbol: login (function) | Lines 40-72"
 * so the file name and symbol name are part of what gets embedded and searched.
 */
export function makeChunk(c: ChunkInput): Chunk {
  const symbolPart = c.symbol ? ` | Symbol: ${c.symbol} (${c.symbolType})` : "";
  const header = `File: ${c.file.path}${symbolPart} | Lines ${c.startLine}-${c.endLine}`;
  // A single huge line (e.g. generated data) could still be too big, so cut it as a last resort.
  const code = c.code.length > MAX_CHUNK_CHARS - HEADER_ROOM ? c.code.slice(0, MAX_CHUNK_CHARS - HEADER_ROOM) : c.code;
  return {
    id: `${c.file.path}#${c.index}`,
    text: `${header}\n${code}`,
    path: c.file.path,
    startLine: c.startLine,
    endLine: c.endLine,
    language: c.file.language,
    symbol: c.symbol ?? "",
    symbolType: c.symbolType ?? "lines",
    chunker: c.chunker ?? "lines",
  };
}

/** Cuts a whole file into line chunks. Empty files give no chunks. */
export function lineChunker(file: SourceFile): Chunk[] {
  if (file.text.trim() === "") return [];
  const lines = file.text.split("\n");
  return lineRanges(lines).map(([start, end], index) =>
    makeChunk({
      file,
      index,
      startLine: start + 1,
      endLine: end + 1,
      code: lines.slice(start, end + 1).join("\n"),
    }),
  );
}
