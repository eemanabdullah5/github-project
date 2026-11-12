// GitHub client (ARCHITECTURE §5).
// The ONLY file that talks to the GitHub REST API. It lists the repos the token
// can see, looks up single repos, finds the latest commit and downloads zip files.
// Every GitHub problem is turned into an AppError with a message the user can read.
import { config, MAX_REPOS } from "./config.js";
import { AppError } from "./errors.js";
import type { Repo } from "./types.js";

const API = "https://api.github.com";
const PER_PAGE = 100;

// GitHub's naming rules: owners are letters, digits and single hyphens;
// repo names are letters, digits, ".", "_" and "-".
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Turns whatever the user pasted into { owner, repo }.
 * Accepts "https://github.com/o/r", "github.com/o/r" and "o/r".
 * Ignores a trailing ".git" and any extra path such as "/tree/main".
 * Throws a 400 AppError if the input isn't a valid repo name.
 */
export function parseRepoUrl(input: string): { owner: string; repo: string } {
  let text = input.trim();
  text = text.replace(/^https?:\/\//i, ""); // drop "https://"
  text = text.replace(/^(www\.)?github\.com\//i, ""); // drop "github.com/"

  const [owner = "", rawRepo = ""] = text.split(/[/?#]/); // keep only the first two parts
  const repo = rawRepo.replace(/\.git$/i, "");

  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === "." || repo === "..") {
    throw new AppError(
      "That doesn't look like a GitHub repo. Use https://github.com/owner/repo, github.com/owner/repo or owner/repo.",
      400,
    );
  }
  return { owner, repo };
}

/** A repo's ID is "owner/repo" in lower case, because GitHub names ignore case. */
export function toRepoId(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase();
}

/**
 * Sends one request to the GitHub API with the token attached.
 * Turns every failure into an AppError the user can understand:
 * 401 bad token, 404 not found, 403/429 rate limit, or no network.
 * The token is never put in an error message.
 */
export async function githubFetch(path: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      headers: {
        Authorization: `Bearer ${config.githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch {
    throw new AppError("Couldn't reach GitHub. Check your internet connection and try again.", 502);
  }

  if (res.ok) return res;

  if (res.status === 401) {
    throw new AppError("GitHub token missing or invalid. Check GITHUB_TOKEN in your .env file.", 401);
  }
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
    const when = reset ? new Date(reset).toLocaleTimeString() : "in a few minutes";
    throw new AppError(`GitHub rate limit reached. Try again after ${when}.`, 429);
  }
  if (res.status === 404) {
    throw new AppError("Repo not found, or your token can't access it.", 404);
  }
  throw new AppError(`GitHub returned an error (${res.status}). Please try again.`, 502);
}

/** The fields we read from GitHub's repo JSON. */
interface GitHubRepo {
  name: string;
  owner: { login: string };
  description: string | null;
  language: string | null;
  stargazers_count: number;
  updated_at: string;
  fork: boolean;
  private: boolean;
  size: number;
  default_branch: string;
}

/** Converts GitHub's repo JSON into our smaller Repo type. */
function toRepo(r: GitHubRepo): Repo {
  return {
    repoId: toRepoId(r.owner.login, r.name),
    owner: r.owner.login,
    name: r.name,
    description: r.description,
    language: r.language,
    stars: r.stargazers_count,
    updatedAt: r.updated_at,
    isFork: r.fork,
    isPrivate: r.private,
    sizeKb: r.size,
    defaultBranch: r.default_branch,
  };
}

/**
 * Lists every repo the token can see: owned, collaborator and organisation repos,
 * public and private. Fetches 100 per page until a page is empty or we reach
 * MAX_REPOS (1,000).
 */
export async function listAccessibleRepos(): Promise<Repo[]> {
  const repos: Repo[] = [];
  for (let page = 1; repos.length < MAX_REPOS; page++) {
    const res = await githubFetch(
      `/user/repos?affiliation=owner,collaborator,organization_member&per_page=${PER_PAGE}&page=${page}`,
    );
    const batch = (await res.json()) as GitHubRepo[];
    if (batch.length === 0) break;
    repos.push(...batch.map(toRepo));
    if (batch.length < PER_PAGE) break; // last page
  }
  return repos.slice(0, MAX_REPOS);
}

/** Looks up a single repo (used by paste-a-URL and before indexing). */
export async function getRepo(owner: string, repo: string): Promise<Repo> {
  const res = await githubFetch(`/repos/${owner}/${repo}`);
  return toRepo((await res.json()) as GitHubRepo);
}

/** Returns the SHA of the newest commit on a branch. Used to tell if an index is out of date. */
export async function getLatestCommitSha(owner: string, repo: string, branch: string): Promise<string> {
  const res = await githubFetch(`/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`);
  const body = (await res.json()) as { sha: string };
  return body.sha;
}

/** Downloads the repo's code at an exact commit as a zip file, kept in memory. */
export async function downloadZipball(owner: string, repo: string, sha: string): Promise<Uint8Array> {
  const res = await githubFetch(`/repos/${owner}/${repo}/zipball/${sha}`);
  return new Uint8Array(await res.arrayBuffer());
}

// ---------- F4: commit history ----------

// One commit from GitHub's commit list: who made it, when, and whether it's a merge or a bot.
export interface CommitSummary {
  sha: string;
  login: string; // GitHub username, or "" if the commit's email isn't linked to an account
  name: string; // the author name written in the commit
  email: string; // the author email written in the commit
  date: string;
  isMerge: boolean; // merge commits have 2 parents; they repeat changes already counted
  isBot: boolean; // e.g. dependabot
}

// F4: lists commits on a branch since a date, newest first, up to `max`.
// GitHub gives 100 per page, so we keep asking for the next page until we have enough.
// Note: this list does NOT say which files changed. getCommitFiles() does that, one commit at a time.
export async function listCommits(owner: string, repo: string, branch: string, since: string, max: number): Promise<CommitSummary[]> {
  const commits: CommitSummary[] = [];
  for (let page = 1; commits.length < max; page++) {
    const res = await githubFetch(
      `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&since=${encodeURIComponent(since)}&per_page=${PER_PAGE}&page=${page}`,
    );
    // Only the fields we use from GitHub's reply.
    const batch = (await res.json()) as Array<{
      sha: string;
      commit: { author: { name?: string; email?: string; date: string } | null };
      author: { login: string; type?: string } | null;
      parents: unknown[];
    }>;
    for (const c of batch) {
      const login = c.author?.login ?? "";
      const name = c.commit.author?.name ?? "";
      commits.push({
        sha: c.sha,
        login,
        name,
        email: c.commit.author?.email ?? "",
        date: c.commit.author?.date ?? "",
        isMerge: c.parents.length > 1,
        isBot: c.author?.type === "Bot" || login.endsWith("[bot]") || name.endsWith("[bot]"),
      });
    }
    if (batch.length < PER_PAGE) break; // a short page means it was the last one
  }
  return commits.slice(0, max);
}

// F4: asks GitHub which files one commit changed, how many lines were added and deleted in each,
// and the file's status ("added", "modified", "removed", "renamed", …).
export async function getCommitFiles(
  owner: string,
  repo: string,
  sha: string,
): Promise<Array<{ path: string; added: number; deleted: number; status: string }>> {
  const res = await githubFetch(`/repos/${owner}/${repo}/commits/${sha}`);
  const body = (await res.json()) as { files?: Array<{ filename: string; additions: number; deletions: number; status: string }> };
  return (body.files ?? []).map((f) => ({ path: f.filename, added: f.additions, deleted: f.deletions, status: f.status }));
}

// ---------- PR risk briefing ----------

/** A pull request, as the briefing needs it. */
export interface PullRequestInfo {
  number: number;
  title: string;
  url: string;
  author: string; // GitHub login
  state: "open" | "closed" | "merged";
  draft: boolean;
  baseRef: string; // the branch it merges into
  headSha: string; // the PR's latest commit
  baseSha: string; // the commit it was compared against
  additions: number;
  deletions: number;
  changedFiles: number;
  updatedAt: string;
}

/** One file changed by a pull request. `patch` is the diff (missing for binary or very large files). */
export interface PullRequestFile {
  path: string;
  previousPath?: string; // for renamed files
  status: string; // "added", "modified", "removed", "renamed"…
  additions: number;
  deletions: number;
  patch?: string;
}

type GitHubPull = {
  number: number;
  title: string;
  html_url: string;
  user: { login: string } | null;
  state: "open" | "closed";
  merged_at: string | null;
  draft?: boolean;
  base: { ref: string; sha: string };
  head: { sha: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
  updated_at: string;
};

function toPullRequest(p: GitHubPull): PullRequestInfo {
  return {
    number: p.number,
    title: p.title,
    url: p.html_url,
    author: p.user?.login ?? "",
    state: p.merged_at ? "merged" : p.state,
    draft: !!p.draft,
    baseRef: p.base.ref,
    headSha: p.head.sha,
    baseSha: p.base.sha,
    additions: p.additions ?? 0,
    deletions: p.deletions ?? 0,
    changedFiles: p.changed_files ?? 0,
    updatedAt: p.updated_at,
  };
}

/** One pull request. */
export async function getPullRequest(owner: string, repo: string, number: number): Promise<PullRequestInfo> {
  const res = await githubFetch(`/repos/${owner}/${repo}/pulls/${number}`);
  return toPullRequest((await res.json()) as GitHubPull);
}

/** The newest open pull requests (for the picker). */
export async function listOpenPullRequests(owner: string, repo: string, max = 30): Promise<PullRequestInfo[]> {
  const res = await githubFetch(`/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${Math.min(max, PER_PAGE)}`);
  return ((await res.json()) as GitHubPull[]).map(toPullRequest);
}

/** The files a pull request changes, with their diffs. GitHub lists at most 3,000; we read up to `max`. */
export async function getPullRequestFiles(owner: string, repo: string, number: number, max = 300): Promise<PullRequestFile[]> {
  const files: PullRequestFile[] = [];
  for (let page = 1; files.length < max; page++) {
    const res = await githubFetch(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=${PER_PAGE}&page=${page}`);
    const batch = (await res.json()) as Array<{
      filename: string;
      previous_filename?: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    }>;
    for (const f of batch) {
      files.push({ path: f.filename, previousPath: f.previous_filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch });
    }
    if (batch.length < PER_PAGE) break;
  }
  return files.slice(0, max);
}

/** Logins of people who recently changed a file (newest first, bots left out). Used to suggest reviewers. */
export async function recentFileAuthors(owner: string, repo: string, path: string, max = 30): Promise<string[]> {
  const res = await githubFetch(`/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}&per_page=${Math.min(max, PER_PAGE)}`);
  const commits = (await res.json()) as Array<{ author: { login: string; type?: string } | null }>;
  return commits.map((c) => c.author).filter((a) => a && a.type !== "Bot" && !a.login.endsWith("[bot]")).map((a) => a!.login);
}

/** A file's text at a commit, or null if it doesn't exist there (or is too big for the API). */
export async function getFileAtRef(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  try {
    const res = await githubFetch(`/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`);
    const body = (await res.json()) as { encoding?: string; content?: string };
    return body.encoding === "base64" && body.content ? Buffer.from(body.content, "base64").toString("utf8") : null;
  } catch {
    return null;
  }
}
