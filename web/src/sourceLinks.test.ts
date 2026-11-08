// Tests for F1 — Clickable sources.
import { describe, expect, it } from "vitest";
import { githubLineUrl, linkCitations } from "./sourceLinks";

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
    expect(linkCitations("[README.md:L10-L16, src/my app.py:L1-L4]", target, sources)).toBe(
      "[README.md:L10-L16](https://github.com/octo/hello/blob/abc123/README.md#L10-L16), " +
        "[src/my app.py:L1-L4](https://github.com/octo/hello/blob/abc123/src/my%20app.py#L1-L4)",
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

  it("leaves citations of files that weren't retrieved as plain text", () => {
    expect(linkCitations("[made/up.py:L1-L2]", target, sources)).toBe("[made/up.py:L1-L2]");
  });

  it("leaves existing links and normal brackets alone", () => {
    const text = "[docs](https://x.y) and [optional] and arr[0]";
    expect(linkCitations(text, target, sources)).toBe(text);
  });
});
