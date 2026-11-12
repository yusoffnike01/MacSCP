import { useEffect, useRef, useState } from "react";
import type { UploadProgress, UploadSummary } from "../types";
import { count, errorMessage, formatSize } from "../format";
import {
  ConfirmDialog,
  Modal,
  TransferProgress,
  TransferTimes,
  primaryButton,
  secondaryButton,
} from "./Dialogs";

// What to upload: files and folders dropped from Finder, or ones the user
// chooses in the open panel first (Upload file / Upload folder).
export type UploadSource =
  | { kind: "drop"; files: File[] }
  | { kind: "pick"; what: "files" | "folders" };

type Stage =
  | { kind: "choosing" } // the open panel is up
  | { kind: "preparing" }
  | { kind: "confirm"; summary: UploadSummary }
  | {
      kind: "uploading";
      summary: UploadSummary;
      progress: UploadProgress | null;
      measuredAt: number | null; // when `progress` came in
      stopping: boolean;
      startedAt: number;
    }
  // Stays up until OK, so it's clear the upload is done.
  | {
      kind: "complete";
      summary: UploadSummary;
      filesDone: number;
      startedAt: number;
      endedAt: number;
    }
  // Stopped, failed, or couldn't start. `changed`: files may have been
  // uploaded, so the listing needs a refresh.
  | {
      kind: "finished";
      title: string;
      message: string;
      changed: boolean;
    };

const MAX_SKIPPED_SHOWN = 50;

// “a”, “b” and “c” / “a”, “b”, “c” and 2 more.
function listNames(names: string[], max = 3): string {
  const quoted = names.slice(0, max).map((name) => `“${name}”`);
  const rest = names.length - quoted.length;
  if (rest > 0) return `${quoted.join(", ")} and ${rest} more`;
  return quoted.length > 1
    ? `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`
    : quoted.join("");
}

// Uploads files and folders into `remoteDir`, dropped from Finder or chosen
// in the open panel: checks what's already on the server, asks before
// replacing anything, shows progress with a Stop button, and says when it's
// done.
export function UploadDialog({
  sessionId,
  source,
  remoteDir,
  onCancel,
  onDone,
}: {
  sessionId: string;
  source: UploadSource;
  remoteDir: string;
  // Nothing was uploaded.
  onCancel: () => void;
  // Files on the server may have changed; `select` is the item to highlight.
  onDone: (select: string | null) => void;
}) {
  const [stage, setStage] = useState<Stage>(
    source.kind === "pick" ? { kind: "choosing" } : { kind: "preparing" }
  );
  // Of the dropped or chosen items (none yet while choosing).
  const [names, setNames] = useState<string[]>(() =>
    source.kind === "drop" ? source.files.map((file) => file.name) : []
  );
  // A prepared or running upload, stopped if the dialog goes away first.
  const uploadId = useRef<string | null>(null);
  const select = names[0] ?? null;
  const title =
    names.length === 1
      ? `Uploading “${names[0]}”`
      : `Uploading ${count(names.length, "item")}`;

  async function start(summary: UploadSummary) {
    const startedAt = Date.now();
    setStage({
      kind: "uploading",
      summary,
      progress: null,
      measuredAt: null,
      stopping: false,
      startedAt,
    });
    const stopListening = window.api.sftp.onUploadProgress(summary.id, (progress) => {
      const measuredAt = Date.now();
      setStage((s) => (s.kind === "uploading" ? { ...s, progress, measuredAt } : s));
    });
    try {
      const result = await window.api.sftp.startUpload(summary.id);
      uploadId.current = null;
      if (result.stopped) {
        setStage({
          kind: "finished",
          title: "Upload stopped",
          message: `Uploaded ${result.filesDone.toLocaleString()} of ${count(
            summary.filesTotal,
            "file"
          )} before stopping. The rest weren't uploaded.`,
          changed: true,
        });
      } else {
        setStage({
          kind: "complete",
          summary,
          filesDone: result.filesDone,
          startedAt,
          endedAt: Date.now(),
        });
      }
    } catch (err) {
      uploadId.current = null;
      setStage((s) => {
        const done = s.kind === "uploading" ? (s.progress?.filesDone ?? 0) : 0;
        return {
          kind: "finished",
          title: "Upload failed",
          message: `${errorMessage(err)}\n\nUploaded ${done.toLocaleString()} of ${count(
            summary.filesTotal,
            "file"
          )} before this.`,
          changed: true,
        };
      });
    } finally {
      stopListening();
    }
  }

  useEffect(() => {
    let closed = false;
    (async () => {
      let summary: UploadSummary;
      try {
        if (source.kind === "drop") {
          summary = await window.api.sftp.prepareUpload(sessionId, source.files, remoteDir);
        } else {
          const pick = await window.api.sftp.pickUpload(source.what, remoteDir);
          if (closed) return;
          if (!pick) {
            onCancel(); // open panel cancelled
            return;
          }
          setNames(pick.names);
          setStage({ kind: "preparing" });
          summary = await window.api.sftp.preparePickedUpload(sessionId, pick.id, remoteDir);
        }
      } catch (err) {
        if (!closed) {
          setStage({
            kind: "finished",
            title: "Can't upload",
            message: errorMessage(err),
            changed: false,
          });
        }
        return;
      }
      if (closed) {
        void window.api.sftp.cancelUpload(summary.id);
        return;
      }
      uploadId.current = summary.id;
      if (summary.items.some((item) => item.exists)) {
        setStage({ kind: "confirm", summary });
      } else {
        void start(summary);
      }
    })();
    return () => {
      closed = true;
      if (uploadId.current) void window.api.sftp.cancelUpload(uploadId.current);
    };
    // Once per dialog: each upload opens a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function close() {
    if (stage.kind === "complete" || (stage.kind === "finished" && stage.changed)) {
      onDone(select);
    } else {
      onCancel();
    }
  }

  // Escape cancels while checking and closes the result. It doesn't stop a
  // running upload: that takes the Stop button.
  useEffect(() => {
    if (stage.kind === "confirm" || stage.kind === "uploading") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function stop() {
    if (uploadId.current) void window.api.sftp.cancelUpload(uploadId.current);
    setStage((s) => (s.kind === "uploading" ? { ...s, stopping: true } : s));
  }

  if (stage.kind === "choosing") return null;

  if (stage.kind === "confirm") {
    const { summary } = stage;
    return (
      <ReplaceConfirm
        summary={summary}
        remoteDir={remoteDir}
        onCancel={onCancel}
        onConfirm={async () => {
          void start(summary);
        }}
      />
    );
  }

  const okButton = (
    <div className="mt-6 flex justify-end">
      <button autoFocus onClick={close} className={primaryButton}>
        OK
      </button>
    </div>
  );

  if (stage.kind === "finished") {
    return (
      <Modal title={stage.title}>
        <p className="whitespace-pre-wrap break-words text-sm text-text-secondary">
          {stage.message}
        </p>
        {okButton}
      </Modal>
    );
  }

  const destination = (
    <p className="-mt-2 mb-4 truncate font-mono text-xs text-text-muted" title={remoteDir}>
      to {remoteDir}
    </p>
  );

  if (stage.kind === "preparing") {
    return (
      <Modal title={title}>
        {destination}
        <p className="text-xs text-text-secondary">Checking files…</p>
        <div className="mt-6 flex justify-end">
          <button onClick={onCancel} className={secondaryButton}>
            Cancel
          </button>
        </div>
      </Modal>
    );
  }

  if (stage.kind === "complete") {
    const { summary, filesDone } = stage;
    const { skipped } = summary;
    const shown =
      skipped.length > MAX_SKIPPED_SHOWN
        ? [...skipped.slice(0, MAX_SKIPPED_SHOWN), `…and ${skipped.length - MAX_SKIPPED_SHOWN} more`]
        : skipped;
    return (
      <Modal title="Upload complete">
        {destination}
        <TransferProgress fraction={1} complete>
          {count(filesDone, "file")} · {formatSize(summary.bytesTotal)}
        </TransferProgress>
        <TransferTimes
          startedAt={stage.startedAt}
          measuredAt={stage.endedAt}
          endedAt={stage.endedAt}
          bytesDone={summary.bytesTotal}
          bytesTotal={summary.bytesTotal}
        />
        {skipped.length > 0 && (
          <div className="mt-4 space-y-2 text-sm text-text-secondary">
            <p>
              {skipped.length === 1
                ? "This wasn't uploaded because it's a symbolic link or special file:"
                : `These ${skipped.length} weren't uploaded because they're symbolic links or special files:`}
            </p>
            <ul className="max-h-40 overflow-y-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs text-text-muted">
              {shown.map((item) => (
                <li key={item} className="truncate" title={item}>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}
        {okButton}
      </Modal>
    );
  }

  const { summary, progress, stopping } = stage;
  const filesDone = progress?.filesDone ?? 0;
  const bytesDone = progress?.bytesDone ?? 0;
  const fraction =
    summary.bytesTotal > 0
      ? bytesDone / summary.bytesTotal
      : summary.filesTotal > 0
        ? filesDone / summary.filesTotal
        : 0;

  return (
    <Modal title={title}>
      {destination}
      <TransferProgress fraction={fraction}>
        {filesDone.toLocaleString()} of {count(summary.filesTotal, "file")} ·{" "}
        {formatSize(bytesDone)} of {formatSize(summary.bytesTotal)}
      </TransferProgress>
      <p className={`mt-1 h-4 truncate text-xs text-text-muted ${stopping ? "" : "font-mono"}`}>
        {stopping ? "Stopping once the files being sent now are done…" : progress?.current}
      </p>
      <TransferTimes
        startedAt={stage.startedAt}
        measuredAt={stage.measuredAt}
        bytesDone={bytesDone}
        bytesTotal={summary.bytesTotal}
      />
      <div className="mt-6 flex justify-end">
        <button onClick={stop} disabled={stopping} className={secondaryButton}>
          {stopping ? "Stopping…" : "Stop"}
        </button>
      </div>
    </Modal>
  );
}

function ReplaceConfirm({
  summary,
  remoteDir,
  onCancel,
  onConfirm,
}: {
  summary: UploadSummary;
  remoteDir: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const existing = summary.items.filter((item) => item.exists);
  const [first] = existing;
  const single = existing.length === 1;
  let explanation: string;
  if (single && first.isDirectory) {
    explanation =
      "There's already a folder with this name on the server. Your files will be added to it, replacing any with the same names. Other files in it are kept.";
  } else if (single) {
    explanation = "There's already a file with this name on the server. It will be replaced.";
  } else {
    explanation = `${listNames(existing.map((item) => item.name))} are already on the server. Files with the same names will be replaced.`;
    if (existing.some((item) => item.isDirectory)) {
      explanation += " Folders are merged: other files already in them are kept.";
    }
  }

  return (
    <ConfirmDialog
      title={single ? `“${first.name}” already exists` : `${existing.length} items already exist`}
      confirmLabel="Replace"
      busyLabel="Replace"
      danger
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <p>{explanation}</p>
      <p className="break-all font-mono text-xs text-text-muted">
        {single ? `${remoteDir.replace(/\/+$/, "")}/${first.name}` : remoteDir}
      </p>
      <p className="text-xs text-text-muted">
        Uploading {count(summary.filesTotal, "file")} ({formatSize(summary.bytesTotal)}).
      </p>
    </ConfirmDialog>
  );
}
