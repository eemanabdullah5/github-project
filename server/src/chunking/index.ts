// Chunking entry point: chunkFile() picks how to split a file into chunks.
//  - Python, JavaScript, TypeScript/TSX, Java and Go → syntax chunker (by function/class)
//  - everything else, or a file that fails to parse → line chunker
// Each chunk records which chunker made it ("syntax" or "lines").
import type { Chunk, SourceFile } from "../types.js";
import { lineChunker } from "./lineChunker.js";
import { syntaxChunker } from "./syntaxChunker.js";

/** Splits one file into chunks, using the syntax chunker when it can and the line chunker otherwise. */
export async function chunkFile(file: SourceFile): Promise<Chunk[]> {
  if (file.text.trim() === "") return [];
  try {
    const chunks = await syntaxChunker(file);
    if (chunks) return chunks;
  } catch (err) {
    console.error(`Syntax chunking failed for ${file.path}, using line chunks:`, err instanceof Error ? err.message : err);
  }
  return lineChunker(file);
}
