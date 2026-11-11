// The app's own "Are you sure?" dialog, used instead of the browser's window.confirm().
// Why: the browser's box always says "127.0.0.1:5173 says" and can't be styled.
//
// Use it with the hook:
//   const [confirm, confirmDialog] = useConfirm();
//   if (await confirm({ title: "Delete chat?", message: "…", confirmLabel: "Delete" })) { … }
//   …and render {confirmDialog} somewhere in the component.
// Built on the HTML <dialog> element, so Esc, focus and the dark backdrop work without extra code.
import { useEffect, useRef, useState, type ReactElement } from "react";

export interface ConfirmOptions {
  title: string; // e.g. "Delete this chat?"
  message: string; // one or two plain sentences
  confirmLabel: string; // the action, e.g. "Delete"
  danger?: boolean; // red confirm button, for things that can't be undone
}

/** Returns a confirm() that resolves true (confirmed) or false (cancelled), and the dialog to render. */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactElement | null, boolean] {
  const [request, setRequest] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);

  const confirm = (options: ConfirmOptions) => new Promise<boolean>((resolve) => setRequest({ ...options, resolve }));

  const dialog = request && (
    <ConfirmDialog
      {...request}
      onClose={(ok) => {
        request.resolve(ok);
        setRequest(null);
      }}
    />
  );
  return [confirm, dialog, request !== null];
}

/** The dialog itself. Opens as soon as it's shown; Cancel has the focus, so Enter can't delete by accident. */
function ConfirmDialog({ title, message, confirmLabel, danger, onClose }: ConfirmOptions & { onClose: (ok: boolean) => void }) {
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
        onClose(false);
      }}
    >
      <h2 id="confirm-title">{title}</h2>
      <p id="confirm-message">{message}</p>
      <div className="confirm-actions">
        <button className="secondary" onClick={() => onClose(false)} autoFocus>
          Cancel
        </button>
        <button className={danger ? "danger-solid" : undefined} onClick={() => onClose(true)}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
