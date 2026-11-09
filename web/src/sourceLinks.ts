// F1 — Clickable sources, and Phase 2 — Verified citations.
// This file makes links to code on GitHub and checks the AI's citations.
// When the AI cites a file like [src/app.py:L10-L16], we check it against the code the AI was really given:
//  - verified: the file was retrieved AND every cited line is inside a retrieved chunk → a GitHub link
//  - unverified: anything else (made-up file, lines the AI never saw, impossible line numbers) → a ⚠ warning
import { rewriteCitations } from "./citations";
import type { Source } from "./api";

// Which repo and which version of the code the links should open.
export interface LinkTarget {
  owner: string; // e.g. "eemanabdullah5"
  name: string; // e.g. "ai_agent_oop"
  ref: string; // the commit we indexed. Using it means the line numbers still match after new commits.
}

// Unverified citations are written as Markdown links to this address, so the chat and report
// can draw them as a warning badge instead of a link (see components/CitationLink.tsx).
export const UNVERIFIED_HREF = "#unverified-citation";
export const UNVERIFIED_TITLE = "Not verified: the AI wasn't shown these lines, so this citation may be wrong.";

// Generates the GitHub URL for some lines of a file.
// Example: https://github.com/octo/hello/blob/abc123/src/app.py#L10-L16
// GitHub opens the file and highlights those lines.
export function githubLineUrl(target: LinkTarget, path: string, startLine: number, endLine: number): string {
  // Make the file path safe for a web address (for example, a space becomes %20).
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  // "#L10-L16" for several lines, or "#L7" for one line.
  const lines = endLine > startLine ? `#L${startLine}-L${endLine}` : `#L${startLine}`;
  return `https://github.com/${target.owner}/${target.name}/blob/${target.ref}/${encodedPath}${lines}`;
}

// Makes the link for one file in the "Sources" list under an answer.
export function sourceUrl(target: LinkTarget, source: Source): string {
  return githubLineUrl(target, source.path, source.startLine, source.endLine);
}

// The checking itself (isCitationVerified, checkCitations, …) lives in citations.ts.
export { checkCitations, isCitationVerified, type CitationCheck } from "./citations";

/**
 * Turns every citation in the answer text into Markdown the page can show.
 *  - verified → a GitHub link to those lines
 *  - unverified → a link to UNVERIFIED_HREF, which the page draws as a ⚠ badge (never a broken link)
 * With `forExport`, unverified citations become plain text with a written warning instead,
 * because a downloaded .md file can't show the badge.
 */
export function linkCitations(markdown: string, target: LinkTarget, sources: Source[], options: { forExport?: boolean } = {}): string {
  return rewriteCitations(markdown, sources, (c) => {
    if (c.verified) return `[${c.label}](${githubLineUrl(target, c.path, c.start, c.end)})`;
    if (options.forExport) return `${c.label} (⚠ unverified)`;
    return `[${c.label}](${UNVERIFIED_HREF} "${UNVERIFIED_TITLE}")`;
  });
}
