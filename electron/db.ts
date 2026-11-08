// SQLite storage for server connection METADATA only.
// No passwords or decrypted passphrases are ever written here.
// Passphrases for SSH keys live in the macOS Keychain (via keytar),
// gated behind Touch ID at connect-time (see touchid.ts + ipc-handlers.ts).

import Database from "better-sqlite3";
import { app } from "electron";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const dbDir = path.join(app.getPath("userData"), "data");
fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
const dbPath = path.join(dbDir, "connections.sqlite3");

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    username TEXT NOT NULL,
    auth_method TEXT NOT NULL CHECK (auth_method IN ('key', 'agent')),
    key_path TEXT,
    color TEXT DEFAULT 'slate',
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
`);

// Added later: the fingerprint of the server's host key the user trusted
// (see ssh.connect). Databases from older versions get the column here.
const columns = db.prepare("PRAGMA table_info(connections)").all() as { name: string }[];
if (!columns.some((column) => column.name === "host_key_sha256")) {
  db.exec("ALTER TABLE connections ADD COLUMN host_key_sha256 TEXT");
}

export interface ServerConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method: "key" | "agent";
  key_path: string | null;
  color: string;
  created_at: string;
  last_used_at: string | null;
  host_key_sha256: string | null;
}

export function listConnections(): ServerConnection[] {
  return db
    .prepare("SELECT * FROM connections ORDER BY last_used_at DESC, name ASC")
    .all() as ServerConnection[];
}

export function getConnection(id: string): ServerConnection | undefined {
  return db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as
    | ServerConnection
    | undefined;
}

export function createConnection(input: {
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method: "key" | "agent";
  key_path?: string | null;
  color?: string;
}): ServerConnection {
  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();
  db.prepare(
    `INSERT INTO connections (id, name, host, port, username, auth_method, key_path, color, created_at)
     VALUES (@id, @name, @host, @port, @username, @auth_method, @key_path, @color, @created_at)`
  ).run({
    id,
    name: input.name,
    host: input.host,
    port: input.port,
    username: input.username,
    auth_method: input.auth_method,
    key_path: input.key_path ?? null,
    color: input.color ?? "slate",
    created_at,
  });
  return getConnection(id)!;
}

export interface ConnectionChanges {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  key_path?: string | null;
  color?: string;
}

export function updateConnection(
  id: string,
  changes: ConnectionChanges
): ServerConnection {
  const current = getConnection(id);
  if (!current) throw new Error("Connection not found");
  const next = { ...current };
  if (changes.name !== undefined) next.name = requireText(changes.name, "Name");
  if (changes.host !== undefined) next.host = requireText(changes.host, "Host");
  if (changes.username !== undefined) {
    next.username = requireText(changes.username, "Username");
  }
  if (changes.port !== undefined) {
    if (!Number.isInteger(changes.port) || changes.port < 1 || changes.port > 65535) {
      throw new Error("Port must be between 1 and 65535");
    }
    next.port = changes.port;
  }
  if (changes.key_path !== undefined) next.key_path = changes.key_path;
  if (changes.color !== undefined) next.color = changes.color;
  // A different address is a different server: its host key must be
  // trusted again on the next connect.
  if (next.host !== current.host || next.port !== current.port) {
    next.host_key_sha256 = null;
  }

  db.prepare(
    `UPDATE connections
     SET name = @name, host = @host, port = @port, username = @username,
         key_path = @key_path, color = @color, host_key_sha256 = @host_key_sha256
     WHERE id = @id`
  ).run({
    id,
    name: next.name,
    host: next.host,
    port: next.port,
    username: next.username,
    key_path: next.key_path,
    color: next.color,
    host_key_sha256: next.host_key_sha256,
  });
  return getConnection(id)!;
}

export function setTrustedHostKey(id: string, fingerprint: string): void {
  db.prepare("UPDATE connections SET host_key_sha256 = ? WHERE id = ?").run(
    fingerprint,
    id
  );
}

function requireText(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} can't be empty`);
  return text;
}

export function touchLastUsed(id: string): void {
  db.prepare("UPDATE connections SET last_used_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id
  );
}

export function deleteConnection(id: string): void {
  db.prepare("DELETE FROM connections WHERE id = ?").run(id);
}
