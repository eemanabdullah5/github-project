// F1 — Clickable sources.
// This file makes links to code on GitHub.
// When the AI cites a file like [src/app.py:L10-L16], we turn it into a link.
// Clicking the link opens that file on GitHub with lines 10 to 16 highlighted.
import type { Source } from "./api";

// Which repo and which version of the code the links should open.
export interface LinkTarget {
  owner: string; // e.g. "eemanabdullah5"
  name: string; // e.g. "ai_agent_oop"
  ref: string; // the commit we indexed. Using it means the line numbers still match after new commits.
}

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

// Finds a citation group in the answer text: square brackets holding one or more "file:lines".
// Matches:  [app.py:L10-L16]   [app.py:10-16]   [a.py:L1-L4, b.py:L7]
// Skips text that is already a link, like [docs](https://...).
const CITATION_GROUP = /\[([^\[\]\n]+?:L?\d+(?:-L?\d+)?(?:\s*,\s*[^\[\]\n]+?:L?\d+(?:-L?\d+)?)*)\](?!\()/g;

// Splits one citation into its parts: file path, start line, and end line (if there is one).
const ONE_CITATION = /^\s*(.+?):L?(\d+)(?:-L?(\d+))?\s*$/;

// Turns every citation in the answer text into a clickable link.
// It only links files that are in the answer's Sources list (the code the AI was really given).
// If the AI cites a file that isn't there, the citation stays as plain text, so we never show a broken link.
export function linkCitations(markdown: string, target: LinkTarget, sources: Source[]): string {
  // The files the AI was really given for this answer.
  const knownPaths = new Set(sources.map((s) => s.path));

  // Look at each citation group in the text, one at a time.
  return markdown.replace(CITATION_GROUP, (whole, inner: string) => {
    // A group can hold several citations separated by commas. Handle each one.
    const parts = inner.split(",").map((part) => {
      const match = part.match(ONE_CITATION);
      // Not a valid citation, or a file the AI wasn't given: keep it as plain text.
      if (!match || !knownPaths.has(match[1])) return part.trim();
      const [, path, start, end] = match;
      // Always show it the same way, e.g. "app.py:L10-L16".
      const label = `${path}:L${start}${end ? `-L${end}` : ""}`;
      // Markdown link format: [text](address)
      return `[${label}](${githubLineUrl(target, path, Number(start), Number(end ?? start))})`;
    });

    // If at least one citation became a link, join them back together.
    // If none did, put back the original text unchanged.
    return parts.some((p) => p.startsWith("[")) ? parts.join(", ") : whole;
  });
}
