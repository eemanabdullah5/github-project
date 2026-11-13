// Usage display: the token count with a styled details box.
// Hover shows it; click or tap pins it open (works on touch screens and with the keyboard). Esc or a click outside closes it.
import { useEffect, useId, useRef, useState } from "react";
import type { Usage } from "../api";
import { formatCost, formatTokens, totalTokens, usageSummary } from "../usage";

interface Props {
  usage: Usage;
  label?: string; // text before the count, e.g. "last index "
}

export default function UsageInfo({ usage, label = "" }: Props) {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false); // opened by a click: stays open when the mouse leaves
  const wrap = useRef<HTMLSpanElement>(null);
  const id = useId();

  // Close on a click outside or Esc.
  useEffect(() => {
    if (!open) return;
    const close = () => {
      pinned.current = false;
      setOpen(false);
    };
    const onPointer = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const unpinnedClose = () => !pinned.current && setOpen(false);
  const total = totalTokens(usage) || 1;
  const parts = [
    { key: "prompt", label: "Prompt", value: usage.inputTokens, note: "" },
    { key: "answer", label: "Answer", value: usage.outputTokens, note: "incl. thinking" },
    { key: "embed", label: "Embeddings", value: usage.embedTokens, note: "estimated" },
  ];

  return (
    <span className="usage-info" ref={wrap} onMouseEnter={() => setOpen(true)} onMouseLeave={unpinnedClose}>
      <button
        type="button"
        className="usage-trigger"
        aria-expanded={open}
        aria-controls={id}
        onFocus={() => setOpen(true)}
        onBlur={unpinnedClose}
        onClick={() => {
          pinned.current = !pinned.current || !open;
          setOpen(pinned.current);
        }}
      >
        {label}
        {usageSummary(usage)}
      </button>
      {open && (
        <span id={id} role="tooltip" className="usage-pop">
          <span className="usage-pop-title">AI usage</span>
          {/* Share of each kind of token. Always full: it splits this total, it isn't a daily limit. */}
          <span className="usage-bar-caption">How these {formatTokens(totalTokens(usage))} tokens split</span>
          <span className="usage-bar" aria-hidden="true">
            {parts.map((p) => p.value > 0 && <span key={p.key} className={`usage-seg ${p.key}`} style={{ width: `${(p.value / total) * 100}%` }} />)}
          </span>
          <span className="usage-rows">
            {parts.map((p) => (
              <span key={p.key} className="usage-row">
                <span className={`usage-dot ${p.key}`} aria-hidden="true" />
                <span>
                  {p.label}
                  {p.note && <span className="usage-note-text"> · {p.note}</span>}
                </span>
                <span className="usage-num">{formatTokens(p.value)}</span>
              </span>
            ))}
            <span className="usage-row total">
              <span />
              <span>Total</span>
              <span className="usage-num">{formatTokens(totalTokens(usage))}</span>
            </span>
            <span className="usage-row">
              <span />
              <span>AI calls</span>
              <span className="usage-num">{usage.calls}</span>
            </span>
            <span className="usage-row">
              <span />
              <span>Cost</span>
              <span className="usage-num">{usage.cost === null ? "—" : formatCost(usage.cost)}</span>
            </span>
          </span>
          <span className="usage-foot">
            {usage.cost === null ? "Set PRICE_* in .env to see the cost." : "At the prices set in .env."}
            {usage.estimated && " ~ means prompt/answer counts were estimated from text length."}
          </span>
        </span>
      )}
    </span>
  );
}
