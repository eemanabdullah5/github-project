// Dependency scan: reads the repo's dependency files directly and lists every library with its version.
// Why: the AI only sees a few code chunks, so it can miss libraries or get versions wrong. This is exact.
//
// Files read (one small reader each):
//  - package.json         → JavaScript / TypeScript (npm)
//  - requirements*.txt    → Python (pip)
//  - pyproject.toml       → Python (PEP 621 and Poetry)
//  - go.mod               → Go
//  - pom.xml              → Java (Maven)
// No AI and no network. Runs at the end of indexing; older repos get it the first time it's asked for.
// Saved in data/dependencies/<owner>__<repo>.json.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { AppError } from "./errors.js";
import { downloadZipball } from "./githubClient.js";
import { extractSourceFiles } from "./ingestion.js";
import type { SourceFile } from "./types.js";
import { loadManifest } from "./vectorStore.js";

const DEPS_DIR = path.join(DATA_DIR, "dependencies");

export type Ecosystem = "npm" | "pip" | "go" | "maven";

// runtime = needed to run the app · dev = only for building/testing · optional = an extra feature
// indirect = pulled in by another library (Go marks these)
export type DependencyKind = "runtime" | "dev" | "optional" | "indirect";

/** One library, as declared in one dependency file. */
export interface Dependency {
  name: string; // e.g. "express", "requests", "github.com/gin-gonic/gin", "org.slf4j:slf4j-api"
  version: string; // as written, e.g. "^5.1.0", ">=2.31", "v1.9.1". "" = no version given
  ecosystem: Ecosystem;
  kind: DependencyKind;
  file: string; // the file it's declared in, e.g. "server/package.json"
}

/** Everything the scan found, for one indexed commit. */
export interface DependencyScan {
  repoId: string;
  commitSha: string;
  generatedAt: string;
  files: Array<{ path: string; ecosystem: Ecosystem; count: number; error?: string }>; // each dependency file read
  dependencies: Dependency[];
}

/** What a reader returns: the libraries in one file (without `ecosystem` and `file`, which are added after). */
type Found = Array<Pick<Dependency, "name" | "version" | "kind">>;

// ---------- Small helpers ----------

/** Removes a `#` comment from a line, unless the `#` is inside quotes. */
function stripComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

/** All "quoted strings" in a piece of text. */
function quotedStrings(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
}

/**
 * Reads one Python requirement, like "requests[socks]>=2.31,<3 ; python_version>'3.8'".
 * Returns its name and version ("" if none). Returns null for anything that isn't a library.
 */
export function parseRequirement(spec: string): { name: string; version: string } | null {
  const text = spec.split(";")[0].trim(); // drop "; python_version…" conditions
  const m = text.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/); // name, [extras], rest
  if (!m) return null;
  const rest = m[2].trim();
  if (rest.startsWith("@")) return { name: m[1], version: "from URL" }; // "pkg @ git+https://…"
  return { name: m[1], version: rest.replace(/[()\s]/g, "") };
}

// ---------- One reader per file type ----------

/** package.json: dependencies, devDependencies, peerDependencies, optionalDependencies. */
export function readPackageJson(text: string): Found {
  const json = JSON.parse(text) as Record<string, unknown>;
  const sections: Array<[string, DependencyKind]> = [
    ["dependencies", "runtime"],
    ["peerDependencies", "runtime"], // needed at runtime, installed by the app that uses this package
    ["optionalDependencies", "optional"],
    ["devDependencies", "dev"],
  ];
  const found: Found = [];
  for (const [section, kind] of sections) {
    const deps = json[section];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, version] of Object.entries(deps)) found.push({ name, version: String(version ?? ""), kind });
  }
  return found;
}

/** requirements.txt: one library per line. Files named like "requirements-dev.txt" count as dev. */
export function readRequirementsTxt(text: string, fileName: string): Found {
  const kind: DependencyKind = /dev|test|lint|doc/i.test(fileName) ? "dev" : "runtime";
  const found: Found = [];
  for (const raw of text.split("\n")) {
    const line = stripComment(raw).trim();
    // Skip blanks, options (-r other.txt, -e ., --index-url …) and bare URLs or paths.
    if (!line || line.startsWith("-") || /^(?:[a-z+]+:\/\/|\.|\/)/i.test(line)) continue;
    const req = parseRequirement(line);
    if (req) found.push({ ...req, kind });
  }
  return found;
}

/**
 * pyproject.toml: a small reader for only the parts that list libraries (not a full TOML parser):
 *  - [project] dependencies = [...]                    → runtime
 *  - [project.optional-dependencies] name = [...]      → dev if the group is dev/test/lint/docs, else optional
 *  - [dependency-groups] name = [...]                  → dev
 *  - [tool.poetry.dependencies] name = "^1.2"          → runtime ("python" itself is skipped)
 *  - [tool.poetry.dev-dependencies] / [tool.poetry.group.<x>.dependencies] → dev
 */
export function readPyprojectToml(text: string): Found {
  const found: Found = [];
  const devGroup = (name: string) => /dev|test|lint|doc/i.test(name);
  let section = "";
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim();
    const header = line.match(/^\[([^[\]]+)\]$/);
    if (header) {
      section = header[1].trim();
      continue;
    }
    const kv = line.match(/^["']?([A-Za-z0-9_.-]+)["']?\s*=\s*(.*)$/);
    if (!kv) continue;
    const [, key] = kv;
    let value = kv[2];

    // An array can span many lines: keep reading until the brackets close.
    if (value.startsWith("[")) {
      let depth = 0;
      for (let j = i; ; j++) {
        if (j > i) value += ` ${stripComment(lines[j] ?? "")}`;
        depth = (value.match(/\[/g)?.length ?? 0) - (value.match(/]/g)?.length ?? 0);
        if (depth <= 0 || j >= lines.length - 1) {
          i = j;
          break;
        }
      }
      let kind: DependencyKind | null = null;
      if (section === "project" && key === "dependencies") kind = "runtime";
      else if (section === "project.optional-dependencies") kind = devGroup(key) ? "dev" : "optional";
      else if (section === "dependency-groups") kind = "dev";
      if (!kind) continue;
      for (const spec of quotedStrings(value)) {
        const req = parseRequirement(spec);
        if (req) found.push({ ...req, kind });
      }
      continue;
    }

    // Poetry: name = "^1.2"  or  name = { version = "^1.2", optional = true }
    const poetryRuntime = section === "tool.poetry.dependencies";
    const poetryDev = section === "tool.poetry.dev-dependencies" || /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section);
    if ((poetryRuntime || poetryDev) && key.toLowerCase() !== "python") {
      const version = value.startsWith("{") ? (value.match(/version\s*=\s*["']([^"']*)["']/)?.[1] ?? "") : (quotedStrings(value)[0] ?? "");
      const optional = /optional\s*=\s*true/.test(value);
      found.push({ name: key, version, kind: poetryDev ? "dev" : optional ? "optional" : "runtime" });
    }
  }
  return found;
}

/** go.mod: "require path v1.2.3" lines and require ( … ) blocks. "// indirect" marks indirect ones. */
export function readGoMod(text: string): Found {
  const found: Found = [];
  let inBlock = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^require\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ")") {
      inBlock = false;
      continue;
    }
    const entry = inBlock ? line : line.match(/^require\s+(.+)$/)?.[1];
    const m = entry?.match(/^(\S+)\s+(v\S+)(.*)$/);
    if (m) found.push({ name: m[1], version: m[2], kind: m[3].includes("// indirect") ? "indirect" : "runtime" });
  }
  return found;
}

/**
 * pom.xml: each <dependency> (groupId:artifactId, version, scope).
 * Skips <dependencyManagement> (version rules, not dependencies) and <build> (build plugins).
 * Fills in ${property} versions from <properties>. No version = set by a parent pom ("managed").
 */
export function readPomXml(text: string): Found {
  const xml = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, "")
    .replace(/<build>[\s\S]*?<\/build>/g, "");
  const tag = (block: string, name: string) => block.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`))?.[1] ?? "";

  const props = new Map<string, string>();
  const propsBlock = xml.match(/<properties>([\s\S]*?)<\/properties>/)?.[1] ?? "";
  for (const m of propsBlock.matchAll(/<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g)) props.set(m[1], m[2]);
  const resolve = (v: string) => v.replace(/\$\{([^}]+)\}/g, (all, key: string) => props.get(key) ?? all);

  const found: Found = [];
  for (const [, block] of xml.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const group = tag(block, "groupId");
    const artifact = tag(block, "artifactId");
    if (!artifact) continue;
    const scope = tag(block, "scope");
    const version = resolve(tag(block, "version")) || "managed";
    const kind: DependencyKind = scope === "test" ? "dev" : tag(block, "optional") === "true" ? "optional" : "runtime";
    found.push({ name: group ? `${group}:${artifact}` : artifact, version, kind });
  }
  return found;
}

// ---------- The scan ----------

/** Which reader (if any) handles a file, decided by its name. */
function readerFor(filePath: string): { ecosystem: Ecosystem; read: (text: string) => Found } | null {
  const name = path.posix.basename(filePath).toLowerCase();
  if (name === "package.json") return { ecosystem: "npm", read: readPackageJson };
  if (/^requirements[\w.-]*\.txt$/.test(name)) return { ecosystem: "pip", read: (t) => readRequirementsTxt(t, name) };
  if (name === "pyproject.toml") return { ecosystem: "pip", read: readPyprojectToml };
  if (name === "go.mod") return { ecosystem: "go", read: readGoMod };
  if (name === "pom.xml") return { ecosystem: "maven", read: readPomXml };
  return null;
}

/**
 * Reads every dependency file in the repo. A file that can't be read (e.g. broken JSON) is listed
 * with its error instead of stopping the scan.
 */
export function scanDependencies(files: SourceFile[], meta: { repoId: string; commitSha: string }): DependencyScan {
  const scan: DependencyScan = { ...meta, generatedAt: new Date().toISOString(), files: [], dependencies: [] };
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const reader = readerFor(file.path);
    if (!reader) continue;
    try {
      const found = reader.read(file.text);
      scan.files.push({ path: file.path, ecosystem: reader.ecosystem, count: found.length });
      for (const dep of found) scan.dependencies.push({ ...dep, ecosystem: reader.ecosystem, file: file.path });
    } catch (err) {
      scan.files.push({ path: file.path, ecosystem: reader.ecosystem, count: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return scan;
}

/**
 * True if the version doesn't pin anything, so a fresh install can get a different version.
 * Why it matters: builds can break, or change behaviour, without any code change.
 */
export function isUnpinned(dep: Dependency): boolean {
  if (dep.ecosystem === "go" || dep.version === "managed" || dep.version === "from URL") return false;
  return ["", "*", "latest", "x"].includes(dep.version.trim().toLowerCase());
}

// ---------- Saving and loading ----------

/** Where the scan is saved, e.g. data/dependencies/octo__hello.json. */
function depsPath(repoId: string): string {
  return path.join(DEPS_DIR, `${repoId.replace("/", "__")}.json`);
}

/** Saves a scan to disk. */
export async function saveDependencies(scan: DependencyScan): Promise<void> {
  await mkdir(DEPS_DIR, { recursive: true });
  await writeFile(depsPath(scan.repoId), JSON.stringify(scan));
}

/** Reads a saved scan, or null if there isn't one. */
async function loadDependencies(repoId: string): Promise<DependencyScan | null> {
  try {
    return JSON.parse(await readFile(depsPath(repoId), "utf8")) as DependencyScan;
  } catch {
    return null;
  }
}

// Repos being scanned right now. Why: so two requests at once don't both download the repo.
const scanning = new Map<string, Promise<DependencyScan>>();

/**
 * The scan for the repo's indexed commit. If it's missing or from an older commit, downloads the code
 * at the indexed commit and scans it now (a few seconds). Why: repos indexed before this feature still work.
 */
export async function getDependencies(owner: string, repo: string, repoId: string): Promise<DependencyScan> {
  const manifest = await loadManifest(repoId);
  if (!manifest) throw new AppError("This repo hasn't been indexed yet. Index it first.", 404);
  const saved = await loadDependencies(repoId);
  if (saved && saved.commitSha === manifest.commitSha) return saved;

  let job = scanning.get(repoId);
  if (!job) {
    job = (async () => {
      const files = extractSourceFiles(await downloadZipball(owner, repo, manifest.commitSha));
      const scan = scanDependencies(files, { repoId, commitSha: manifest.commitSha });
      await saveDependencies(scan);
      return scan;
    })().finally(() => scanning.delete(repoId));
    scanning.set(repoId, job);
  }
  return job;
}
