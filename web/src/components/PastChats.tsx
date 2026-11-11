// Past chats: a small panel in the chat header listing the repo's saved chats.
//  - Click a title to open that chat.
//  - Tick chats, then "Delete selected" to delete them (one confirmation for all).
//  - "Select all" + "Delete selected" deletes every chat. Why two clicks: deleting everything should be deliberate.
// Closes with Esc or a click outside. Deleting asks first, in the app's own dialog (ConfirmDialog.tsx).
import { ChevronDown, History, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChatSummary } from "../api";
import { useConfirm } from "./ConfirmDialog";

interface Props {
  chats: ChatSummary[];
  currentId: string | null; // the chat on screen, marked in the list
  disabled: boolean; // e.g. while an answer is streaming
  onOpen: (id: string) => void;
  onDelete: (ids: string[]) => Promise<void>;
}

/** A chat's date: "14:05" if it's from today, otherwise "11 Nov". */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export default function PastChats({ chats, currentId, disabled, onOpen, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [confirm, confirmDialog, confirming] = useConfirm(); // the app's own "Are you sure?" dialog
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Forget ticks for chats that no longer exist (deleted, or the repo changed).
  useEffect(() => {
    setSelected((prev) => new Set([...prev].filter((id) => chats.some((c) => c.id === id))));
  }, [chats]);

  // Close with Esc (focus goes back to the button) or a click outside the panel.
  useEffect(() => {
    if (!open || confirming) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open, confirming]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allSelected = chats.length > 0 && selected.size === chats.length;

  async function deleteSelected() {
    const n = selected.size;
    const what = allSelected ? `all ${n} chats` : n === 1 ? "1 chat" : `${n} chats`;
    if (!n) return;
    const ok = await confirm({
      title: allSelected ? "Delete all chats?" : n === 1 ? "Delete 1 chat?" : `Delete ${n} chats?`,
      message: `${what[0].toUpperCase()}${what.slice(1)} will be deleted. This can't be undone.`,
      confirmLabel: allSelected ? "Delete all" : "Delete",
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await onDelete([...selected]);
      setSelected(new Set());
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="past-chats" ref={rootRef}>
      {confirmDialog}
      <button
        ref={toggleRef}
        className="secondary"
        onClick={() => setOpen(!open)}
        disabled={disabled || chats.length === 0}
        aria-expanded={open}
        aria-controls="past-chats-panel"
      >
        <History size={14} aria-hidden="true" />
        Past chats ({chats.length})
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {open && (
        <div id="past-chats-panel" className="past-chats-panel" role="dialog" aria-label="Past chats">
          <ul>
            {chats.map((c) => (
              <li key={c.id} className={c.id === currentId ? "current" : undefined}>
                <input
                  type="checkbox"
                  checked={selected.has(c.id)}
                  onChange={() => toggle(c.id)}
                  aria-label={`Select "${c.title}"`}
                  disabled={deleting}
                />
                <button
                  className="past-chat-title"
                  onClick={() => {
                    onOpen(c.id);
                    setOpen(false);
                  }}
                  aria-current={c.id === currentId ? "true" : undefined}
                  title={c.title}
                >
                  {c.title}
                </button>
                <span className="past-chat-date">{c.id === currentId ? "open" : shortDate(c.updatedAt)}</span>
              </li>
            ))}
          </ul>
          <div className="past-chats-footer">
            <button className="ghost" onClick={() => setSelected(allSelected ? new Set() : new Set(chats.map((c) => c.id)))} disabled={deleting}>
              {allSelected ? "Clear selection" : "Select all"}
            </button>
            <button className="secondary danger" onClick={deleteSelected} disabled={deleting || selected.size === 0}>
              <Trash2 size={14} aria-hidden="true" />
              {deleting ? "Deleting…" : `Delete selected (${selected.size})`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
