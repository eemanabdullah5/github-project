// How links inside answers and reports are drawn (F1 + Verified citations).
//  - normal links open in a new tab, so the chat stays open
//  - unverified citations (see sourceLinks.ts) are drawn as a ⚠ badge, not a link
import { TriangleAlert } from "lucide-react";
import type { Source } from "../api";
import { checkCitations, UNVERIFIED_HREF, UNVERIFIED_TITLE } from "../sourceLinks";

type AnchorProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown };

function CitationLink({ node: _node, href, children, ...rest }: AnchorProps) {
  if (href === UNVERIFIED_HREF) {
    return (
      <span className="citation-unverified" title={UNVERIFIED_TITLE}>
        <TriangleAlert size={12} aria-hidden="true" />
        {children}
        <span className="sr-only"> (unverified citation)</span>
      </span>
    );
  }
  return <a {...rest} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

/** Pass to ReactMarkdown's `components`. */
export const markdownComponents = { a: CitationLink };

/** One line under an answer or report when some citations couldn't be verified. Shows nothing otherwise. */
export function CitationWarning({ markdown, sources }: { markdown: string; sources: Source[] }) {
  const { unverified } = checkCitations(markdown, sources);
  if (unverified === 0) return null;
  return (
    <p className="citation-warning" role="note">
      <TriangleAlert size={14} aria-hidden="true" />
      {unverified === 1
        ? "1 citation points to code the AI wasn't shown. Double-check that claim."
        : `${unverified} citations point to code the AI wasn't shown. Double-check those claims.`}
    </p>
  );
}
