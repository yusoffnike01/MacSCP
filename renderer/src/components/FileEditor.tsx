import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { TextFile } from "../types";
import { errorMessage } from "../format";

// Built-in text editor (like WinSCP's internal editor). `onClose(saved)`
// tells the file list whether it should refresh.
export function FileEditor({
  sessionId,
  path,
  onClose,
}: {
  sessionId: string;
  path: string;
  onClose: (saved: boolean) => void;
}) {
  // `file` is the last version read from or saved to the server.
  const [file, setFile] = useState<TextFile | null>(null);
  const [text, setText] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [savedOnce, setSavedOnce] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    window.api.sftp
      .readText(sessionId, path)
      .then((loaded) => {
        if (cancelled) return;
        setFile(loaded);
        setText(loaded.content);
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(0, 0);
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, path]);

  const name = path.split("/").pop() ?? path;
  const dirty = file !== null && text !== file.content;

  async function save(overwrite = false) {
    if (!file || saving) return;
    const content = text;
    setSaving(true);
    setSaveError(null);
    setConflict(false);
    try {
      const result = await window.api.sftp.writeText(sessionId, path, content, {
        eol: file.eol,
        bom: file.bom,
        ...(overwrite
          ? {}
          : { expectedModifiedAt: file.modifiedAt, expectedSize: file.size }),
      });
      setFile({ ...file, content, modifiedAt: result.modifiedAt, size: result.size });
      setSavedOnce(true);
    } catch (err) {
      const message = errorMessage(err);
      if (message.includes("CHANGED_ON_SERVER")) setConflict(true);
      else setSaveError(message);
    } finally {
      setSaving(false);
    }
  }

  function requestClose() {
    if (dirty) setConfirmDiscard(true);
    else onClose(savedOnce);
  }

  function handleKeyDown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (dirty) save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (conflict) setConflict(false);
      else if (confirmDiscard) setConfirmDiscard(false);
      else requestClose();
    }
  }

  function handleTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Tab inserts a tab character instead of moving focus. execCommand keeps
    // it on the native undo stack.
    if (event.key === "Tab" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      document.execCommand("insertText", false, "\t");
    }
  }

  function updateCursor(el: HTMLTextAreaElement) {
    let line = 1;
    let lineStart = 0;
    const end = el.selectionStart;
    for (let i = 0; i < end; i++) {
      if (el.value.charCodeAt(i) === 10) {
        line++;
        lineStart = i + 1;
      }
    }
    setCursor({ line, col: end - lineStart + 1 });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onKeyDown={handleKeyDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${name}`}
        className="flex h-[90vh] w-[90vw] max-w-6xl flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface-1 shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-border-subtle px-5 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-text-primary">
              {name}
              {dirty && (
                <span title="Unsaved changes" className="ml-1.5 text-accent">
                  ●
                </span>
              )}
            </h2>
            <p className="truncate font-mono text-xs text-text-muted">{path}</p>
          </div>
          <button
            onClick={requestClose}
            className="rounded-lg px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary"
          >
            Close
          </button>
          <button
            onClick={() => save()}
            disabled={!dirty || saving}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-surface-0 transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>

        {conflict && (
          <Banner tone="warning">
            <span className="flex-1">
              This file changed on the server after you opened it. Saving will
              replace those changes.
            </span>
            <BannerButton onClick={() => save(true)}>Overwrite</BannerButton>
            <BannerButton onClick={() => setConflict(false)}>Cancel</BannerButton>
          </Banner>
        )}
        {confirmDiscard && (
          <Banner tone="warning">
            <span className="flex-1">You have unsaved changes.</span>
            <BannerButton onClick={() => onClose(savedOnce)}>Discard changes</BannerButton>
            <BannerButton onClick={() => setConfirmDiscard(false)}>Keep editing</BannerButton>
          </Banner>
        )}
        {saveError && (
          <Banner tone="danger">
            <span className="flex-1 whitespace-pre-wrap break-words">
              Could not save: {saveError}
            </span>
          </Banner>
        )}

        <div className="min-h-0 flex-1 bg-surface-0">
          {loadError ? (
            <p className="p-5 text-sm text-danger">{loadError}</p>
          ) : !file ? (
            <p className="p-5 text-sm text-text-muted">Loading…</p>
          ) : (
            <textarea
              ref={textareaRef}
              value={text}
              aria-label={`Contents of ${name}`}
              spellCheck={false}
              wrap="off"
              onChange={(e) => setText(e.target.value)}
              onSelect={(e) => updateCursor(e.currentTarget)}
              onKeyDown={handleTextareaKeyDown}
              style={{ tabSize: 4 }}
              className="h-full w-full resize-none bg-transparent p-4 font-mono text-[13px] leading-5 text-text-primary outline-none"
            />
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-border-subtle px-5 py-2 text-xs text-text-muted">
          <span>
            Ln {cursor.line}, Col {cursor.col}
          </span>
          {file && <span>UTF-8{file.bom ? " with BOM" : ""}</span>}
          {file && <span>{file.eol === "crlf" ? "CRLF" : "LF"}</span>}
          <span className="ml-auto">⌘S save · Esc close</span>
        </div>
      </div>
    </div>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "warning" | "danger";
  children: React.ReactNode;
}) {
  return (
    <div
      role="alert"
      className={`flex items-center gap-2 border-b px-5 py-2 text-xs ${
        tone === "warning"
          ? "border-warning/30 bg-warning/10 text-warning"
          : "border-danger/30 bg-danger/10 text-danger"
      }`}
    >
      {children}
    </div>
  );
}

function BannerButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-md border border-current/40 px-2.5 py-1 font-medium hover:bg-white/5"
    >
      {children}
    </button>
  );
}
