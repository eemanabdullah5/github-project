// Tests for F1 — Clickable sources, and Verified citations.
import { describe, expect, it } from "vitest";
import { checkCitations, githubLineUrl, isCitationVerified, linkCitations, UNVERIFIED_HREF, UNVERIFIED_TITLE } from "./sourceLinks";

const target = { owner: "octo", name: "hello", ref: "abc123" };
const sources = [
  { path: "README.md", startLine: 1, endLine: 60, symbol: "" },
  { path: "src/my app.py", startLine: 10, endLine: 16, symbol: "login" },
];

describe("githubLineUrl", () => {
  it("links to a line range at the commit", () => {
    expect(githubLineUrl(target, "src/app.py", 10, 16)).toBe("https://github.com/octo/hello/blob/abc123/src/app.py#L10-L16");
  });

  it("links a single line and encodes spaces in paths", () => {
    expect(githubLineUrl(target, "src/my app.py", 7, 7)).toBe("https://github.com/octo/hello/blob/abc123/src/my%20app.py#L7");
  });
});

describe("linkCitations", () => {
  it("turns a citation into a Markdown link", () => {
    expect(linkCitations("See [README.md:L1-L6].", target, sources)).toBe(
      "See [README.md:L1-L6](https://github.com/octo/hello/blob/abc123/README.md#L1-L6).",
    );
  });

  it("handles several citations in one bracket", () => {
    expect(linkCitations("[README.md:L10-L16, src/my app.py:L11-L14]", target, sources)).toBe(
      "[README.md:L10-L16](https://github.com/octo/hello/blob/abc123/README.md#L10-L16), " +
        "[src/my app.py:L11-L14](https://github.com/octo/hello/blob/abc123/src/my%20app.py#L11-L14)",
    );
  });

  it("accepts L10-16 and single lines", () => {
    expect(linkCitations("[README.md:L10-16] [README.md:L3]", target, sources)).toBe(
      "[README.md:L10-L16](https://github.com/octo/hello/blob/abc123/README.md#L10-L16) " +
        "[README.md:L3](https://github.com/octo/hello/blob/abc123/README.md#L3)",
    );
  });

  it("accepts citations without the L, like [README.md:23-45]", () => {
    expect(linkCitations("[README.md:23-45, README.md:9]", target, sources)).toBe(
      "[README.md:L23-L45](https://github.com/octo/hello/blob/abc123/README.md#L23-L45), " +
        "[README.md:L9](https://github.com/octo/hello/blob/abc123/README.md#L9)",
    );
  });

  it("marks citations of files that weren't retrieved as unverified", () => {
    expect(linkCitations("[made/up.py:L1-L2]", target, sources)).toBe(`[made/up.py:L1-L2](${UNVERIFIED_HREF} "${UNVERIFIED_TITLE}")`);
  });

  it("marks lines outside the retrieved chunk as unverified, even in a real file", () => {
    expect(linkCitations("[src/my app.py:L1-L4]", target, sources)).toBe(`[src/my app.py:L1-L4](${UNVERIFIED_HREF} "${UNVERIFIED_TITLE}")`);
  });

  it("links the verified citation and flags the other in a mixed group", () => {
    expect(linkCitations("[README.md:L3, src/my app.py:L40]", target, sources)).toBe(
      "[README.md:L3](https://github.com/octo/hello/blob/abc123/README.md#L3), " +
        `[src/my app.py:L40](${UNVERIFIED_HREF} "${UNVERIFIED_TITLE}")`,
    );
  });

  it("writes unverified citations as plain text for a downloaded file", () => {
    expect(linkCitations("See [made/up.py:L1-L2].", target, sources, { forExport: true })).toBe("See made/up.py:L1-L2 (⚠ unverified).");
  });

  it("leaves existing links and normal brackets alone", () => {
    const text = "[docs](https://x.y) and [optional] and arr[0]";
    expect(linkCitations(text, target, sources)).toBe(text);
  });
});

describe("isCitationVerified", () => {
  const chunks = [
    { path: "a.py", startLine: 1, endLine: 60, symbol: "" },
    { path: "a.py", startLine: 51, endLine: 110, symbol: "" }, // overlaps the first, like the line chunker's 10-line overlap
    { path: "a.py", startLine: 200, endLine: 220, symbol: "" },
  ];

  it("accepts lines inside one chunk", () => {
    expect(isCitationVerified(chunks, "a.py", 10, 20)).toBe(true);
    expect(isCitationVerified(chunks, "a.py", 205, 205)).toBe(true);
  });

  it("accepts a range covered by overlapping or touching chunks together", () => {
    expect(isCitationVerified(chunks, "a.py", 40, 100)).toBe(true);
  });

  it("rejects a range that runs into lines nobody retrieved", () => {
    expect(isCitationVerified(chunks, "a.py", 100, 150)).toBe(false); // 111-150 were never shown
    expect(isCitationVerified(chunks, "a.py", 150, 210)).toBe(false); // starts in the gap
    expect(isCitationVerified(chunks, "a.py", 215, 230)).toBe(false); // runs past the end
  });

  it("rejects other files and impossible line numbers", () => {
    expect(isCitationVerified(chunks, "b.py", 1, 5)).toBe(false);
    expect(isCitationVerified(chunks, "a.py", 0, 5)).toBe(false);
    expect(isCitationVerified(chunks, "a.py", 20, 10)).toBe(false);
  });
});

describe("checkCitations", () => {
  it("counts verified and unverified citations, ignoring normal links and brackets", () => {
    const text = "[README.md:L1-L6] [made/up.py:L1] [src/my app.py:L10-L16, src/my app.py:L99] [docs](https://x.y) [optional]";
    expect(checkCitations(text, sources)).toEqual({ verified: 2, unverified: 2 });
  });

  it("finds nothing in an answer without citations", () => {
    expect(checkCitations("No citations here.", sources)).toEqual({ verified: 0, unverified: 0 });
  });
});
