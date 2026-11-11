// The app's own "Are you sure?" dialog, used instead of the browser's window.confirm().
// Why: the browser's box always says "127.0.0.1:5173 says" and can't be styled.
//
// Use it with the hook:
//   const [confirm, confirmDialog] = useConfirm();
//   if (await confirm({ title: "Delete chat?", message: "…", confirmLabel: "Delete" })) { … }
//   …and render {confirmDialog} somewhere in the component.
//
// For a question with two real answers plus Cancel, use useChoice() and pass altLabel:
//   const [choose, choiceDialog] = useChoice();
//   const answer = await choose({ …, confirmLabel: "Re-index", altLabel: "Use the existing index" });
//   // answer is "confirm", "alt" or "cancel" (Esc or the Cancel button)
// Built on the HTML <dialog> element, so Esc, focus and the dark backdrop work without extra code.
import { useEffect, useRef, useState, type ReactElement } from "react";

export interface ConfirmOptions {
  title: string; // e.g. "Delete this chat?"
  message: string; // one or two plain sentences
  confirmLabel: string; // the action, e.g. "Delete"
  altLabel?: string; // optional second answer, shown between Cancel and the confirm button
  danger?: boolean; // red confirm button, for things that can't be undone
}

export type ChoiceResult = "confirm" | "alt" | "cancel";

/** Returns a choose() that resolves to the button picked, and the dialog to render. */
export function useChoice(): [(options: ConfirmOptions) => Promise<ChoiceResult>, ReactElement | null, boolean] {
  const [request, setRequest] = useState<(ConfirmOptions & { resolve: (result: ChoiceResult) => void }) | null>(null);

  const choose = (options: ConfirmOptions) => new Promise<ChoiceResult>((resolve) => setRequest({ ...options, resolve }));

  const dialog = request && (
    <ConfirmDialog
      {...request}
      onClose={(result) => {
        request.resolve(result);
        setRequest(null);
      }}
    />
  );
  return [choose, dialog, request !== null];
}

/** Returns a confirm() that resolves true (confirmed) or false (cancelled), and the dialog to render. */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactElement | null, boolean] {
  const [choose, dialog, open] = useChoice();
  const confirm = async (options: ConfirmOptions) => (await choose(options)) === "confirm";
  return [confirm, dialog, open];
}

/** The dialog itself. Opens as soon as it's shown; Cancel has the focus, so Enter can't delete by accident. */
function ConfirmDialog({ title, message, confirmLabel, altLabel, danger, onClose }: ConfirmOptions & { onClose: (result: ChoiceResult) => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-message"
      onCancel={(e) => {
        e.preventDefault(); // Esc: close through onClose, so the caller hears "cancelled"
        onClose("cancel");
      }}
    >
      <h2 id="confirm-title">{title}</h2>
      <p id="confirm-message">{message}</p>
      <div className="confirm-actions">
        <button className="secondary" onClick={() => onClose("cancel")} autoFocus>
          Cancel
        </button>
        {altLabel && (
          <button className="secondary" onClick={() => onClose("alt")}>
            {altLabel}
          </button>
        )}
        <button className={danger ? "danger-solid" : undefined} onClick={() => onClose("confirm")}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
