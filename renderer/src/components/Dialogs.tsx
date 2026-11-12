import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { errorMessage, formatDuration, formatSize } from "../format";

function useEscape(onCancel: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);
}

export function Modal({ title, children }: { title: string; children: ReactNode }) {
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

export const secondaryButton =
  "rounded-lg px-4 py-2 text-sm text-text-secondary hover:text-text-primary disabled:opacity-50";
export const primaryButton =
  "rounded-lg bg-accent px-4 py-2 text-sm font-medium text-surface-0 transition-opacity hover:opacity-90 disabled:opacity-50";
const dangerButton =
  "rounded-lg bg-danger px-4 py-2 text-sm font-medium text-surface-0 transition-opacity hover:opacity-90 disabled:opacity-50";

// Progress bar and percentage for uploads and downloads. It reaches 100% (and
// turns green) only once `complete`, so a transfer that's nearly there never
// looks finished.
export function TransferProgress({
  fraction,
  complete = false,
  children,
}: {
  fraction: number; // 0 to 1
  complete?: boolean;
  children: ReactNode; // how much, e.g. "3 of 10 files · 1.2 MB of 4.0 MB"
}) {
  const percent = complete
    ? 100
    : Math.min(99, Math.floor(Math.max(0, Number.isFinite(fraction) ? fraction : 0) * 100));
  return (
    <div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-2 overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-150 ${
            complete ? "bg-success" : "bg-accent"
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-3 flex items-baseline justify-between gap-4">
        <p className="min-w-0 truncate text-xs text-text-secondary">{children}</p>
        <p
          className={`text-sm font-semibold tabular-nums ${
            complete ? "text-success" : "text-text-primary"
          }`}
        >
          {percent}%
        </p>
      </div>
    </div>
  );
}

// Time elapsed, time left and speed, like WinSCP's transfer window. Updates
// every second while running; once `endedAt` is set, shows how long the
// transfer took and its average speed instead.
export function TransferTimes({
  startedAt,
  measuredAt,
  endedAt,
  bytesDone,
  bytesTotal,
}: {
  startedAt: number;
  measuredAt: number | null; // when `bytesDone` was reported
  endedAt?: number;
  bytesDone: number;
  bytesTotal: number;
}) {
  const ended = endedAt !== undefined;
  // Keeps "Time elapsed" ticking, even while nothing is coming through.
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    if (ended) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ended]);

  const elapsed = Math.max(0, (endedAt ?? Math.max(now, measuredAt ?? 0)) - startedAt);
  // The average over the whole transfer, which is steadier than the speed of
  // the moment. While running, not before a second has passed: too little
  // to go on.
  const measured = (endedAt ?? measuredAt ?? startedAt) - startedAt;
  const speed =
    bytesDone > 0 && measured >= (ended ? 1 : 1000) ? (bytesDone / measured) * 1000 : null;
  const speedText = speed === null ? "—" : `${formatSize(speed)}/s`;
  const items = ended
    ? [
        ["Time taken", formatDuration(elapsed)],
        ["Average speed", speedText],
      ]
    : [
        ["Time elapsed", formatDuration(elapsed)],
        // Rounded up, so it never says 0:00 while there's still some to go.
        [
          "Time left",
          speed === null
            ? "—"
            : formatDuration((Math.max(0, bytesTotal - bytesDone) / speed) * 1000 + 999),
        ],
        ["Speed", speedText],
      ];

  return (
    <dl
      className={`mt-4 grid gap-3 rounded-lg bg-surface-2 px-3 py-2.5 ${
        ended ? "grid-cols-2" : "grid-cols-3"
      }`}
    >
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="text-[11px] text-text-muted">{label}</dt>
          <dd className="mt-0.5 text-sm font-medium tabular-nums text-text-primary">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

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
