// SSH + SFTP session manager. Each BrowserWindow terminal/file-manager
// view holds a sessionId that maps to one live ssh2 Client + its shell
// stream. Credentials are read ONCE at connect() and never persisted
// here beyond the lifetime of the Client object.

import {
  Client,
  type ConnectConfig,
  type FileEntryWithStats,
  type SFTPWrapper,
  type Stats,
} from "ssh2";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

interface Session {
  client: Client;
  shellStream: import("ssh2").ClientChannel | null;
  // Bumped on every openShell() so a replaced shell's events are ignored.
  shellGeneration: number;
  // Shared SFTP channel, opened on first use (see getSftp()).
  sftp: Promise<SFTPWrapper> | null;
}

const sessions = new Map<string, Session>();

export interface ConnectParams {
  host: string;
  port: number;
  username: string;
  privateKeyPath: string;
  passphrase: string | null;
  // Fingerprint of the server host key the user trusted before, or null if
  // they haven't trusted this server yet. Any other key is refused.
  trustedHostKey: string | null;
}

// Rejected host key: either not trusted yet (`previous` is null) or
// different from the trusted one. The caller asks the user what to do.
export class HostKeyError extends Error {
  constructor(
    readonly fingerprint: string,
    readonly keyType: string,
    readonly previous: string | null
  ) {
    super(previous ? "Server host key changed" : "Server host key not trusted yet");
    this.name = "HostKeyError";
  }
}

// Same format as OpenSSH ("SHA256:…"), so it can be compared with
// `ssh-keygen -lf` output on the server.
export function hostKeyFingerprint(key: Buffer): string {
  const digest = crypto.createHash("sha256").update(key).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

// The key blob starts with its type name, e.g. "ssh-ed25519".
function hostKeyType(key: Buffer): string {
  try {
    return key.subarray(4, 4 + key.readUInt32BE(0)).toString("ascii");
  } catch {
    return "unknown";
  }
}

export function connect(params: ConnectParams): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const sessionId = crypto.randomUUID();
    let rejectedKey: HostKeyError | null = null;

    const config: ConnectConfig = {
      host: params.host,
      port: params.port,
      username: params.username,
      privateKey: fs.readFileSync(params.privateKeyPath),
      passphrase: params.passphrase ?? undefined,
      readyTimeout: 20_000,
      // Only go on (and authenticate) if the server proves it is the one
      // the user trusted, like OpenSSH's known_hosts check.
      hostVerifier: (key: Buffer) => {
        const fingerprint = hostKeyFingerprint(key);
        if (fingerprint === params.trustedHostKey) return true;
        rejectedKey = new HostKeyError(fingerprint, hostKeyType(key), params.trustedHostKey);
        return false;
      },
    };

    client
      .on("ready", () => {
        sessions.set(sessionId, {
          client,
          shellStream: null,
          shellGeneration: 0,
          sftp: null,
        });
        resolve(sessionId);
      })
      .on("error", (err) => {
        reject(rejectedKey ?? err);
      })
      .connect(config);
  });
}

export function openShell(
  sessionId: string,
  size: { cols: number; rows: number },
  onData: (chunk: Buffer) => void,
  onClose: () => void
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return Promise.reject(new Error("Unknown session"));

  // One terminal shell per session. If an earlier one is still open (the
  // terminal view re-mounted, e.g. after a dev hot reload), close it and
  // ignore its remaining events so its output can't leak into the new view.
  const generation = ++session.shellGeneration;
  const isCurrent = () => session.shellGeneration === generation;
  session.shellStream?.end();
  session.shellStream = null;

  return new Promise((resolve, reject) => {
    session.client.shell(
      { term: "xterm-256color", cols: size.cols, rows: size.rows },
      (err, stream) => {
        if (err) return reject(err);
        if (!isCurrent()) {
          stream.end();
          return reject(new Error("Shell request superseded"));
        }
        session.shellStream = stream;
        stream.on("data", (chunk: Buffer) => {
          if (isCurrent()) onData(chunk);
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          if (isCurrent()) onData(chunk);
        });
        stream.on("close", () => {
          if (!isCurrent()) return;
          session.shellStream = null;
          onClose();
        });
        resolve();
      }
    );
  });
}

export function writeToShell(sessionId: string, data: string): void {
  sessions.get(sessionId)?.shellStream?.write(data);
}

export function resizeShell(
  sessionId: string,
  cols: number,
  rows: number
): void {
  sessions.get(sessionId)?.shellStream?.setWindow(rows, cols, 0, 0);
}

export function disconnect(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.shellStream?.end();
  session.client.end();
  sessions.delete(sessionId);
}

export function disconnectAll(): void {
  for (const id of Array.from(sessions.keys())) disconnect(id);
}

// --- SFTP helpers (used by the file-manager panel) ---

function sessionOrThrow(sessionId: string): Session {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Unknown session");
  return session;
}

// One SFTP channel per session, opened on first use and then reused. Opening
// a channel per request (and never closing it) runs into the server's cap on
// channels per connection — OpenSSH's MaxSessions defaults to 10.
function getSftp(session: Session): Promise<SFTPWrapper> {
  if (session.sftp) return session.sftp;
  const pending = new Promise<SFTPWrapper>((resolve, reject) => {
    session.client.sftp((err, sftp) => {
      if (err) return reject(err);
      const forget = () => {
        if (session.sftp === pending) session.sftp = null;
      };
      sftp.on("close", forget).on("end", forget).on("error", forget);
      resolve(sftp);
    });
  });
  session.sftp = pending;
  pending.catch(() => {
    if (session.sftp === pending) session.sftp = null;
  });
  return pending;
}

// Adapts an ssh2 callback-style call to a promise.
function call<T>(
  run: (done: (err: Error | null | undefined, value?: T) => void) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    run((err, value) => (err ? reject(err) : resolve(value as T)));
  });
}

const S_IFMT = 0o170000;

export type RemoteFileType = "file" | "directory" | "symlink" | "other";

function fileType(mode: number): RemoteFileType {
  switch (mode & S_IFMT) {
    case 0o040000:
      return "directory";
    case 0o100000:
      return "file";
    case 0o120000:
      return "symlink";
    default:
      return "other";
  }
}

export interface RemoteEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
}

export async function listDirectory(
  sessionId: string,
  remotePath: string
): Promise<RemoteEntry[]> {
  const sftp = await getSftp(sessionOrThrow(sessionId));
  const list = await call<FileEntryWithStats[]>((done) =>
    sftp.readdir(remotePath, done)
  );
  return list.map((entry) => ({
    name: entry.filename,
    isDirectory: fileType(entry.attrs.mode) === "directory",
    size: entry.attrs.size,
    modifiedAt: entry.attrs.mtime * 1000,
  }));
}

export async function downloadFile(
  sessionId: string,
  remotePath: string,
  localPath: string
): Promise<void> {
  const sftp = await getSftp(sessionOrThrow(sessionId));
  await call<void>((done) => sftp.fastGet(remotePath, localPath, done));
}

export async function uploadFile(
  sessionId: string,
  localPath: string,
  remotePath: string
): Promise<void> {
  const sftp = await getSftp(sessionOrThrow(sessionId));
  await call<void>((done) => sftp.fastPut(localPath, remotePath, done));
}

// --- Properties dialog (WinSCP-style info, permissions and ownership) ---

export interface RemoteStat {
  path: string;
  type: RemoteFileType;
  permissions: number; // mode & 0o7777, including set-UID/set-GID/sticky
  uid: number;
  gid: number;
  size: number;
  modifiedAt: number;
  linkTarget: string | null;
}

export async function statPath(
  sessionId: string,
  remotePath: string
): Promise<RemoteStat> {
  const sftp = await getSftp(sessionOrThrow(sessionId));
  // lstat, so a symlink is described as itself rather than as its target.
  const attrs = await call<Stats>((done) => sftp.lstat(remotePath, done));
  const type = fileType(attrs.mode);
  const linkTarget =
    type === "symlink"
      ? await call<string>((done) => sftp.readlink(remotePath, done)).catch(
          () => null
        )
      : null;
  return {
    path: remotePath,
    type,
    permissions: attrs.mode & 0o7777,
    uid: attrs.uid,
    gid: attrs.gid,
    size: attrs.size,
    modifiedAt: attrs.mtime * 1000,
    linkTarget,
  };
}

export interface Principal {
  name: string;
  id: number;
}

export interface Principals {
  users: Principal[];
  groups: Principal[];
}

// Users and groups for the owner/group pickers, from /etc/passwd and
// /etc/group. A file that can't be read (e.g. a chrooted SFTP-only account)
// gives an empty list, and the dialog falls back to numeric IDs.
export async function listPrincipals(sessionId: string): Promise<Principals> {
  const sftp = await getSftp(sessionOrThrow(sessionId));
  const read = (file: string) =>
    call<Buffer>((done) => sftp.readFile(file, done)).then(
      (buf) => buf.toString("utf8"),
      () => ""
    );
  const [passwd, group] = await Promise.all([
    read("/etc/passwd"),
    read("/etc/group"),
  ]);
  return { users: parseIdFile(passwd), groups: parseIdFile(group) };
}

// Both files have one "name:password:id:..." entry per line.
function parseIdFile(text: string): Principal[] {
  const seen = new Set<string>();
  const entries: Principal[] = [];
  for (const line of text.split("\n")) {
    const [name, , idText] = line.trim().split(":");
    if (!name || /^[#+-]/.test(name) || !idText || seen.has(name)) continue;
    const id = Number(idText);
    if (!Number.isInteger(id) || id < 0) continue;
    seen.add(name);
    entries.push({ name, id });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export interface PropertyChanges {
  permissions?: number;
  uid?: number;
  gid?: number;
  // Folders only: also apply to everything inside.
  recursivePermissions?: boolean;
  recursiveOwnership?: boolean;
}

export async function setProperties(
  sessionId: string,
  remotePath: string,
  changes: PropertyChanges
): Promise<void> {
  const session = sessionOrThrow(sessionId);
  const { permissions, uid, gid, recursivePermissions, recursiveOwnership } =
    changes;

  // Absolute paths only: they can never be mistaken for a command option.
  checkPath(remotePath);
  if (permissions !== undefined && !isIntInRange(permissions, 0, 0o7777)) {
    throw new Error("Invalid permissions");
  }
  if ((uid === undefined) !== (gid === undefined)) {
    throw new Error("Owner and group must be changed together");
  }
  if (
    uid !== undefined &&
    (!isIntInRange(uid, 0, 0xffffffff) || !isIntInRange(gid, 0, 0xffffffff))
  ) {
    throw new Error("Invalid owner or group");
  }
  if (
    (recursivePermissions || recursiveOwnership) &&
    path.posix.normalize(remotePath) === "/"
  ) {
    throw new Error("Refusing to apply changes to the whole filesystem");
  }

  const sftp = await getSftp(session);
  const target = shellQuote(remotePath);

  // Ownership first: changing a file's owner clears its set-UID/set-GID
  // bits, so permissions are applied afterwards.
  if (uid !== undefined && gid !== undefined) {
    if (recursiveOwnership) {
      // chown -R never follows symlinks; it re-owns the links themselves.
      // "--" goes before the first operand: BSD and musl getopt stop at the
      // owner argument, so a later "--" would be taken as a file name.
      await runCommand(session, `chown -R -- ${uid}:${gid} ${target}`);
    } else {
      await call<void>((done) => sftp.chown(remotePath, uid, gid, done));
    }
  }

  if (permissions !== undefined) {
    if (recursivePermissions) {
      // Like WinSCP's "Add X to directories": folders also get execute
      // wherever read is set so they stay openable, and set-UID/set-GID/
      // sticky go to folders only. -type d/-type f never match symlinks.
      const folderMode = permissions | ((permissions & 0o444) >> 2);
      const fileMode = permissions & 0o777;
      await runCommand(
        session,
        `find ${target}` +
          ` '(' -type d -exec chmod ${chmodArg(folderMode)} '{}' + ')'` +
          ` -o '(' -type f -exec chmod ${chmodArg(fileMode)} '{}' + ')'`
      );
    } else {
      await call<void>((done) => sftp.chmod(remotePath, permissions, done));
    }
  }
}

// --- Rename / new folder / delete ---

// Accepts only absolute, already-normalized paths (no "." or ".." segments,
// no trailing slash), so an operation hits exactly the item the user picked.
function checkPath(remotePath: unknown): string {
  if (
    typeof remotePath !== "string" ||
    !remotePath.startsWith("/") ||
    remotePath.includes("\0") ||
    path.posix.normalize(remotePath) !== remotePath ||
    (remotePath !== "/" && remotePath.endsWith("/"))
  ) {
    throw new Error("Invalid remote path");
  }
  return remotePath;
}

const SFTP_NO_SUCH_FILE = 2;

async function pathExists(sftp: SFTPWrapper, remotePath: string): Promise<boolean> {
  try {
    await call<Stats>((done) => sftp.lstat(remotePath, done));
    return true;
  } catch (err) {
    if ((err as { code?: unknown }).code === SFTP_NO_SUCH_FILE) return false;
    throw err;
  }
}

export async function renamePath(
  sessionId: string,
  fromPath: string,
  toPath: string
): Promise<void> {
  const session = sessionOrThrow(sessionId);
  checkPath(fromPath);
  checkPath(toPath);
  if (
    fromPath === "/" ||
    path.posix.dirname(fromPath) !== path.posix.dirname(toPath)
  ) {
    throw new Error("Can only rename within the same folder");
  }
  if (fromPath === toPath) return;
  const sftp = await getSftp(session);
  // Checked up front for a clear message; the SFTP rename itself also
  // refuses to replace an existing item.
  if (await pathExists(sftp, toPath)) {
    throw new Error(`“${path.posix.basename(toPath)}” already exists in this folder`);
  }
  await call<void>((done) => sftp.rename(fromPath, toPath, done));
}

export async function makeDirectory(
  sessionId: string,
  remotePath: string
): Promise<void> {
  const session = sessionOrThrow(sessionId);
  checkPath(remotePath);
  const sftp = await getSftp(session);
  if (await pathExists(sftp, remotePath)) {
    throw new Error(`“${path.posix.basename(remotePath)}” already exists in this folder`);
  }
  await call<void>((done) => sftp.mkdir(remotePath, done));
}

export async function deletePath(
  sessionId: string,
  remotePath: string
): Promise<void> {
  const session = sessionOrThrow(sessionId);
  checkPath(remotePath);
  if (remotePath === "/") throw new Error("Refusing to delete /");
  const sftp = await getSftp(session);
  // Decide from the server's own lstat, not from what the renderer thinks.
  const attrs = await call<Stats>((done) => sftp.lstat(remotePath, done));
  if (fileType(attrs.mode) === "directory") {
    // rm never follows symlinks inside the tree; it removes the links.
    await runCommand(session, `rm -rf -- ${shellQuote(remotePath)}`);
  } else {
    // A file, or a symlink (only the link itself is removed).
    await call<void>((done) => sftp.unlink(remotePath, done));
  }
}

// --- Built-in text editor ---

const MAX_EDIT_BYTES = 5 * 1024 * 1024;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export interface TextFile {
  content: string; // line endings normalized to "\n"
  eol: "lf" | "crlf";
  bom: boolean;
  modifiedAt: number;
  size: number;
}

export async function readTextFile(
  sessionId: string,
  remotePath: string
): Promise<TextFile> {
  const session = sessionOrThrow(sessionId);
  checkPath(remotePath);
  const sftp = await getSftp(session);
  // stat, not lstat: editing a symlink edits the file it points to.
  const attrs = await call<Stats>((done) => sftp.stat(remotePath, done));
  if (fileType(attrs.mode) !== "file") {
    throw new Error("Only regular files can be edited");
  }
  if (attrs.size > MAX_EDIT_BYTES) {
    throw new Error(
      `This file is too large to edit here (${(attrs.size / 1024 / 1024).toFixed(1)} MB, limit 5 MB). Download it instead.`
    );
  }
  let data = await call<Buffer>((done) => sftp.readFile(remotePath, done));
  const bom = data.subarray(0, 3).equals(UTF8_BOM);
  if (bom) data = data.subarray(3);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error("This file isn't UTF-8 text, so it can't be edited here.");
  }
  if (text.includes("\0")) {
    throw new Error("This looks like a binary file, so it can't be edited here.");
  }
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  return {
    content: text.replace(/\r\n/g, "\n"),
    eol: crlf > lf ? "crlf" : "lf",
    bom,
    modifiedAt: attrs.mtime * 1000,
    size: attrs.size,
  };
}

export interface SaveTextOptions {
  eol: "lf" | "crlf";
  bom: boolean;
  // When given, refuse to save if the file changed on the server since it
  // was read (the renderer then asks before overwriting).
  expectedModifiedAt?: number;
  expectedSize?: number;
}

export async function writeTextFile(
  sessionId: string,
  remotePath: string,
  content: string,
  options: SaveTextOptions
): Promise<{ modifiedAt: number; size: number }> {
  const session = sessionOrThrow(sessionId);
  checkPath(remotePath);
  if (typeof content !== "string") throw new Error("Invalid file content");
  const sftp = await getSftp(session);
  if (options.expectedModifiedAt !== undefined) {
    const current = await call<Stats>((done) => sftp.stat(remotePath, done));
    if (
      current.mtime * 1000 !== options.expectedModifiedAt ||
      current.size !== options.expectedSize
    ) {
      throw new Error("CHANGED_ON_SERVER");
    }
  }
  const text = options.eol === "crlf" ? content.replace(/\r?\n/g, "\r\n") : content;
  const body = Buffer.from(text, "utf8");
  // Written in place (truncate + write), which keeps the file's
  // permissions, owner and any symlink pointing at it.
  await call<void>((done) =>
    sftp.writeFile(remotePath, options.bom ? Buffer.concat([UTF8_BOM, body]) : body, done)
  );
  const saved = await call<Stats>((done) => sftp.stat(remotePath, done));
  return { modifiedAt: saved.mtime * 1000, size: saved.size };
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

// POSIX single-quoting; safe for any string without a NUL byte.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Always five octal digits: GNU chmod leaves a folder's set-UID/set-GID bits
// alone for shorter numeric modes, so 00755 is needed to actually clear them.
function chmodArg(mode: number): string {
  return mode.toString(8).padStart(5, "0");
}

// Runs a command on the server (no PTY) and rejects with its stderr when it
// exits non-zero.
function runCommand(session: Session, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    session.client.exec(command, (err, stream) => {
      if (err) return reject(err);
      let exitCode: number | null = null;
      let stderr = "";
      stream.on("exit", (code: number | null) => {
        exitCode = code;
      });
      stream.on("data", () => {}); // drain stdout so the channel can close
      stream.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString("utf8");
      });
      stream.on("close", () => {
        if (exitCode === 0) return resolve();
        const lines = stderr.trim().split("\n").filter(Boolean);
        const detail =
          lines.length > 4
            ? `${lines.slice(0, 4).join("\n")}\n…`
            : lines.join("\n");
        reject(
          new Error(detail || `Remote command failed (exit code ${exitCode})`)
        );
      });
    });
  });
}
