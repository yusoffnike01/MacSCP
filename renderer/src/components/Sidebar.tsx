import { useEffect, useState, type MouseEvent } from "react";
import type { ServerConnection } from "../types";

const DOT_COLORS: Record<string, string> = {
  slate: "bg-slate-400",
  blue: "bg-blue-400",
  green: "bg-emerald-400",
  amber: "bg-amber-400",
  rose: "bg-rose-400",
  violet: "bg-violet-400",
};

export function Sidebar({
  activeId,
  connectedId,
  onSelect,
  onAddServer,
  onEdit,
  onRename,
  onDelete,
  refreshKey,
}: {
  activeId: string | null;
  // The server with a live SSH session, if any.
  connectedId: string | null;
  onSelect: (conn: ServerConnection) => void;
  onAddServer: () => void;
  onEdit: (conn: ServerConnection) => void;
  onRename: (conn: ServerConnection) => void;
  onDelete: (conn: ServerConnection) => void;
  refreshKey: number;
}) {
  const [connections, setConnections] = useState<ServerConnection[]>([]);

  useEffect(() => {
    window.api.connections.list().then(setConnections);
  }, [refreshKey]);

  async function handleContextMenu(event: MouseEvent, conn: ServerConnection) {
    event.preventDefault();
    const choice = await window.api.ui.showContextMenu([
      { id: "edit", label: "Edit…" },
      { id: "rename", label: "Rename…" },
      { type: "separator" },
      { id: "delete", label: "Delete…" },
    ]);
    if (choice === "edit") onEdit(conn);
    else if (choice === "rename") onRename(conn);
    else if (choice === "delete") onDelete(conn);
  }

  return (
    // select-none: on macOS a right-click would otherwise select the word under it.
    <aside className="flex h-full w-64 shrink-0 select-none flex-col border-r border-border-subtle bg-surface-1">
      {/* padding-top makes room for the macOS traffic-light buttons under titleBarStyle="hiddenInset" */}
      <div
        className="flex items-center justify-between px-4 pb-3"
        style={{ paddingTop: "34px" }}
      >
        <span className="text-sm font-semibold tracking-wide text-text-primary">
          MacFlux
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-2">
        {connections.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-text-muted">
            No servers yet. Add your first server.
          </p>
        )}

        <ul className="space-y-1">
          {connections.map((conn) => (
            <li key={conn.id}>
              <button
                onClick={() => onSelect(conn)}
                onContextMenu={(e) => handleContextMenu(e, conn)}
                className={`group flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors ${
                  activeId === conn.id
                    ? "bg-accent-soft text-text-primary"
                    : "text-text-secondary hover:bg-surface-2 hover:text-text-primary"
                }`}
              >
                <span
                  className={`h-2 w-2 flex-shrink-0 rounded-full ${
                    DOT_COLORS[conn.color] ?? DOT_COLORS.slate
                  }`}
                />
                <span className="flex-1 overflow-hidden">
                  <span className="flex items-center gap-1">
                    <span className="truncate text-sm font-medium">{conn.name}</span>
                    {connectedId === conn.id && <ConnectedIndicator />}
                  </span>
                  <span className="block truncate text-xs text-text-muted">
                    {conn.username}@{conn.host}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t border-border-subtle p-3">
        <button
          onClick={onAddServer}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border-subtle py-2.5 text-sm text-text-secondary transition-colors hover:border-accent hover:text-accent"
        >
          <span className="text-base leading-none">+</span>
          Add server
        </button>
      </div>
    </aside>
  );
}

// Pulsing green dot after the name of the connected server. The pulse sets
// it apart from the server's own color dot, which can also be green. The
// 16px box leaves room for the pulse, so the row's overflow-hidden can't
// clip it when a long name pushes the dot to the edge.
function ConnectedIndicator() {
  return (
    <span
      className="relative flex h-4 w-4 shrink-0 items-center justify-center"
      title="Connected"
    >
      <span className="absolute inset-1 rounded-full bg-success opacity-75 motion-safe:animate-connected" />
      <span className="relative h-2 w-2 rounded-full bg-success" />
      <span className="sr-only">Connected</span>
    </span>
  );
}
