// Calls tab (call graph, phase 3): who calls a function, and what it calls.
//  1. headline numbers   2. pick a function (search box, or a "most called" button)   3. depth 1 or 2
//  4. the diagram: callers → the function → callees (Mermaid, like the architecture map)
//  5. the same callers and callees as lists, with links to the exact line on GitHub
// Navigation: every function in the lists has a "Show its calls" button that moves the diagram to it,
// and "Back" returns to the previous one. Why buttons, not clicks on the diagram boxes: clicking inside the
// diagram would need Mermaid's less strict security mode, which we keep off so repo text can't run as code.
import { AlertCircle, ArrowLeft, Crosshair } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getCallFocus, getCallFunctions, type CallFocus, type CallFunction, type CallGraphStats, type FocusItem, type Repo } from "../api";
import { githubLineUrl, type LinkTarget } from "../sourceLinks";
import { Stat } from "./Hotspots";
import MermaidDiagram from "./MermaidDiagram";

interface Props {
  repo: Repo;
}

/** How a function is named in the picker: "Agent.remember — agents.py". Top-level code: "demo.py (top level)". */
function pickerLabel(fn: CallFunction): string {
  return fn.kind === "top-level" ? `${fn.file} (top level)` : `${fn.qualified} — ${fn.file}`;
}

/** A function's short name for lists and buttons: "Agent.remember()" or "demo.py (top level)". */
function shortName(fn: CallFunction): string {
  return fn.kind === "top-level" ? `${fn.file.split("/").pop()} (top level)` : `${fn.qualified}()`;
}

export default function CallGraph({ repo }: Props) {
  const [functions, setFunctions] = useState<CallFunction[]>([]);
  const [stats, setStats] = useState<CallGraphStats | null>(null);
  const [focusId, setFocusId] = useState("");
  const [trail, setTrail] = useState<string[]>([]); // functions visited before this one, for "Back"
  const [depth, setDepth] = useState<1 | 2>(1);
  const [view, setView] = useState<CallFocus | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Load the function list once per repo, and start on the most-called function that also calls something.
  useEffect(() => {
    setLoading(true);
    setError("");
    setTrail([]);
    getCallFunctions(repo.owner, repo.name)
      .then((data) => {
        setFunctions(data.functions);
        setStats(data.stats);
        const real = data.functions.filter((f) => !f.isTest && f.kind !== "top-level");
        const start = real.find((f) => (f.callers ?? 0) > 0 && (f.callees ?? 0) > 0) ?? real[0] ?? data.functions[0];
        setFocusId(start?.id ?? "");
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [repo.owner, repo.name]);

  // Load the diagram whenever the function or depth changes.
  useEffect(() => {
    if (!focusId) return;
    setError("");
    getCallFocus(repo.owner, repo.name, focusId, depth)
      .then(setView)
      .catch((err) => setError(err.message));
  }, [repo.owner, repo.name, focusId, depth]);

  const byLabel = useMemo(() => new Map(functions.map((f) => [pickerLabel(f), f.id])), [functions]);
  const mostCalled = functions.filter((f) => !f.isTest && f.kind !== "top-level" && (f.callers ?? 0) > 0).slice(0, 6);

  /** Moves the diagram to another function, remembering where we were for "Back". */
  function go(id: string) {
    if (!id || id === focusId) return;
    setTrail((t) => [...t, focusId]);
    setFocusId(id);
    setSearch("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function back() {
    const previous = trail[trail.length - 1];
    if (!previous) return;
    setTrail((t) => t.slice(0, -1));
    setFocusId(previous);
  }

  if (loading) {
    return (
      <div className="tab-page">
        <p className="muted" role="status">
          Reading the code to find which function calls which…
        </p>
      </div>
    );
  }
  if (error && !view) {
    return (
      <div className="tab-page">
        <p className="error" role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{error}</span>
        </p>
      </div>
    );
  }
  if (functions.length === 0) {
    return (
      <div className="tab-page">
        <p className="muted">No Python, JavaScript or TypeScript functions found, so there's no call graph yet. Other languages come later.</p>
      </div>
    );
  }

  const target: LinkTarget = { owner: repo.owner, name: repo.name, ref: view?.commitSha ?? repo.defaultBranch };
  const lineUrl = (path: string, line: number) => githubLineUrl(target, path, line, line);
  const nameOf = (id: string) => {
    const fn = functions.find((f) => f.id === id);
    return fn ? shortName(fn) : id;
  };

  return (
    <div className="tab-page">
      <div className="top-line">
        <p>
          Built from the code in commit <code>{view?.commitSha.slice(0, 7)}</code> · Python, JavaScript and TypeScript
        </p>
      </div>

      {/* 1. Headline numbers */}
      {stats && (
        <div className="stat-row">
          <Stat label="Functions" value={functions.length} />
          <Stat label="Calls matched" value={stats.certain} />
          <Stat label="Possible calls" value={stats.possible} />
        </div>
      )}

      {/* 2 + 3. Pick a function and the depth */}
      <section className="panel calls-picker" aria-label="Choose a function">
        <div className="calls-picker-row">
          <label htmlFor="call-search">Function</label>
          <input
            id="call-search"
            type="search"
            list="call-functions"
            placeholder={view ? `${pickerLabel(view.center)} (type to search)` : "Type a function name"}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              const id = byLabel.get(e.target.value);
              if (id) go(id);
            }}
            autoComplete="off"
            spellCheck={false}
          />
          <datalist id="call-functions">
            {functions.map((f) => (
              <option key={f.id} value={pickerLabel(f)} />
            ))}
          </datalist>
          <div className="segmented" role="radiogroup" aria-label="How far to look">
            {([1, 2] as const).map((d) => (
              <button key={d} role="radio" aria-checked={depth === d} className="segment" onClick={() => setDepth(d)}>
                {d === 1 ? "Direct" : "2 steps"}
              </button>
            ))}
          </div>
          <button className="secondary" onClick={back} disabled={trail.length === 0} title={trail.length ? `Back to ${nameOf(trail[trail.length - 1])}` : undefined}>
            <ArrowLeft size={14} aria-hidden="true" />
            Back
          </button>
        </div>
        {mostCalled.length > 0 && (
          <div className="calls-quick">
            <span className="muted small">Most called:</span>
            {mostCalled.map((f) => (
              <button key={f.id} className="secondary suggestion" onClick={() => go(f.id)} aria-pressed={f.id === focusId}>
                {shortName(f)} <span className="muted small">({f.callers})</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {error && (
        <p className="error" role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}

      {view && (
        <>
          {/* 4. The diagram */}
          <section className="panel arch-card" aria-labelledby="calls-diagram">
            <div className="section-head">
              <h2 id="calls-diagram">
                {shortName(view.center)}{" "}
                <a className="muted small" href={lineUrl(view.center.file, view.center.line)} target="_blank" rel="noopener noreferrer">
                  {view.center.file}:L{view.center.line}
                </a>
              </h2>
              <p>Left: the functions that call it. Right: the functions it calls. Arrows point from the caller to the function it calls.</p>
            </div>
            {view.callers.length === 0 && view.callees.length === 0 ? (
              <p className="muted">Nothing in the repo calls this function, and it doesn't call any other function in the repo.</p>
            ) : (
              <MermaidDiagram code={view.mermaid} label={`Call diagram for ${shortName(view.center)}: ${view.callers.length} callers and ${view.callees.length} called`} zoomable />
            )}
            <ul className="arch-legend" aria-label="Legend">
              <li>
                <span className="swatch center-swatch" /> this function
              </li>
              <li>
                <span className="legend-arrow">→</span> certain call
              </li>
              <li>
                <span className="legend-arrow">⇢</span> possible call (matched by method name)
              </li>
              <li>
                <span className="swatch test-swatch" /> test code
              </li>
              <li>
                <span className="swatch heat2" /> hotspot file (from Hotspots)
              </li>
            </ul>
          </section>

          {/* 5. The same as lists, with the navigation buttons */}
          <div className="calls-lists">
            <CallList title="Called by" empty="Nothing in the repo calls it." items={view.callers} more={view.more.callers} nameOf={nameOf} lineUrl={lineUrl} onGo={go} callers />
            <CallList title="Calls" empty="It doesn't call any other function in the repo." items={view.callees} more={view.more.callees} nameOf={nameOf} lineUrl={lineUrl} onGo={go} />
          </div>
        </>
      )}

      {stats && (
        <p className="muted small">
          {stats.dropped} calls go to libraries or the language itself (e.g. console.log, list.append), so they aren't shown.
          "Possible" calls are method calls where the code doesn't say which class the object is.
        </p>
      )}
    </div>
  );
}

/** One list under the diagram: callers or callees, each with a link to the call and a "Show its calls" button. */
function CallList(props: {
  title: string;
  empty: string;
  items: FocusItem[];
  more: number;
  callers?: boolean;
  nameOf: (id: string) => string;
  lineUrl: (path: string, line: number) => string;
  onGo: (id: string) => void;
}) {
  const { title, empty, items, more, callers, nameOf, lineUrl, onGo } = props;
  return (
    <section className="card calls-list" aria-label={title}>
      <h3>
        {title} <span className="muted small">({items.length}{more ? ` + ${more} more` : ""})</span>
      </h3>
      {items.length === 0 ? (
        <p className="muted small">{empty}</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={`${item.parent}>${item.fn.id}`} className={item.level === 2 ? "level-2" : undefined}>
              <div className="calls-item-main">
                <strong>{item.fn.kind === "top-level" ? `${item.fn.file.split("/").pop()} (top level)` : `${item.fn.qualified}()`}</strong>
                {!item.certain && <span className="warn-pill small-pill">possible</span>}
                {item.fn.isTest && <span className="muted-pill small-pill">test</span>}
                <div className="muted small">
                  {item.level === 2 && <>{callers ? "calls" : "called by"} {nameOf(item.parent)} · </>}
                  call at{" "}
                  <a href={lineUrl(item.site, item.line)} target="_blank" rel="noopener noreferrer">
                    {item.site}:L{item.line}
                  </a>
                </div>
              </div>
              <button className="secondary calls-go" onClick={() => onGo(item.fn.id)} title={`Centre the diagram on ${nameOf(item.fn.id)}`}>
                <Crosshair size={14} aria-hidden="true" />
                Show its calls
              </button>
            </li>
          ))}
        </ul>
      )}
      {more > 0 && <p className="muted small">{more} more not shown, to keep the diagram readable.</p>}
    </section>
  );
}
