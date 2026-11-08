import { useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { AddServerModal } from "./components/AddServerModal";
import { ConnectGate } from "./components/ConnectGate";
import { TerminalView } from "./components/TerminalView";
import { FileManagerView } from "./components/FileManagerView";
import { ConfirmDialog, PromptDialog } from "./components/Dialogs";
import type { ServerConnection } from "./types";

type Tab = "terminal" | "files";

// Dialogs opened from a server's right-click menu in the sidebar.
type ServerDialog =
  | { kind: "edit"; conn: ServerConnection }
  | { kind: "rename"; conn: ServerConnection }
  | { kind: "delete"; conn: ServerConnection };

export default function App() {
  const [activeConn, setActiveConn] = useState<ServerConnection | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("terminal");
  const [showAddModal, setShowAddModal] = useState(false);
  const [serverDialog, setServerDialog] = useState<ServerDialog | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  function handleSelectConnection(conn: ServerConnection) {
    if (sessionId) {
      window.api.ssh.disconnect(sessionId);
    }
    setActiveConn(conn);
    setSessionId(null);
    setTab("terminal");
  }

  // After an add, edit or rename: refresh the list, and keep the open
  // server's details (shown on the connect screen) up to date.
  function handleServerSaved(conn: ServerConnection) {
    setRefreshKey((k) => k + 1);
    if (activeConn?.id === conn.id) setActiveConn(conn);
  }

  async function handleDeleteServer(conn: ServerConnection) {
    await window.api.connections.delete(conn.id);
    if (activeConn?.id === conn.id) {
      if (sessionId) window.api.ssh.disconnect(sessionId);
      setActiveConn(null);
      setSessionId(null);
    }
    setRefreshKey((k) => k + 1);
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        activeId={activeConn?.id ?? null}
        onSelect={handleSelectConnection}
        onAddServer={() => setShowAddModal(true)}
        onEdit={(conn) => setServerDialog({ kind: "edit", conn })}
        onRename={(conn) => setServerDialog({ kind: "rename", conn })}
        onDelete={(conn) => setServerDialog({ kind: "delete", conn })}
        refreshKey={refreshKey}
      />

      {/* min-w-0: without it this flex item grows to fit its content, so a
          wide terminal pushes the layout wider, which makes the terminal
          refit wider again — an endless loop that leaves it blank. */}
      <main className="flex min-w-0 flex-1 flex-col">
        {!activeConn && (
          <div className="flex h-full items-center justify-center text-sm text-text-muted">
            Select or add a server to get started.
          </div>
        )}

        {activeConn && !sessionId && (
          <ConnectGate connection={activeConn} onConnected={setSessionId} />
        )}

        {activeConn && sessionId && (
          <>
            <div className="flex items-center gap-1 border-b border-border-subtle px-4 pt-3">
              <TabButton active={tab === "terminal"} onClick={() => setTab("terminal")}>
                Terminal
              </TabButton>
              <TabButton active={tab === "files"} onClick={() => setTab("files")}>
                Files
              </TabButton>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              {/* The terminal stays mounted (just hidden) on the Files tab so
                  the remote shell and its scrollback survive tab switches. */}
              <div className={tab === "terminal" ? "h-full" : "hidden"}>
                <TerminalView sessionId={sessionId} />
              </div>
              {tab === "files" && <FileManagerView sessionId={sessionId} />}
            </div>
          </>
        )}
      </main>

      {showAddModal && (
        <AddServerModal
          onClose={() => setShowAddModal(false)}
          onSaved={handleServerSaved}
        />
      )}

      {serverDialog?.kind === "edit" && (
        <AddServerModal
          connection={serverDialog.conn}
          onClose={() => setServerDialog(null)}
          onSaved={handleServerSaved}
        />
      )}

      {serverDialog?.kind === "rename" && (
        <PromptDialog
          title={`Rename “${serverDialog.conn.name}”`}
          label="Name"
          initialValue={serverDialog.conn.name}
          confirmLabel="Rename"
          validate={(name) => (name ? null : "Enter a name.")}
          onCancel={() => setServerDialog(null)}
          onSubmit={async (name) => {
            const updated = await window.api.connections.update(serverDialog.conn.id, {
              name,
            });
            setServerDialog(null);
            handleServerSaved(updated);
          }}
        />
      )}

      {serverDialog?.kind === "delete" && (
        <ConfirmDialog
          title={`Delete “${serverDialog.conn.name}”?`}
          confirmLabel="Delete"
          busyLabel="Deleting…"
          danger
          onCancel={() => setServerDialog(null)}
          onConfirm={async () => {
            await handleDeleteServer(serverDialog.conn);
            setServerDialog(null);
          }}
        >
          <p>
            This removes the server from this app and deletes its saved key
            passphrase from the Keychain. Nothing on the server itself is changed.
          </p>
          <p className="break-all font-mono text-xs text-text-muted">
            {serverDialog.conn.username}@{serverDialog.conn.host}:{serverDialog.conn.port}
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
        active
          ? "border-b-2 border-accent text-text-primary"
          : "text-text-muted hover:text-text-secondary"
      }`}
    >
      {children}
    </button>
  );
}
