// Draws a Mermaid diagram (text like "flowchart LR …") as a picture, with zoom buttons.
// Used by the Architecture tab and for ```mermaid blocks in the health report.
// Mermaid is a large library, so it's only loaded the first time a diagram is shown.
// securityLevel "strict" means labels are treated as plain text and links/scripts in them are blocked.
import { Minus, Plus, RotateCcw } from "lucide-react";
import { useEffect, useId, useState } from "react";

/** The app's current theme (App.tsx sets data-theme on <html>). */
function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** Follows the light/dark toggle, so the diagram is redrawn in the matching colours. */
function useTheme(): "light" | "dark" {
  const [theme, setTheme] = useState(currentTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

const ZOOM_STEP = 0.2;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.4;

interface Props {
  code: string; // the Mermaid text
  label: string; // what the diagram shows, for screen readers
  zoomable?: boolean; // show the zoom buttons (the Architecture tab); off for small diagrams in the report
}

export default function MermaidDiagram({ code, label, zoomable = false }: Props) {
  const theme = useTheme();
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: theme === "dark" ? "dark" : "neutral",
          fontFamily: "Inter, system-ui, sans-serif",
          flowchart: { htmlLabels: true, curve: "basis" },
        });
        const result = await mermaid.render(`${id}-${theme}`, code);
        if (!cancelled) {
          setSvg(result.svg);
          setError("");
        }
      } catch (err) {
        if (!cancelled) setError(`The diagram couldn't be drawn: ${(err as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, theme, id]);

  if (error) return <p className="error small">{error}</p>;
  if (!svg) return <p className="muted small">Drawing diagram…</p>;

  return (
    <div className="mermaid-wrap">
      {zoomable && (
        <div className="zoom-controls" role="group" aria-label="Zoom">
          <button className="secondary icon" onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP))} aria-label="Zoom out">
            <Minus size={14} aria-hidden="true" />
          </button>
          <span className="muted small">{Math.round(zoom * 100)}%</span>
          <button className="secondary icon" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP))} aria-label="Zoom in">
            <Plus size={14} aria-hidden="true" />
          </button>
          <button className="secondary icon" onClick={() => setZoom(1)} aria-label="Reset zoom">
            <RotateCcw size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="mermaid-scroll">
        {/* The SVG comes from Mermaid in strict mode, which cleans it before returning it. */}
        <div
          className="mermaid-diagram"
          role="img"
          aria-label={label}
          style={{ transform: `scale(${zoom})` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}
