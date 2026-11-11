// Incremental re-index: reuse the vectors of chunks that didn't change, and embed only the new or changed ones.
// Why: embedding is most of the indexing time and all of its Gemini calls. After a few commits, most chunks
// are exactly the same as last time, so embedding them again is wasted work.
//
// How chunks are matched: by a fingerprint (SHA-1) of their text. Why the text and not the chunk id:
// ids are positions ("app.ts#3"), which shift when code is added above. The vector depends only on the
// text, so the same text always gets the same vector.
// Never mixes models: vectors are only reused if the index was made with the same embedding model.
import { createHash } from "node:crypto";
import type { Chunk } from "./types.js";

/** A short fingerprint of a chunk's text. Same text → same fingerprint. */
export function fingerprint(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/** The plan for one re-index: which chunks need embedding, and how to put all the vectors together. */
export interface EmbeddingPlan {
  toEmbed: Chunk[]; // new or changed chunks: these go to the AI
  reused: number; // how many chunks got a saved vector instead
  /** Puts the saved and the freshly embedded vectors together, in the same order as the chunks. */
  combine: (fresh: number[][]) => number[][];
}

/**
 * Decides, for each chunk, whether a saved vector can be used. `saved` maps fingerprint → vector,
 * from the previous index (empty for a first index, or if the embedding model changed).
 */
export function planEmbedding(chunks: Chunk[], saved: Map<string, number[]>): EmbeddingPlan {
  const reuse: Array<number[] | null> = chunks.map((c) => saved.get(fingerprint(c.text)) ?? null);
  const toEmbed = chunks.filter((_, i) => reuse[i] === null);
  return {
    toEmbed,
    reused: chunks.length - toEmbed.length,
    combine(fresh) {
      if (fresh.length !== toEmbed.length) throw new Error(`Expected ${toEmbed.length} new vectors, got ${fresh.length}.`);
      let next = 0;
      return reuse.map((vector) => vector ?? fresh[next++]);
    },
  };
}
