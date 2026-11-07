// Progress panel for indexing (PRD FR-4.2). Asks the server for the job every second and shows
// Downloading → Processing n/total → Embedding n/total → Ready.
// The job runs on the server, so leaving this view doesn't stop it.
import { useEffect, useRef, useState } from "react";
import { getIndexJob, type IndexJob } from "../api";

const STEPS: Array<{ key: IndexJob["step"]; label: string }> = [
  { key: "downloading", label: "Downloading" },
  { key: "processing", label: "Processing files" },
  { key: "embedding", label: "Embedding" },
  { key: "ready", label: "Ready" },
];

interface Props {
  onReady: () => void;
  onFailed: (message: string) => void;
}

export default function IndexProgress({ onReady, onFailed }: Props) {
  const [job, setJob] = useState<IndexJob | null>(null);
  // Keep the latest callbacks in a ref, so polling doesn't restart each time the parent re-renders.
  const callbacks = useRef({ onReady, onFailed });
  callbacks.current = { onReady, onFailed };

  // Poll the job every second until it is ready or failed.
  useEffect(() => {
    let stopped = false;
    async function poll() {
      try {
        const current = await getIndexJob();
        if (stopped) return;
        setJob(current);
        if (current?.step === "ready") return callbacks.current.onReady();
        if (current?.step === "failed") return callbacks.current.onFailed(current.error ?? "Indexing failed.");
      } catch (err) {
        if (!stopped) return callbacks.current.onFailed((err as Error).message);
      }
      if (!stopped) setTimeout(poll, 1000);
    }
    poll();
    return () => {
      stopped = true;
    };
  }, []);

  const currentIndex = STEPS.findIndex((s) => s.key === job?.step);

  return (
    <div className="panel">
      <strong>Indexing {job?.repoId ?? "…"}</strong>
      <ol className="steps">
        {STEPS.map((step, i) => {
          const state = i < currentIndex ? "done" : i === currentIndex ? "active" : "todo";
          const showCount = state === "active" && job && job.total > 0;
          return (
            <li key={step.key} className={`step ${state}`}>
              {state === "done" ? "✓ " : state === "active" ? "● " : "○ "}
              {step.label}
              {showCount && ` (${job.done} / ${job.total})`}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
