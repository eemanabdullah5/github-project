// Chunking entry point: chunkFile() picks how to split a file into chunks.
import type { Chunk, SourceFile } from "../types.js";
import { lineChunker } from "./lineChunker.js";

/** Splits one file into chunks. For now every file uses the line chunker. */
export function chunkFile(file: SourceFile): Chunk[] {
  return lineChunker(file);
}
