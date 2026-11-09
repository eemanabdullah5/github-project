// Verified citations: the checking logic behind the ⚠ badges and warnings (used by sourceLinks.ts).
//
// A citation like [src/app.py:L10-L16] is verified only if that file was retrieved for the answer
// AND every cited line is inside a retrieved chunk. Anything else is unverified.

/** The parts of a retrieved source this check needs. */
export interface CitedRange {
  path: string;
  startLine: number;
  endLine: number;
}

/** One citation found in a text, and whether it passed the check. */
export interface Citation {
  path: string;
  start: number;
  end: number;
  label: string; // always written the same way, e.g. "app.py:L10-L16"
  verified: boolean;
}

/** How many citations in a text passed and failed the check. */
export interface CitationCheck {
  verified: number;
  unverified: number;
}

// Finds a citation group: square brackets holding one or more "file:lines".
// Matches:  [app.py:L10-L16]   [app.py:10-16]   [a.py:L1-L4, b.py:L7]
// Skips text that is already a link, like [docs](https://...).
const CITATION_GROUP = /\[([^\[\]\n]+?:L?\d+(?:-L?\d+)?(?:\s*,\s*[^\[\]\n]+?:L?\d+(?:-L?\d+)?)*)\](?!\()/g;

// Splits one citation into its parts: file path, start line, and end line (if there is one).
const ONE_CITATION = /^\s*(.+?):L?(\d+)(?:-L?(\d+))?\s*$/;

/**
 * Checks one citation against the code the AI was given.
 * True only if the file was retrieved and every line from start to end is inside a retrieved chunk of it.
 * Chunks of the same file can sit next to each other or overlap, so together they can cover a longer range.
 */
export function isCitationVerified(sources: CitedRange[], path: string, start: number, end: number): boolean {
  if (start < 1 || end < start) return false; // impossible line numbers, e.g. L0 or L20-L10
  // The retrieved line ranges of this file, earliest first.
  const ranges = sources.filter((s) => s.path === path).sort((a, b) => a.startLine - b.startLine);
  let next = start; // the first cited line not yet shown to be covered
  for (const r of ranges) {
    if (r.startLine > next) break; // a gap: line `next` was never retrieved
    if (r.endLine >= next) next = r.endLine + 1;
    if (next > end) return true; // every cited line is covered
  }
  return false;
}

/**
 * Goes through every citation in the text. `render` decides what each one becomes;
 * a group of citations is put back together with ", ".
 */
export function rewriteCitations(markdown: string, sources: CitedRange[], render: (c: Citation) => string): string {
  return markdown.replace(CITATION_GROUP, (whole, inner: string) => {
    const parts = inner.split(",").map((part) => part.match(ONE_CITATION));
    // If any part isn't a citation (e.g. "[see a.py:L1, or the docs]"), it's normal text: leave it alone.
    if (parts.some((m) => !m)) return whole;
    return parts
      .map((m) => {
        const [, path, startText, endText] = m!;
        const start = Number(startText);
        const end = Number(endText ?? startText);
        const label = `${path}:L${start}${endText ? `-L${end}` : ""}`;
        return render({ path, start, end, label, verified: isCitationVerified(sources, path, start, end) });
      })
      .join(", ");
  });
}

/** Lists every citation in a text with its check result. */
export function findCitations(markdown: string, sources: CitedRange[]): Citation[] {
  const found: Citation[] = [];
  rewriteCitations(markdown, sources, (c) => {
    found.push(c);
    return "";
  });
  return found;
}

/** Counts verified and unverified citations in a text. */
export function checkCitations(markdown: string, sources: CitedRange[]): CitationCheck {
  const found = findCitations(markdown, sources);
  const verified = found.filter((c) => c.verified).length;
  return { verified, unverified: found.length - verified };
}
