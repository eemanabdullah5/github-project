// The ⓘ button that shows or hides a short explanation, used on headings and headline numbers.
// A click (not hover), so it works on touch screens, with the keyboard and with screen readers.
import { Info } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

/** Open state, an id linking the button to its text, and the button itself. */
export function useInfo(label: string) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const button = (
    <button
      className="info-button"
      onClick={() => setOpen(!open)}
      aria-expanded={open}
      aria-controls={id}
      aria-label={`What is "${label}"?`}
      title={open ? "Hide explanation" : "What is this?"}
    >
      <Info size={14} aria-hidden="true" />
    </button>
  );
  return { open, id, button };
}

/** The explanation box under a heading or number. */
export function InfoText({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="info-text">
      {children}
    </p>
  );
}

/** A heading with an ⓘ button and its explanation underneath. `label` is needed when the title isn't plain text. */
export function InfoHeading(props: { title: ReactNode; label?: string; count?: number; help: ReactNode; level?: 2 | 3; id?: string }) {
  const { title, count, help, level = 3, id } = props;
  const info = useInfo(props.label ?? String(title));
  const Tag = level === 2 ? "h2" : "h3";
  return (
    <>
      <Tag id={id} className="help-heading">
        {title} {count !== undefined && <span className="muted small">({count})</span>}
        {info.button}
      </Tag>
      {info.open && <InfoText id={info.id}>{help}</InfoText>}
    </>
  );
}
