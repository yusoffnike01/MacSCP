import { useEffect, useMemo, useState, type DragEvent, type MouseEvent } from "react";
import type { ContextMenuItem, RemoteEntry } from "../types";
import { formatSize } from "../format";
import { PropertiesDialog } from "./PropertiesDialog";
import { ConfirmDialog, PromptDialog } from "./Dialogs";
import { FileEditor } from "./FileEditor";
import { UploadDialog, type UploadSource } from "./UploadDialog";
import { DownloadDialog } from "./DownloadDialog";
import { ArrowUpIcon, FileIcon, FolderIcon } from "./Icons";

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

type SortKey = "name" | "size" | "modified";
type SortState = { key: SortKey; dir: "asc" | "desc" };

const SORT_STORAGE_KEY = "files.sort";
const DEFAULT_SORT: SortState = { key: "name", dir: "asc" };

// The sort survives tab switches and restarts (stored per browser profile).
function loadSort(): SortState {
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) ?? "null");
    if (
      ["name", "size", "modified"].includes(saved?.key) &&
      ["asc", "desc"].includes(saved?.dir)
    ) {
      return saved as SortState;
    }
  } catch {
    // Unreadable or blocked storage: fall back to the default.
  }
  return DEFAULT_SORT;
}

// Natural order, so "file2" comes before "file10".
const byName = (a: RemoteEntry, b: RemoteEntry) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

function sortEntries(entries: RemoteEntry[], { key, dir }: SortState): RemoteEntry[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    // Folders stay on top, like WinSCP and Finder.
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    let diff = 0;
    if (key === "name") diff = byName(a, b);
    else if (key === "modified") diff = a.modifiedAt - b.modifiedAt;
    // Folder sizes aren't meaningful over SFTP, so folders keep name order.
    else if (!a.isDirectory) diff = a.size - b.size;
    return diff !== 0 ? diff * sign : byName(a, b);
  });
}

const uploadButton =
  "rounded-md bg-accent-soft px-3 py-1.5 text-xs font-medium text-accent hover:opacity-80";

type OpenDialog =
  | { kind: "properties"; path: string }
  | { kind: "edit"; path: string }
  | { kind: "rename"; entry: RemoteEntry }
  | { kind: "delete"; entry: RemoteEntry }
  | { kind: "new-folder" }
  | { kind: "upload"; source: UploadSource; remoteDir: string }
  | { kind: "download"; path: string };

export function FileManagerView({ sessionId }: { sessionId: string }) {
  const [currentPath, setCurrentPath] = useState("/root");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [sort, setSort] = useState<SortState>(loadSort);
  const sortedEntries = useMemo(() => sortEntries(entries, sort), [entries, sort]);
  // Files are being dragged over the panel from Finder.
  const [dropActive, setDropActive] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort));
    } catch {
      // Storage unavailable: the sort just won't be remembered.
    }
  }, [sort]);

  // Same column again flips the direction; a new column starts with the
  // most useful order (A→Z, largest first, newest first).
  function toggleSort(key: SortKey) {
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "name" ? "asc" : "desc" }
    );
  }

  // Loads a folder; `select` highlights an entry in it (e.g. one just created).
  async function load(path: string, select: string | null = null) {
    setLoading(true);
    setError(null);
    try {
      const list = await window.api.sftp.list(sessionId, path);
      setEntries(list);
      setCurrentPath(path);
      setSelected(select);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(currentPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Keep the selected entry in view (e.g. a folder just created or renamed).
  useEffect(() => {
    if (!selected || loading) return;
    document
      .querySelector(`tr[data-name="${CSS.escape(selected)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, loading]);

  function navigateUp() {
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    load("/" + parts.join("/"));
  }

  // A file, or a folder with everything inside it.
  function handleDownload(entry: RemoteEntry) {
    setDialog({ kind: "download", path: joinPath(currentPath, entry.name) });
  }

  // Upload file / Upload folder: the open panel, then the same upload window
  // as a drop.
  function pickUpload(what: "files" | "folders") {
    setDialog({ kind: "upload", source: { kind: "pick", what }, remoteDir: currentPath });
  }

  // Files and folders from Finder (not dragged text or links), dropped
  // anywhere on the panel, go into the folder being shown. Not while a dialog
  // is open, or while another folder is loading.
  function acceptsDrag(event: DragEvent) {
    return !dialog && !loading && event.dataTransfer.types.includes("Files");
  }

  function handleDragOver(event: DragEvent) {
    if (!acceptsDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropActive(true);
  }

  function handleDrop(event: DragEvent) {
    setDropActive(false);
    if (!acceptsDrag(event)) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
      setDialog({ kind: "upload", source: { kind: "drop", files }, remoteDir: currentPath });
    }
  }

  function closeDialog() {
    setDialog(null);
  }

  function validateName(name: string, current?: string): string | null {
    if (!name) return "Enter a name.";
    if (name === "." || name === "..") return "That name isn't allowed.";
    if (name.includes("/")) return "Names can't contain “/”.";
    if (name !== current && entries.some((e) => e.name === name)) {
      return `“${name}” already exists in this folder.`;
    }
    return null;
  }

  // Right-click on a file or folder.
  async function handleEntryContextMenu(event: MouseEvent, entry: RemoteEntry) {
    event.preventDefault();
    event.stopPropagation();
    setSelected(entry.name);
    const fullPath = joinPath(currentPath, entry.name);
    const items: ContextMenuItem[] = [
      entry.isDirectory ? { id: "open", label: "Open" } : { id: "edit", label: "Edit" },
      { id: "download", label: "Download…" },
      { type: "separator" },
      { id: "rename", label: "Rename…" },
      { id: "delete", label: "Delete…" },
      { type: "separator" },
      { id: "copy-path", label: "Copy Path" },
      { type: "separator" },
      { id: "properties", label: "Properties…" },
    ];
    switch (await window.api.ui.showContextMenu(items)) {
      case "open":
        load(fullPath);
        break;
      case "edit":
        setDialog({ kind: "edit", path: fullPath });
        break;
      case "download":
        handleDownload(entry);
        break;
      case "rename":
        setDialog({ kind: "rename", entry });
        break;
      case "delete":
        setDialog({ kind: "delete", entry });
        break;
      case "copy-path":
        window.api.ui.copyText(fullPath);
        break;
      case "properties":
        setDialog({ kind: "properties", path: fullPath });
        break;
    }
  }

  // Right-click on empty space: actions for the current folder.
  async function handleFolderContextMenu(event: MouseEvent) {
    event.preventDefault();
    setSelected(null);
    const choice = await window.api.ui.showContextMenu([
      { id: "new-folder", label: "New Folder…" },
      { id: "upload-files", label: "Upload File…" },
      { id: "upload-folders", label: "Upload Folder…" },
      { id: "refresh", label: "Refresh" },
      { type: "separator" },
      { id: "copy-path", label: "Copy Path" },
      { type: "separator" },
      { id: "properties", label: "Properties…" },
    ]);
    switch (choice) {
      case "new-folder":
        setDialog({ kind: "new-folder" });
        break;
      case "upload-files":
        pickUpload("files");
        break;
      case "upload-folders":
        pickUpload("folders");
        break;
      case "refresh":
        load(currentPath);
        break;
      case "copy-path":
        window.api.ui.copyText(currentPath);
        break;
      case "properties":
        setDialog({ kind: "properties", path: currentPath });
        break;
    }
  }

  return (
    <div
      className="relative flex h-full flex-col"
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5">
        <button
          onClick={navigateUp}
          disabled={currentPath === "/"}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-text-secondary hover:bg-surface-2 disabled:opacity-40"
        >
          <ArrowUpIcon size={14} />
          Up
        </button>
        <span className="flex-1 truncate font-mono text-xs text-text-muted">
          {currentPath}
        </span>
        <button
          onClick={() => setDialog({ kind: "new-folder" })}
          className="rounded-md px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-2 hover:text-text-primary"
        >
          New folder
        </button>
        <button onClick={() => pickUpload("files")} className={uploadButton}>
          Upload file
        </button>
        <button onClick={() => pickUpload("folders")} className={uploadButton}>
          Upload folder
        </button>
      </div>

      {error && (
        <p className="px-4 py-2 text-xs text-danger">{error}</p>
      )}

      <div
        className="flex-1 overflow-y-auto"
        onContextMenu={handleFolderContextMenu}
      >
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-surface-1 text-xs uppercase text-text-muted">
            <tr>
              <SortHeader label="Name" column="name" sort={sort} onSort={toggleSort} />
              <SortHeader label="Size" column="size" sort={sort} onSort={toggleSort} />
              <SortHeader label="Modified" column="modified" sort={sort} onSort={toggleSort} />
              <th className="px-4 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-text-muted">
                  Loading...
                </td>
              </tr>
            )}
            {!loading &&
              sortedEntries.map((entry) => (
                <tr
                  key={entry.name}
                  data-name={entry.name}
                  onClick={() => setSelected(entry.name)}
                  onDoubleClick={() => {
                    if (!entry.isDirectory) {
                      setDialog({ kind: "edit", path: joinPath(currentPath, entry.name) });
                    }
                  }}
                  onContextMenu={(e) => handleEntryContextMenu(e, entry)}
                  className={`border-t border-border-subtle/60 ${
                    selected === entry.name ? "bg-accent-soft" : "hover:bg-surface-2"
                  }`}
                >
                  <td
                    className={`px-4 py-2 ${
                      entry.isDirectory ? "cursor-pointer text-text-primary" : "text-text-secondary"
                    }`}
                    onClick={() =>
                      entry.isDirectory && load(joinPath(currentPath, entry.name))
                    }
                  >
                    <span className="flex items-center gap-2">
                      {entry.isDirectory ? (
                        <FolderIcon className="shrink-0 text-accent" />
                      ) : (
                        <FileIcon className="shrink-0 text-text-muted" />
                      )}
                      {entry.name}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-text-muted">
                    {entry.isDirectory ? "—" : formatSize(entry.size)}
                  </td>
                  <td className="px-4 py-2 text-text-muted">
                    {new Date(entry.modifiedAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => handleDownload(entry)}
                      className="text-xs text-accent hover:underline"
                    >
                      Download
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* Covers the whole panel while dragging, so it is the only drag target
          (its contents ignore the pointer) and dragleave fires only when the
          pointer leaves the panel. Mouse events don't arrive during a drag, so
          a mouse move means the drag is over, should it have ended without a
          dragleave; the overlay must never be left blocking the list. */}
      {dropActive && (
        <div
          className="absolute inset-0 z-40 bg-surface-0/70 p-3"
          onDragLeave={() => setDropActive(false)}
          onMouseMove={() => setDropActive(false)}
        >
          <div className="pointer-events-none flex h-full flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-accent bg-accent-soft px-6 text-center">
            <p className="text-sm font-medium text-text-primary">Drop to upload</p>
            <p className="max-w-full truncate font-mono text-xs text-text-secondary">
              to {currentPath}
            </p>
          </div>
        </div>
      )}

      {dialog?.kind === "upload" && (
        <UploadDialog
          sessionId={sessionId}
          source={dialog.source}
          remoteDir={dialog.remoteDir}
          onCancel={closeDialog}
          onDone={(select) => {
            closeDialog();
            load(dialog.remoteDir, select);
          }}
        />
      )}

      {dialog?.kind === "download" && (
        <DownloadDialog sessionId={sessionId} remotePath={dialog.path} onClose={closeDialog} />
      )}

      {dialog?.kind === "properties" && (
        <PropertiesDialog
          sessionId={sessionId}
          path={dialog.path}
          onClose={closeDialog}
        />
      )}

      {dialog?.kind === "edit" && (
        <FileEditor
          sessionId={sessionId}
          path={dialog.path}
          onClose={(saved) => {
            closeDialog();
            if (saved) load(currentPath, selected);
          }}
        />
      )}

      {dialog?.kind === "new-folder" && (
        <PromptDialog
          title="New folder"
          label={`Name (in ${currentPath})`}
          confirmLabel="Create"
          validate={(name) => validateName(name)}
          onCancel={closeDialog}
          onSubmit={async (name) => {
            await window.api.sftp.mkdir(sessionId, joinPath(currentPath, name));
            closeDialog();
            await load(currentPath, name);
          }}
        />
      )}

      {dialog?.kind === "rename" && (
        <PromptDialog
          title={`Rename “${dialog.entry.name}”`}
          label="New name"
          initialValue={dialog.entry.name}
          selectStem={!dialog.entry.isDirectory}
          confirmLabel="Rename"
          validate={(name) => validateName(name, dialog.entry.name)}
          onCancel={closeDialog}
          onSubmit={async (name) => {
            if (name !== dialog.entry.name) {
              await window.api.sftp.rename(
                sessionId,
                joinPath(currentPath, dialog.entry.name),
                joinPath(currentPath, name)
              );
            }
            closeDialog();
            await load(currentPath, name);
          }}
        />
      )}

      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title={`Delete “${dialog.entry.name}”?`}
          confirmLabel="Delete"
          busyLabel="Deleting…"
          danger
          onCancel={closeDialog}
          onConfirm={async () => {
            await window.api.sftp.delete(
              sessionId,
              joinPath(currentPath, dialog.entry.name)
            );
            closeDialog();
            await load(currentPath);
          }}
        >
          <p>
            {dialog.entry.isDirectory
              ? "The folder and everything inside it will be permanently deleted from the server."
              : "This will be permanently deleted from the server."}{" "}
            This can't be undone.
          </p>
          <p className="break-all font-mono text-xs text-text-muted">
            {joinPath(currentPath, dialog.entry.name)}
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function SortHeader({
  label,
  column,
  sort,
  onSort,
}: {
  label: string;
  column: SortKey;
  sort: SortState;
  onSort: (column: SortKey) => void;
}) {
  const active = sort.key === column;
  return (
    <th
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className="px-4 py-2 font-medium"
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1.5 uppercase transition-colors hover:text-text-primary ${
          active ? "text-text-secondary" : ""
        }`}
      >
        {label}
        {/* Always rendered (invisible when inactive) so headers don't shift. */}
        <span aria-hidden="true" className={`text-[9px] ${active ? "" : "invisible"}`}>
          {active && sort.dir === "desc" ? "▼" : "▲"}
        </span>
      </button>
    </th>
  );
}
