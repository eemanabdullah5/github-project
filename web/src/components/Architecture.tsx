// Phase 4 — Architecture tab.
// Shows how the repo is put together, from the import graph (no AI):
//  1. headline numbers   2. module map (Mermaid diagram, hotspot colours, red arrows for cycles)
//  3. cycles: modules or files that depend on each other in a loop   4. table of modules
import { AlertCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { getArchitecture, type ArchitectureMap, type ArchLink, type Repo } from "../api";
import { githubLineUrl, type LinkTarget } from "../sourceLinks";
import { Stat } from "./Hotspots";
import MermaidDiagram from "./MermaidDiagram";

interface Props {
  repo: Repo;
}

/** True if all the folders sit inside one of them, e.g. "web/src", "web/src/views" and "web/src/components". */
function isNested(group: string[]): boolean {
  const parent = [...group].sort((a, b) => a.length - b.length)[0];
  return group.every((f) => f === parent || f.startsWith(`${parent}/`));
}

export default function Architecture({ repo }: Props) {
  const [map, setMap] = useState<ArchitectureMap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    getArchitecture(repo.owner, repo.name)
      .then(setMap)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [repo.owner, repo.name]);

  if (loading) {
    return (
      <div className="tab-page">
        <p className="muted" role="status">
          Building the architecture map…
        </p>
      </div>
    );
  }
  if (error || !map) {
    return (
      <div className="tab-page">
        <p className="error" role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{error || "The architecture map couldn't be loaded."}</span>
        </p>
      </div>
    );
  }
  if (map.modules.length === 0) {
    return (
      <div className="tab-page">
        <p className="muted">This repo has no Python, JavaScript or TypeScript files, so there's no map yet. Other languages come later.</p>
      </div>
    );
  }

  const target: LinkTarget = { owner: repo.owner, name: repo.name, ref: map.commitSha };
  const lineUrl = (path: string, line: number) => githubLineUrl(target, path, line, line);
  const linksBetween = (group: string[]) => map.links.filter((l) => l.inCycle && group.includes(l.from) && group.includes(l.to));
  const importCount = map.links.reduce((n, l) => n + l.count, 0);

  return (
    <div className="tab-page">
      <div className="top-line">
        <p>
          Built from the imports in commit <code>{map.commitSha.slice(0, 7)}</code> · files grouped by folder
          {map.coverage !== null && ` · ${Math.round(map.coverage * 100)}% of imports between files could be followed`}
        </p>
      </div>

      {/* 1. Headline numbers */}
      <div className="stat-row">
        <Stat label="Modules (folders)" value={map.modules.length} />
        <Stat label="Imports between modules" value={importCount} />
        <Stat label="Module cycles" value={map.cycles.length} warn={map.cycles.length ? "loops between folders" : undefined} />
        <Stat label="Circular file imports" value={map.fileCycles.length} warn={map.fileCycles.length ? "files importing each other" : undefined} />
      </div>

      {/* 2. The map */}
      <section className="panel arch-card" aria-labelledby="arch-map">
        <div className="section-head">
          <h2 id="arch-map">Module map</h2>
          <p>
            Each box is a folder of code. An arrow points from the folder that imports to the folder it uses; the number is how many
            imports it stands for.
          </p>
        </div>
        <MermaidDiagram code={map.mermaid} label={`Module map of ${map.repoId}: ${map.modules.length} modules and ${map.links.length} links`} zoomable />
        <ul className="arch-legend" aria-label="Legend">
          {map.hotspotsAnalysed ? (
            <>
              <li>
                <span className="swatch heat1" /> low hotspot score
              </li>
              <li>
                <span className="swatch heat2" /> medium hotspot score
              </li>
              <li>
                <span className="swatch heat3" /> high hotspot score (top hotspot in the folder, from Hotspots)
              </li>
            </>
          ) : (
            <li className="muted">Run Analyse history in the Hotspots tab to colour folders by hotspot score.</li>
          )}
          {map.cycles.length > 0 && (
            <li>
              <span className="swatch-line" /> part of a cycle
            </li>
          )}
        </ul>
      </section>

      {/* 3. Cycles */}
      {(map.cycles.length > 0 || map.fileCycles.length > 0) && (
        <section className="section" aria-labelledby="arch-cycles">
          <div className="section-head">
            <h2 id="arch-cycles">Cycles</h2>
            <p>
              Code that depends on itself in a loop is harder to change, test and split up. Loops between a folder and its own
              subfolder are common; loops between unrelated folders are more worrying.
            </p>
          </div>
          <div className="card arch-cycles">
            {map.cycles.map((group) => (
              <CycleGroup key={group.join()} group={group} links={linksBetween(group)} lineUrl={lineUrl} />
            ))}
            {map.fileCycles.map((group) => (
              <div key={group.join()} className="cycle">
                <p>
                  <strong>⚠ Circular import between files:</strong> <code>{group.join(" ⇄ ")}</code>
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 4. Modules table */}
      <section className="section" aria-labelledby="arch-modules">
        <div className="section-head">
          <h2 id="arch-modules">Modules</h2>
          <p>"Used by" counts the other folders that depend on this one: the higher it is, the more a change here can affect.</p>
        </div>
        <div className="card table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Folder</th>
                <th scope="col" className="num">Files</th>
                <th scope="col" className="num">Uses</th>
                <th scope="col" className="num">Used by</th>
                <th scope="col">Top hotspot (score)</th>
              </tr>
            </thead>
            <tbody>
              {[...map.modules]
                .sort((a, b) => b.usedBy - a.usedBy || b.files.length - a.files.length)
                .map((m) => (
                  <tr key={m.id}>
                    <td>
                      <code>{m.name}</code>
                      {m.inCycle && <span className="warn-pill small-pill">cycle</span>}
                    </td>
                    <td className="num">{m.files.length}</td>
                    <td className="num">{m.uses}</td>
                    <td className="num">{m.usedBy}</td>
                    <td>
                      {m.hotspot ? (
                        <>
                          <a href={lineUrl(m.hotspot.file, 1).replace(/#L1$/, "")} target="_blank" rel="noopener noreferrer">
                            {m.hotspot.file.split("/").pop()}
                          </a>{" "}
                          <strong>{m.hotspot.score}</strong>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/** One loop between folders, with the imports that create it (each a link to that line on GitHub). */
function CycleGroup({ group, links, lineUrl }: { group: string[]; links: ArchLink[]; lineUrl: (path: string, line: number) => string }) {
  const nested = isNested(group);
  return (
    <div className="cycle">
      <p>
        <strong>⚠ {group.join(" ⇄ ")}</strong>
        {nested && <span className="muted small"> (folders inside one parent folder)</span>}
      </p>
      <ul>
        {links.map((l) => (
          <li key={`${l.from}-${l.to}`}>
            <code>{l.from}</code> → <code>{l.to}</code> ({l.count} import{l.count === 1 ? "" : "s"}), e.g.{" "}
            {l.examples.map((e, i) => (
              <span key={`${e.from}:${e.line}`}>
                {i > 0 && ", "}
                <a href={lineUrl(e.from, e.line)} target="_blank" rel="noopener noreferrer">
                  {e.from.split("/").pop()}:L{e.line}
                </a>
              </span>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
