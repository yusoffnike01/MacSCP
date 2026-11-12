import { useEffect, useRef, useState } from "react";
import type {
  DownloadProgress,
  DownloadResult,
  DownloadScanProgress,
  DownloadSummary,
  DownloadTarget,
  SkippedItem,
} from "../types";
import { count, errorMessage, formatSize } from "../format";
import {
  ConfirmDialog,
  Modal,
  TransferProgress,
  TransferTimes,
  primaryButton,
  secondaryButton,
} from "./Dialogs";

type Stage =
  // The save panel (a file) or the folder chooser (a folder) is up. Also
  // while a file is being got ready, which is instant.
  | { kind: "choosing" }
  // A folder with the same name is already where this one is going.
  | { kind: "confirm"; target: DownloadTarget }
  // Listing everything inside the folder.
  | { kind: "scanning"; target: DownloadTarget; found: DownloadScanProgress | null }
  | {
      kind: "downloading";
      target: DownloadTarget;
      summary: DownloadSummary;
      progress: DownloadProgress | null;
      measuredAt: number | null; // when `progress` came in
      stopping: boolean;
      startedAt: number;
    }
  // Stays up until OK, so it's clear the download is done.
  | {
      kind: "complete";
      target: DownloadTarget;
      result: DownloadResult;
      startedAt: number;
      endedAt: number;
    }
  // Stopped, failed, or couldn't start. `savedAs`: where some files may have
  // been saved.
  | { kind: "finished"; title: string; message: string; savedAs?: string };

const MAX_SKIPPED_SHOWN = 50;

// Downloads a file or a whole folder: asks where to save it, asks before
// adding to a folder that's already there, shows progress with a Stop
// button, and says when it's done.
export function DownloadDialog({
  sessionId,
  remotePath,
  onClose,
}: {
  sessionId: string;
  remotePath: string;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ kind: "choosing" });
  // A download being got ready, listed or fetched, stopped if the dialog goes
  // away first.
  const downloadId = useRef<string | null>(null);

  // Lists what's in a folder (a file has nothing to list), then fetches it.
  async function scanAndStart(target: DownloadTarget) {
    if (target.isDirectory) setStage({ kind: "scanning", target, found: null });
    const stopListening = window.api.sftp.onDownloadScanProgress(target.id, (found) => {
      setStage((s) => (s.kind === "scanning" ? { ...s, found } : s));
    });
    let summary: DownloadSummary | null;
    try {
      summary = await window.api.sftp.scanDownload(target.id);
    } catch (err) {
      downloadId.current = null;
      setStage({ kind: "finished", title: "Can't download", message: errorMessage(err) });
      return;
    } finally {
      stopListening();
    }
    if (summary) await start(target, summary); // null: stopped, as the dialog closed
  }

  async function start(target: DownloadTarget, summary: DownloadSummary) {
    const startedAt = Date.now();
    setStage({
      kind: "downloading",
      target,
      summary,
      progress: null,
      measuredAt: null,
      stopping: false,
      startedAt,
    });
    const stopListening = window.api.sftp.onDownloadProgress(target.id, (progress) => {
      const measuredAt = Date.now();
      setStage((s) => (s.kind === "downloading" ? { ...s, progress, measuredAt } : s));
    });
    // What's on this Mac after stopping or failing partway.
    const outcome = (filesDone: number, when: string) =>
      target.isDirectory
        ? `Downloaded ${filesDone.toLocaleString()} of ${count(summary.filesTotal, "file")} ${when}.`
        : "Nothing was saved.";
    const savedAs = target.isDirectory ? target.savedAs : undefined;
    try {
      const result = await window.api.sftp.startDownload(target.id);
      downloadId.current = null;
      if (result.stopped) {
        const rest = target.isDirectory ? " The rest weren't downloaded." : "";
        setStage({
          kind: "finished",
          title: "Download stopped",
          message: `${outcome(result.filesDone, "before stopping")}${rest}`,
          savedAs,
        });
      } else {
        setStage({ kind: "complete", target, result, startedAt, endedAt: Date.now() });
      }
    } catch (err) {
      downloadId.current = null;
      setStage((s) => {
        const filesDone = s.kind === "downloading" ? (s.progress?.filesDone ?? 0) : 0;
        return {
          kind: "finished",
          title: "Download failed",
          message: `${errorMessage(err)}\n\n${outcome(filesDone, "before this")}`,
          savedAs,
        };
      });
    } finally {
      stopListening();
    }
  }

  useEffect(() => {
    let closed = false;
    (async () => {
      let target: DownloadTarget | null;
      try {
        target = await window.api.sftp.prepareDownload(sessionId, remotePath);
      } catch (err) {
        if (!closed) {
          setStage({ kind: "finished", title: "Can't download", message: errorMessage(err) });
        }
        return;
      }
      if (closed) {
        if (target) void window.api.sftp.cancelDownload(target.id);
        return;
      }
      if (!target) {
        onClose(); // cancelled in the panel
        return;
      }
      downloadId.current = target.id;
      if (target.exists) setStage({ kind: "confirm", target });
      else void scanAndStart(target);
    })();
    return () => {
      closed = true;
      if (downloadId.current) void window.api.sftp.cancelDownload(downloadId.current);
    };
    // Once per dialog: each download opens a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape cancels while listing and closes the result. It doesn't stop a
  // running download: that takes the Stop button.
  useEffect(() => {
    if (stage.kind !== "scanning" && stage.kind !== "complete" && stage.kind !== "finished") {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function stop() {
    if (downloadId.current) void window.api.sftp.cancelDownload(downloadId.current);
    setStage((s) => (s.kind === "downloading" ? { ...s, stopping: true } : s));
  }

  if (stage.kind === "choosing") return null;

  if (stage.kind === "finished") {
    return (
      <Modal title={stage.title}>
        {stage.savedAs && <Destination savedAs={stage.savedAs} />}
        <p className="whitespace-pre-wrap break-words text-sm text-text-secondary">
          {stage.message}
        </p>
        <div className="mt-6 flex justify-end">
          <button autoFocus onClick={onClose} className={primaryButton}>
            OK
          </button>
        </div>
      </Modal>
    );
  }

  if (stage.kind === "confirm") {
    const { target } = stage;
    return (
      <ConfirmDialog
        title={`“${target.name}” already exists`}
        confirmLabel="Replace"
        busyLabel="Replace"
        danger
        onCancel={onClose}
        onConfirm={async () => {
          void scanAndStart(target);
        }}
      >
        <p>
          There's already a folder with this name there. The downloaded files will be added to
          it, replacing any with the same names. Other files in it are kept.
        </p>
        <p className="break-all font-mono text-xs text-text-muted">{target.savedAs}</p>
      </ConfirmDialog>
    );
  }

  const { target } = stage;
  const title = `Downloading “${target.name}”`;
  const destination = <Destination savedAs={target.savedAs} />;

  if (stage.kind === "scanning") {
    const { found } = stage;
    return (
      <Modal title={title}>
        {destination}
        <p className="text-xs text-text-secondary">
          Looking through the folder…
          {found && found.filesFound > 0 && (
            <span className="tabular-nums">
              {" "}
              {count(found.filesFound, "file")} ({formatSize(found.bytesFound)}) so far
            </span>
          )}
        </p>
        <div className="mt-6 flex justify-end">
          <button onClick={onClose} className={secondaryButton}>
            Cancel
          </button>
        </div>
      </Modal>
    );
  }

  if (stage.kind === "complete") {
    const { result } = stage;
    return (
      <Modal title="Download complete">
        {destination}
        <TransferProgress fraction={1} complete>
          {target.isDirectory && `${count(result.filesDone, "file")} · `}
          {formatSize(result.bytesDone)}
        </TransferProgress>
        <TransferTimes
          startedAt={stage.startedAt}
          measuredAt={stage.endedAt}
          endedAt={stage.endedAt}
          bytesDone={result.bytesDone}
          bytesTotal={result.bytesDone}
        />
        {result.skipped.length > 0 && <SkippedList items={result.skipped} />}
        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={() => void window.api.sftp.showDownload(target.id)}
            className={secondaryButton}
          >
            Show in Finder
          </button>
          <button autoFocus onClick={onClose} className={primaryButton}>
            OK
          </button>
        </div>
      </Modal>
    );
  }

  const { summary, progress, stopping } = stage;
  const filesDone = progress?.filesDone ?? 0;
  const filesTotal = progress?.filesTotal ?? summary.filesTotal;
  const bytesDone = progress?.bytesDone ?? 0;
  const bytesTotal = progress?.bytesTotal ?? summary.bytesTotal;
  const fraction =
    bytesTotal > 0 ? bytesDone / bytesTotal : filesTotal > 0 ? filesDone / filesTotal : 0;

  return (
    <Modal title={title}>
      {destination}
      <TransferProgress fraction={fraction}>
        {target.isDirectory && `${filesDone.toLocaleString()} of ${count(filesTotal, "file")} · `}
        {formatSize(bytesDone)} of {formatSize(bytesTotal)}
      </TransferProgress>
      {target.isDirectory && (
        <p className={`mt-1 h-4 truncate text-xs text-text-muted ${stopping ? "" : "font-mono"}`}>
          {stopping ? "Stopping…" : progress?.current}
        </p>
      )}
      <TransferTimes
        startedAt={stage.startedAt}
        measuredAt={stage.measuredAt}
        bytesDone={bytesDone}
        bytesTotal={bytesTotal}
      />
      <div className="mt-6 flex justify-end">
        <button onClick={stop} disabled={stopping} className={secondaryButton}>
          {stopping ? "Stopping…" : "Stop"}
        </button>
      </div>
    </Modal>
  );
}

function Destination({ savedAs }: { savedAs: string }) {
  return (
    <p className="-mt-2 mb-4 truncate font-mono text-xs text-text-muted" title={savedAs}>
      to {savedAs}
    </p>
  );
}

// What wasn't downloaded from inside a folder, and why.
function SkippedList({ items }: { items: SkippedItem[] }) {
  const shown = items.slice(0, MAX_SKIPPED_SHOWN);
  const more = items.length - shown.length;
  return (
    <div className="mt-4 space-y-2 text-sm text-text-secondary">
      <p>
        {items.length === 1
          ? "This wasn't downloaded:"
          : `These ${items.length.toLocaleString()} weren't downloaded:`}
      </p>
      <ul className="max-h-40 space-y-1.5 overflow-y-auto rounded-lg bg-surface-2 px-3 py-2 text-xs">
        {shown.map((item, index) => (
          <li key={index} className="min-w-0">
            <p className="truncate font-mono text-text-secondary" title={item.path}>
              {item.path}
            </p>
            <p className="text-[11px] text-text-muted">{item.reason}</p>
          </li>
        ))}
        {more > 0 && <li className="text-text-muted">…and {more.toLocaleString()} more</li>}
      </ul>
    </div>
  );
}
