import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { errorMessage } from "../format";

function useEscape(onCancel: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);
}

function Modal({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-[420px] rounded-2xl border border-border-subtle bg-surface-1 p-6 shadow-2xl"
      >
        <h2 className="mb-4 break-words text-base font-semibold text-text-primary">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

const secondaryButton =
  "rounded-lg px-4 py-2 text-sm text-text-secondary hover:text-text-primary";
const primaryButton =
  "rounded-lg bg-accent px-4 py-2 text-sm font-medium text-surface-0 transition-opacity hover:opacity-90 disabled:opacity-50";
const dangerButton =
  "rounded-lg bg-danger px-4 py-2 text-sm font-medium text-surface-0 transition-opacity hover:opacity-90 disabled:opacity-50";

// Asks for a name (rename, new folder). `validate` returns a problem to show,
// or null; `onSubmit` errors are shown in the dialog, which stays open.
export function PromptDialog({
  title,
  label,
  initialValue = "",
  selectStem = false,
  confirmLabel,
  validate,
  onSubmit,
  onCancel,
}: {
  title: string;
  label: string;
  initialValue?: string;
  // Preselect the name without its extension, like Finder's rename.
  selectStem?: boolean;
  confirmLabel: string;
  validate: (value: string) => string | null;
  onSubmit: (value: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEscape(onCancel);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const dot = initialValue.lastIndexOf(".");
    input.setSelectionRange(0, selectStem && dot > 0 ? dot : initialValue.length);
  }, [initialValue, selectStem]);

  const name = value.trim();
  const problem = validate(name);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  // Don't nag about an empty field; just keep the button disabled.
  const shown = error ?? (name ? problem : null);

  return (
    <Modal title={title}>
      <form onSubmit={handleSubmit}>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-text-secondary">
            {label}
          </span>
          <input
            ref={inputRef}
            value={value}
            spellCheck={false}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
          />
        </label>
        {shown && <p className="mt-2 text-xs text-danger">{shown}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={secondaryButton}>
            Cancel
          </button>
          <button type="submit" disabled={!!problem || busy} className={primaryButton}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Yes/no confirmation. Cancel has focus, so Enter never confirms by accident.
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busyLabel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEscape(onCancel);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={title}>
      <div className="space-y-3 text-sm text-text-secondary">{children}</div>
      {error && (
        <p className="mt-3 whitespace-pre-wrap break-words text-xs text-danger">
          {error}
        </p>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <button ref={cancelRef} onClick={onCancel} className={secondaryButton}>
          Cancel
        </button>
        <button
          onClick={handleConfirm}
          disabled={busy}
          className={danger ? dangerButton : primaryButton}
        >
          {busy ? busyLabel : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
