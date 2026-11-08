// View 1: Repo Browser (PRD FR-1, ARCHITECTURE §11).
// Shows every repo the token can access, with a paste-a-URL box, search, sort, filters,
// a "show empty repos" toggle and pages of 20. Search/sort/filter run in the browser over the full list.
// Selecting a repo checks its index: fresh → open chat, missing → index it, stale → ask to re-index.
import { AlertCircle, ChevronDown, ChevronRight, RefreshCw, Search, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getIndexJob, getRepo, getStatus, listRepos, startIndex, type Repo } from "../api";
import IndexProgress from "../components/IndexProgress";

const PAGE_SIZE = 20;

/** Shows a date like "3 Nov 2026". */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** A native <select> with a custom chevron (keeps keyboard and screen-reader behaviour). */
function SelectField(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="select-field">
      <select {...props} />
      <ChevronDown size={14} aria-hidden="true" />
    </div>
  );
}

type SortKey = "updated" | "stars" | "name";
type TypeFilter = "all" | "original" | "fork";
type VisibilityFilter = "all" | "public" | "private";

interface Props {
  onOpenChat: (repo: Repo) => void;
}

/**
 * Splits pasted text into owner and repo name. Accepts "https://github.com/o/r",
 * "github.com/o/r" and "o/r". The server checks the names properly.
 */
function splitRepoInput(input: string): { owner: string; name: string } | null {
  const text = input.trim().replace(/^https?:\/\//i, "").replace(/^(www\.)?github\.com\//i, "");
  const [owner, name] = text.split(/[/?#]/);
  return owner && name ? { owner, name: name.replace(/\.git$/i, "") } : null;
}

export default function RepoBrowser({ onOpenChat }: Props) {
  // The full list from the server, and its loading/error state.
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [loadError, setLoadError] = useState("");

  // Search, sort, filters and paging.
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("updated");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [visibility, setVisibility] = useState<VisibilityFilter>("all");
  const [owner, setOwner] = useState("all");
  const [showEmpty, setShowEmpty] = useState(false);
  const [page, setPage] = useState(1);

  // Paste-a-URL box.
  const [urlInput, setUrlInput] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);

  // Selecting and indexing a repo.
  const [selected, setSelected] = useState<Repo | null>(null);
  const [askReindex, setAskReindex] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [message, setMessage] = useState("");

  /** Loads the repo list (refresh=true asks GitHub again instead of using the server's cache). */
  async function loadRepos(refresh = false) {
    setLoadError("");
    setRepos(null);
    try {
      setRepos(await listRepos(refresh));
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }

  // On first load: fetch the list, and show progress if a job is already running on the server.
  useEffect(() => {
    loadRepos();
    getIndexJob()
      .then((job) => {
        if (job && job.step !== "ready" && job.step !== "failed") setIndexing(true);
      })
      .catch(() => {});
  }, []);

  // Go back to page 1 whenever the search, sort or filters change.
  useEffect(() => setPage(1), [search, sort, typeFilter, visibility, owner, showEmpty]);

  /** Owner choices for the filter, taken from the list itself (no extra API call). */
  const owners = useMemo(() => [...new Set((repos ?? []).map((r) => r.owner))].sort(), [repos]);

  /** The list after search, filters and sort. */
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = (repos ?? []).filter(
      (r) =>
        (showEmpty || r.sizeKb > 0) &&
        (!term || r.name.toLowerCase().includes(term) || r.owner.toLowerCase().includes(term)) &&
        (typeFilter === "all" || (typeFilter === "fork") === r.isFork) &&
        (visibility === "all" || (visibility === "private") === r.isPrivate) &&
        (owner === "all" || r.owner === owner),
    );
    if (sort === "updated") list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (sort === "stars") list.sort((a, b) => b.stars - a.stars);
    if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return list;
  }, [repos, search, sort, typeFilter, visibility, owner, showEmpty]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageItems = visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  /** Checks the repo's index and decides what happens next (chat, index, or ask). */
  async function selectRepo(repo: Repo) {
    if (repo.sizeKb === 0) {
      setMessage("This repo is empty, so it can't be analysed.");
      return;
    }
    setMessage("");
    setSelected(repo);
    setAskReindex(false);
    try {
      const { status } = await getStatus(repo.owner, repo.name);
      if (status === "fresh") onOpenChat(repo);
      else if (status === "stale") setAskReindex(true);
      else await beginIndexing(repo);
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  /** Asks the server to start indexing, then shows the progress panel. */
  async function beginIndexing(repo: Repo) {
    setAskReindex(false);
    setMessage("");
    try {
      await startIndex(repo.owner, repo.name);
      setSelected(repo);
      setIndexing(true);
    } catch (err) {
      setMessage((err as Error).message); // e.g. "Another repo is being indexed"
    }
  }

  /** Looks up the pasted repo, then selects it. */
  async function openPastedUrl(e: React.FormEvent) {
    e.preventDefault();
    const parts = splitRepoInput(urlInput);
    if (!parts) {
      setMessage("That doesn't look like a GitHub repo. Use https://github.com/owner/repo, github.com/owner/repo or owner/repo.");
      return;
    }
    setUrlBusy(true);
    try {
      await selectRepo(await getRepo(parts.owner, parts.name));
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setUrlBusy(false);
    }
  }

  /** Called when the progress panel reports the job is done. */
  async function onIndexReady() {
    setIndexing(false);
    // A job started earlier (before this page loaded) may be for a repo we didn't select here.
    const job = await getIndexJob().catch(() => null);
    const repo = selected ?? (repos ?? []).find((r) => r.repoId === job?.repoId);
    if (repo) onOpenChat(repo);
  }

  const loading = !loadError && repos === null;

  return (
    <main className="page">
      <div className="page-title">
        <h1>Repositories</h1>
        <p>Open a repository to index it, then ask questions, see hotspots or generate a health report.</p>
      </div>

      <form className="card url-form" onSubmit={openPastedUrl}>
        <label htmlFor="repo-url">Open by URL</label>
        <input
          id="repo-url"
          type="text"
          placeholder="Paste a GitHub URL or owner/repo"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" disabled={urlBusy || !urlInput.trim()}>
          {urlBusy ? "Opening…" : "Open"}
        </button>
        <span className="hint">Accepts https://github.com/owner/repo, github.com/owner/repo or owner/repo</span>
      </form>

      {message && (
        <p className="error" role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{message}</span>
        </p>
      )}

      {askReindex && selected && (
        <div className="panel tint" role="status">
          <p>
            <strong>{selected.owner}/{selected.name}</strong> has new commits since it was indexed. Re-index?
          </p>
          <div className="row">
            <button className="secondary" onClick={() => onOpenChat(selected)}>Use the existing index</button>
            <button onClick={() => beginIndexing(selected)}>Re-index</button>
          </div>
        </div>
      )}

      {indexing && (
        <IndexProgress
          onReady={onIndexReady}
          onFailed={(msg) => {
            setIndexing(false);
            setMessage(msg);
          }}
        />
      )}

      <section className="browser-list" aria-label="Your repositories">
        <div className="filters">
          <div className="search-field">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              aria-label="Search by name or owner"
              placeholder="Search by name or owner"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <SelectField value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort">
            <option value="updated">Recently updated</option>
            <option value="stars">Most stars</option>
            <option value="name">Name (A–Z)</option>
          </SelectField>
          <SelectField value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as TypeFilter)} aria-label="Type">
            <option value="all">All types</option>
            <option value="original">Original only</option>
            <option value="fork">Forks only</option>
          </SelectField>
          <SelectField value={visibility} onChange={(e) => setVisibility(e.target.value as VisibilityFilter)} aria-label="Visibility">
            <option value="all">Public and private</option>
            <option value="public">Public</option>
            <option value="private">Private</option>
          </SelectField>
          <SelectField value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Owner">
            <option value="all">All owners</option>
            {owners.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </SelectField>
          <label className="checkbox">
            <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} />
            Show empty repos
          </label>
          <button className="secondary" onClick={() => loadRepos(true)} disabled={loading}>
            <RefreshCw size={14} aria-hidden="true" />
            Refresh
          </button>
        </div>

        {loadError && (
          <p className="error" role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            <span>{loadError}</span>
          </p>
        )}

        {loading && (
          <div className="card" aria-busy="true">
            <p className="sr-only">Loading repositories…</p>
            {[0, 1, 2, 3, 4].map((n) => (
              <div key={n} className="skeleton-row" aria-hidden="true">
                <div className="skeleton-bar" style={{ width: `${30 + ((n * 17) % 25)}%` }} />
                <div className="skeleton-bar" style={{ width: `${55 + ((n * 11) % 30)}%` }} />
              </div>
            ))}
          </div>
        )}

        {repos?.length === 0 && <p className="card list-message">Your GitHub token can't access any repositories.</p>}
        {repos && repos.length > 0 && visible.length === 0 && (
          <p className="card list-message">No repositories match your search and filters.</p>
        )}

        {pageItems.length > 0 && (
          <ul className={indexing ? "card repo-list is-disabled" : "card repo-list"}>
            {pageItems.map((r) => (
              <li key={r.repoId}>
                <button className="repo" onClick={() => selectRepo(r)} disabled={r.sizeKb === 0 || indexing}>
                  <span className="repo-main">
                    <span className="repo-title">
                      <span>
                        <span className="muted">{r.owner}/</span>
                        <strong>{r.name}</strong>
                      </span>
                      {r.isPrivate && <span className="badge">Private</span>}
                      {r.isFork && <span className="badge">Fork</span>}
                      {r.sizeKb === 0 && <span className="badge empty">Empty</span>}
                    </span>
                    {r.description && <span className="repo-desc">{r.description}</span>}
                    <span className="repo-meta">
                      {r.language && <span>{r.language}</span>}
                      <span>
                        <Star size={12} aria-hidden="true" />
                        {r.stars}
                        <span className="sr-only"> stars</span>
                      </span>
                      <span>Updated {shortDate(r.updatedAt)}</span>
                    </span>
                  </span>
                  <ChevronRight className="repo-chevron" size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {visible.length > PAGE_SIZE && (
          <div className="pager">
            <span className="muted">
              Page {page} of {pageCount} · {visible.length} repos
            </span>
            <div className="row">
              <button className="secondary" onClick={() => setPage(page - 1)} disabled={page === 1}>Previous</button>
              <button className="secondary" onClick={() => setPage(page + 1)} disabled={page === pageCount}>Next</button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
