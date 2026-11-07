// Syntax chunker (ARCHITECTURE §7.1): splits code along its real structure using tree-sitter.
// tree-sitter parses the file into a tree (functions, classes, methods…). Then:
//  - each top-level function becomes one chunk (with its decorators and doc comments)
//  - a class becomes one chunk if it fits; otherwise one chunk per method, each starting
//    with the class header line so the model knows which class it belongs to
//  - leftover top-level code (imports, constants…) is grouped into "module" chunks by lines
//  - anything too big is split by lines; each part repeats the first line and is labelled "part i/n"
// If the language isn't supported, or the file has syntax errors, it returns null and the
// caller uses the line chunker instead.
import path from "node:path";
import { Language, Parser, type Node } from "web-tree-sitter";
import { ROOT_DIR } from "../config.js";
import type { Chunk, SourceFile, SymbolType } from "../types.js";
import { LANGUAGES, WRAPPERS, type LanguageSpec } from "./languages.js";
import { MAX_CHUNK_CHARS, lineRanges, makeChunk } from "./lineChunker.js";

const GRAMMAR_DIR = path.join(ROOT_DIR, "server", "grammars");

/** Room kept for the chunk header ("File: … | Symbol: … | Lines …"). */
const HEADER_ROOM = 200;

/** One parser per language, created the first time that language is needed. */
const parsers = new Map<string, Promise<Parser>>();
let initPromise: Promise<void> | null = null;

/** Loads tree-sitter and the grammar for a language (only once), and returns a parser for it. */
function getParser(language: string, spec: LanguageSpec): Promise<Parser> {
  let parser = parsers.get(language);
  if (!parser) {
    parser = (async () => {
      initPromise ??= Parser.init();
      await initPromise;
      const p = new Parser();
      p.setLanguage(await Language.load(path.join(GRAMMAR_DIR, spec.wasm)));
      return p;
    })();
    parsers.set(language, parser);
  }
  return parser;
}

/** A piece of the file that will become chunk(s): lines start..end (0-based, inclusive). */
interface Unit {
  start: number;
  end: number;
  symbol: string;
  symbolType: SymbolType;
  /** For methods of a split class: the class header line, put above the method's code. */
  contextLine?: string;
}

/** If the node is a wrapper (decorator, export), returns the definition inside it. */
function unwrap(node: Node): Node {
  const field = WRAPPERS[node.type];
  return (field && node.childForFieldName(field)) || node;
}

/** The node's name, e.g. the function name. Go types keep the name one level down. */
function nameOf(node: Node): string {
  const name = node.childForFieldName("name") ?? node.namedChildren.find((c) => c?.type === "type_spec")?.childForFieldName("name");
  return name?.text ?? "(anonymous)";
}

/**
 * For `const login = () => {…}` returns "login", or null if the node isn't a variable
 * holding an arrow function or function expression.
 */
function arrowFunctionName(node: Node): string | null {
  if (node.type !== "lexical_declaration" && node.type !== "variable_declaration") return null;
  const declarator = node.namedChildren.find((c) => c?.type === "variable_declarator");
  const value = declarator?.childForFieldName("value");
  if (value && (value.type === "arrow_function" || value.type === "function_expression")) {
    return declarator!.childForFieldName("name")?.text ?? null;
  }
  return null;
}

/** First line of a node, moved up to include comments sitting directly above it (doc comments). */
function startWithComments(node: Node): number {
  let start = node.startPosition.row;
  let prev = node.previousNamedSibling;
  while (prev && prev.type.includes("comment") && prev.endPosition.row >= start - 1) {
    start = prev.startPosition.row;
    prev = prev.previousNamedSibling;
  }
  return start;
}

/** Number of characters in lines[start..end]. */
function charCount(lines: string[], start: number, end: number): number {
  let n = 0;
  for (let i = start; i <= end; i++) n += lines[i].length + 1;
  return n;
}

/**
 * Finds the units at the top of the file. A class that is too big for one chunk is
 * replaced by its methods, plus "class" chunks for any class lines not inside a method.
 */
function findUnits(root: Node, lines: string[], spec: LanguageSpec): Unit[] {
  const units: Unit[] = [];
  for (const outer of root.namedChildren) {
    if (!outer) continue;
    const node = unwrap(outer);
    const arrowName = spec.arrowFunctions ? arrowFunctionName(node) : null;
    const symbolType = spec.units[node.type] ?? (arrowName ? "function" : undefined);
    if (!symbolType) continue;

    const unit: Unit = {
      start: startWithComments(outer),
      end: outer.endPosition.row,
      symbol: arrowName ?? nameOf(node),
      symbolType,
    };

    const fits = charCount(lines, unit.start, unit.end) <= MAX_CHUNK_CHARS - HEADER_ROOM;
    if (symbolType === "class" && !fits && spec.methods.length > 0) {
      units.push(...splitClass(node, unit, lines, spec));
    } else {
      units.push(unit);
    }
  }
  return units;
}

/** Turns a big class into one unit per method. Class lines outside methods become "class" units. */
function splitClass(classNode: Node, classUnit: Unit, lines: string[], spec: LanguageSpec): Unit[] {
  const className = classUnit.symbol;
  const headerLine = lines[classNode.startPosition.row].trim();
  const body = classNode.childForFieldName("body");

  const methods: Unit[] = [];
  for (const outer of body?.namedChildren ?? []) {
    if (!outer) continue;
    const node = unwrap(outer);
    if (!spec.methods.includes(node.type)) continue;
    methods.push({
      start: startWithComments(outer),
      end: outer.endPosition.row,
      symbol: `${className}.${nameOf(node)}`,
      symbolType: "method",
      contextLine: headerLine,
    });
  }
  if (methods.length === 0) return [classUnit]; // nothing to split on; it will be split by lines

  // Whatever is left (class header, fields, closing brace) is kept as "class" units.
  const rest = gaps(methods, classUnit.start, classUnit.end, lines).map((g) => ({
    ...g,
    symbol: className,
    symbolType: "class" as const,
  }));
  return [...methods, ...rest];
}

/** The line ranges between `from` and `to` not covered by any unit, skipping blank-only ranges. */
function gaps(units: Unit[], from: number, to: number, lines: string[]): Array<{ start: number; end: number }> {
  const result: Array<{ start: number; end: number }> = [];
  let cursor = from;
  const sorted = [...units].sort((a, b) => a.start - b.start);
  for (const u of [...sorted, { start: to + 1, end: to }]) {
    if (u.start > cursor) {
      const start = cursor;
      const end = u.start - 1;
      if (lines.slice(start, end + 1).some((l) => l.trim() !== "")) result.push({ start, end });
    }
    cursor = Math.max(cursor, u.end + 1);
  }
  return result;
}

/**
 * Turns one unit into chunks. Small units give one chunk. Big ones are split by lines
 * with overlap; each part after the first repeats the unit's first line and is labelled "part i/n".
 */
function unitToChunks(file: SourceFile, lines: string[], unit: Unit, nextIndex: () => number): Chunk[] {
  const prefix = unit.contextLine ? `${unit.contextLine}\n` : "";
  const fits = prefix.length + charCount(lines, unit.start, unit.end) <= MAX_CHUNK_CHARS - HEADER_ROOM;
  const base = { file, symbolType: unit.symbolType, chunker: "syntax" as const };

  if (fits) {
    const code = prefix + lines.slice(unit.start, unit.end + 1).join("\n");
    return [makeChunk({ ...base, index: nextIndex(), startLine: unit.start + 1, endLine: unit.end + 1, code, symbol: unit.symbol })];
  }

  const signature = lines[unit.start];
  const room = MAX_CHUNK_CHARS - HEADER_ROOM - prefix.length - signature.length - 1;
  const parts = lineRanges(lines, unit.start, unit.end, room);
  return parts.map(([start, end], i) => {
    const repeat = start > unit.start ? `${signature}\n` : "";
    const code = prefix + repeat + lines.slice(start, end + 1).join("\n");
    const symbol = unit.symbol ? `${unit.symbol} part ${i + 1}/${parts.length}` : "";
    return makeChunk({ ...base, index: nextIndex(), startLine: start + 1, endLine: end + 1, code, symbol });
  });
}

/**
 * Splits a file by its syntax. Returns null if the language isn't supported or the
 * file has syntax errors, so the caller can fall back to the line chunker.
 */
export async function syntaxChunker(file: SourceFile): Promise<Chunk[] | null> {
  const spec = LANGUAGES[file.language];
  if (!spec) return null;

  const parser = await getParser(file.language, spec);
  const tree = parser.parse(file.text);
  if (!tree) return null;
  try {
    if (tree.rootNode.hasError) return null;

    const lines = file.text.split("\n");
    const units = findUnits(tree.rootNode, lines, spec);
    // Top-level code outside every unit (imports, constants…) becomes "module" units.
    const moduleUnits: Unit[] = gaps(units, 0, lines.length - 1, lines).map((g) => ({ ...g, symbol: "", symbolType: "module" }));

    let index = 0;
    const nextIndex = () => index++;
    return [...units, ...moduleUnits]
      .sort((a, b) => a.start - b.start)
      .flatMap((unit) => unitToChunks(file, lines, unit, nextIndex));
  } finally {
    tree.delete(); // free the tree's memory inside the WASM module
  }
}
