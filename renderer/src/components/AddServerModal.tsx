import { useState } from "react";
import type { ServerConnection } from "../types";
import { errorMessage } from "../format";

const COLORS = ["slate", "blue", "green", "amber", "rose", "violet"] as const;

// Adds a server, or edits one when `connection` is given.
export function AddServerModal({
  connection,
  onClose,
  onSaved,
}: {
  connection?: ServerConnection;
  onClose: () => void;
  onSaved: (conn: ServerConnection) => void;
}) {
  const editing = connection !== undefined;
  const [name, setName] = useState(connection?.name ?? "");
  const [host, setHost] = useState(connection?.host ?? "");
  const [port, setPort] = useState(String(connection?.port ?? 22));
  const [username, setUsername] = useState(connection?.username ?? "root");
  const [keyPath, setKeyPath] = useState<string | null>(connection?.key_path ?? null);
  const [passphrase, setPassphrase] = useState("");
  const [color, setColor] = useState<string>(connection?.color ?? "blue");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePickKey() {
    const path = await window.api.connections.pickKeyFile();
    if (path) setKeyPath(path);
  }

  async function handleSave() {
    setError(null);
    if (!name.trim() || !host.trim() || !username.trim() || !keyPath) {
      setError("Fill in name, host, username and choose an SSH key file.");
      return;
    }
    setSaving(true);
    try {
      const fields = {
        name: name.trim(),
        host: host.trim(),
        port: Number(port) || 22,
        username: username.trim(),
        key_path: keyPath,
        color,
      };
      const saved = editing
        ? await window.api.connections.update(connection.id, fields)
        : await window.api.connections.create({ ...fields, auth_method: "key" });
      // When editing, a blank passphrase keeps the one already saved.
      if (passphrase) {
        await window.api.connections.setPassphrase(saved.id, passphrase);
      }
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(errorMessage(err) || "Failed to save server.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[440px] rounded-2xl border border-border-subtle bg-surface-1 p-6 shadow-2xl">
        <h2 className="mb-1 text-lg font-semibold text-text-primary">
          {editing ? "Edit server" : "Add server"}
        </h2>
        <p className="mb-5 text-sm text-text-muted">
          Only connection info is stored. The passphrase is stored in the
          macOS Keychain, not in a plain file.
        </p>

        <div className="space-y-3">
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Production web server"
              className={inputClass}
            />
          </Field>

          <div className="flex gap-3">
            <Field label="Host" className="flex-[2]">
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="203.0.113.10 or example.com"
                className={inputClass}
              />
            </Field>
            <Field label="Port" className="flex-1">
              <input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="22"
                className={inputClass}
              />
            </Field>
          </div>

          <Field label="Username">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="root"
              className={inputClass}
            />
          </Field>

          <Field label="SSH private key">
            <button
              onClick={handlePickKey}
              className="flex w-full items-center justify-between rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:border-accent"
            >
              <span className="truncate">
                {keyPath ?? "Choose a file (e.g. ~/.ssh/id_ed25519)"}
              </span>
              <span className="ml-2 flex-shrink-0 text-xs text-accent">
                Browse
              </span>
            </button>
          </Field>

          <Field label={editing ? "New key passphrase (optional)" : "Key passphrase (optional)"}>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder={
                editing
                  ? "Leave blank to keep the saved passphrase"
                  : "Leave blank if the key has no passphrase"
              }
              className={inputClass}
            />
          </Field>

          <Field label="Label color">
            <div className="flex gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={`h-6 w-6 rounded-full ring-2 transition-all ${
                    color === c ? "ring-accent" : "ring-transparent"
                  } ${colorToSwatch[c]}`}
                />
              ))}
            </div>
          </Field>
        </div>

        {error && (
          <p className="mt-3 text-xs text-danger">{error}</p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-surface-0 transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving..." : editing ? "Save changes" : "Save server"}
          </button>
        </div>
      </div>
    </div>
  );
}

const colorToSwatch: Record<string, string> = {
  slate: "bg-slate-400",
  blue: "bg-blue-400",
  green: "bg-emerald-400",
  amber: "bg-amber-400",
  rose: "bg-rose-400",
  violet: "bg-violet-400",
};

const inputClass =
  "w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-accent";

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className ?? ""}`}>
      <span className="mb-1.5 block text-xs font-medium text-text-secondary">
        {label}
      </span>
      {children}
    </label>
  );
}
