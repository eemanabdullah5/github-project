// Per-language settings for the syntax chunker (ARCHITECTURE §7.1).
// For each supported language: which grammar file to load, and which kinds of
// syntax-tree nodes count as a "unit" (a function, class or method) that becomes its own chunk.
// To support a new language: add its .wasm file to server/grammars/ and an entry here.
import type { SymbolType } from "../types.js";

export interface LanguageSpec {
  /** Grammar file name in server/grammars/. */
  wasm: string;
  /** Top-level node types that become units, and what kind of symbol each one is. */
  units: Record<string, Exclude<SymbolType, "module" | "lines">>;
  /** Node types inside a class body that are methods (used when a class is too big for one chunk). */
  methods: string[];
  /** Also treat `const name = () => …` (an arrow function stored in a variable) as a function. JS/TS only. */
  arrowFunctions: boolean;
}

const jsLike = (wasm: string): LanguageSpec => ({
  wasm,
  units: { function_declaration: "function", class_declaration: "class" },
  methods: ["method_definition"],
  arrowFunctions: true,
});

/** Language name (from ingestion.detectLanguage) → settings. */
export const LANGUAGES: Record<string, LanguageSpec> = {
  python: {
    wasm: "tree-sitter-python.wasm",
    units: { function_definition: "function", class_definition: "class" },
    methods: ["function_definition"],
    arrowFunctions: false,
  },
  javascript: jsLike("tree-sitter-javascript.wasm"),
  typescript: jsLike("tree-sitter-typescript.wasm"),
  tsx: jsLike("tree-sitter-tsx.wasm"),
  java: {
    wasm: "tree-sitter-java.wasm",
    units: { class_declaration: "class", interface_declaration: "class" },
    methods: ["method_declaration"],
    arrowFunctions: false,
  },
  go: {
    wasm: "tree-sitter-go.wasm",
    units: { function_declaration: "function", method_declaration: "method", type_declaration: "class" },
    methods: [],
    arrowFunctions: false,
  },
};

/**
 * Wrapper nodes whose real definition is inside them:
 *  - Python `decorated_definition` (@decorator + def/class) → its "definition" child
 *  - JS/TS `export_statement` (export function …) → its "declaration" child
 * The chunk still covers the wrapper, so decorators and `export` are included.
 */
export const WRAPPERS: Record<string, string> = {
  decorated_definition: "definition",
  export_statement: "declaration",
};
