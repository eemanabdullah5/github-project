// Progress panel for indexing (PRD FR-4.2). Asks the server for the job every second and shows
// Downloading → Processing n/total → Embedding n/total → Summarizing folders n/total → Ready.
// The job runs on the server, so leaving this view doesn't stop it.
// On a re-index, it also says how many unchanged chunks were reused instead of embedded again.
import { Check } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { getIndexJob, type IndexJob } from "../api";
import UsageInfo from "./UsageInfo";

const STEPS: Array<{ key: IndexJob["step"]; label: string }> = [
  { key: "downloading", label: "Downloading" },
  { key: "processing", label: "Processing files" },
  { key: "embedding", label: "Embedding" },
  { key: "summarizing", label: "Summarizing folders" },
  { key: "ready", label: "Ready" },
];

interface Props {
  onReady: () => void;
  onFailed: (message: string) => void;
}

/** "1 min 12 s" since the job started, so a long step still looks alive. */
function elapsed(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
}

export default function IndexProgress({ onReady, onFailed }: Props) {
  const [job, setJob] = useState<IndexJob | null>(null);
  const [now, setNow] = useState(() => Date.now());
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
        setNow(Date.now());
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
  const hasCount = !!job && job.total > 0;
  const percent = hasCount ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
  const activeLabel = STEPS[currentIndex]?.label ?? "Indexing";

  return (
    <section className="panel" aria-label="Indexing progress">
      <div className="progress-head">
        <p>
          Indexing <strong>{job?.repoId ?? "…"}</strong>
        </p>
        {job && (
          <span className="muted small">
            Started {elapsed(job.startedAt, now)} ago · large repos can take several minutes
          </span>
        )}
      </div>
      <ol className="steps">
        {STEPS.map((step, i) => {
          const state = i < currentIndex ? "done" : i === currentIndex ? "active" : "todo";
          const showCount = state === "active" && hasCount;
          return (
            <Fragment key={step.key}>
              {i > 0 && <li className="step-sep" aria-hidden="true" />}
              <li className={`step ${state}`} aria-current={state === "active" ? "step" : undefined}>
                <span className="step-dot" aria-hidden="true">
                  {state === "done" && <Check size={12} strokeWidth={3} />}
                </span>
                <span>{step.label}</span>
                {showCount && (
                  <span className="step-count">
                    {job.done} / {job.total}
                  </span>
                )}
                {state === "done" && <span className="sr-only">, done</span>}
              </li>
            </Fragment>
          );
        })}
      </ol>
      {/* Re-index: unchanged chunks keep their saved vectors, so only the rest are embedded. */}
      {!!job?.reused && job.step !== "downloading" && job.step !== "processing" && job.step !== "failed" && (
        <p className="muted small reuse-note">
          {job.reused} unchanged {job.reused === 1 ? "chunk" : "chunks"} reused · {(job.embedded ?? job.total) === 0 ? "nothing new to embed" : `embedding only the ${job.embedded ?? job.total} new or changed`}
        </p>
      )}
      {/* Usage display: AI tokens used so far by this index. */}
      {!!job?.usage?.calls && (
        <p className="muted small">
          <UsageInfo usage={job.usage} label="AI usage so far: " />
        </p>
      )}
      <div className="progress-row">
        <div
          className="progress-track"
          role="progressbar"
          aria-label={`${activeLabel} progress`}
          aria-valuemin={0}
          aria-valuemax={hasCount ? job.total : undefined}
          aria-valuenow={hasCount ? job.done : undefined}
        >
          <div className={hasCount ? "progress-fill" : "progress-fill indeterminate"} style={hasCount ? { width: `${percent}%` } : undefined} />
        </div>
        <span className="progress-pct">{hasCount ? `${percent}%` : ""}</span>
      </div>
    </section>
  );
}
