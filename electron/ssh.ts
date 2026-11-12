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
import os from "node:os";
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
  // How to log in: with an SSH key file, or with a password.
  auth:
    | { method: "key"; privateKeyPath: string; passphrase: string | null }
    | { method: "password"; password: string };
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

export function connect(
  params: ConnectParams,
  // Called once if the connection later drops by itself (network lost,
  // server restarted, keepalive timed out). Not called after disconnect().
  onDropped: (sessionId: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const sessionId = crypto.randomUUID();
    let rejectedKey: HostKeyError | null = null;
    const { auth } = params;

    const config: ConnectConfig = {
      host: params.host,
      port: params.port,
      username: params.username,
      ...(auth.method === "key"
        ? {
            privateKey: fs.readFileSync(auth.privateKeyPath),
            passphrase: auth.passphrase ?? undefined,
          }
        : // Keyboard-interactive is tried if plain password login fails.
          { password: auth.password, tryKeyboard: true }),
      readyTimeout: 20_000,
      // Ping the server every 15 s and give up after 3 unanswered pings.
      // Without this, a connection that died silently (Wi-Fi lost, Mac
      // asleep) would go unnoticed and keep showing as connected.
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      // Only go on (and authenticate) if the server proves it is the one
      // the user trusted, like OpenSSH's known_hosts check.
      hostVerifier: (key: Buffer) => {
        const fingerprint = hostKeyFingerprint(key);
        if (fingerprint === params.trustedHostKey) return true;
        rejectedKey = new HostKeyError(fingerprint, hostKeyType(key), params.trustedHostKey);
        return false;
      },
    };

    if (auth.method === "password") {
      // Some servers take the password only through keyboard-interactive
      // login (e.g. via PAM), as one hidden "Password:" prompt. Answer that
      // prompt once. Anything else, like a one-time code, can't be answered
      // here, so the login fails rather than hanging.
      const { password } = auth;
      let answered = false;
      client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
        if (!answered && prompts.length === 1 && !prompts[0].echo) {
          answered = true;
          finish([password]);
        } else {
          finish(prompts.map(() => ""));
        }
      });
    }

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
      .on("close", () => {
        // disconnect() unregisters a session before its "close" event comes,
        // so a session still registered here dropped by itself.
        if (sessions.has(sessionId)) onDropped(sessionId);
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
  for (const [id, upload] of uploads) {
    if (upload.sessionId === sessionId) cancelUpload(id);
  }
  for (const [id, download] of downloads) {
    if (download.sessionId === sessionId) cancelDownload(id);
  }
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
        closedChannels.add(sftp);
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

// SFTP channels that have closed: the connection dropped or was closed.
const closedChannels = new WeakSet<SFTPWrapper>();
const CONNECTION_LOST = "The connection to the server was lost.";

// call() for a request on `sftp`. Requests waiting for an answer fail when
// the channel closes, but ssh2 never answers one made after that, so it fails
// at once instead of waiting forever.
function sftpCall<T>(
  sftp: SFTPWrapper,
  run: (done: (err: Error | null | undefined, value?: T) => void) => void
): Promise<T> {
  if (closedChannels.has(sftp)) return Promise.reject(new Error(CONNECTION_LOST));
  return call(run);
}

// Closes a remote file or folder handle, without waiting for the answer,
// which never comes if the connection has dropped.
function closeHandle(sftp: SFTPWrapper, handle: Buffer) {
  if (!closedChannels.has(sftp)) sftp.close(handle, () => {});
}

const SFTP_EOF = 1;

// Everything in a remote folder, like ssh2's readdir(path), but a lost
// connection fails it instead of leaving it waiting (ssh2 first waits for the
// folder to close).
async function readFolder(sftp: SFTPWrapper, remotePath: string): Promise<FileEntryWithStats[]> {
  const handle = await sftpCall<Buffer>(sftp, (done) => sftp.opendir(remotePath, done));
  try {
    const entries: FileEntryWithStats[] = [];
    for (;;) {
      try {
        const list = await sftpCall<FileEntryWithStats[]>(sftp, (done) => sftp.readdir(handle, done));
        for (const entry of list) entries.push(entry);
      } catch (err) {
        if ((err as { code?: unknown }).code === SFTP_EOF) return entries;
        throw err;
      }
    }
  } finally {
    closeHandle(sftp, handle);
  }
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

// --- Uploading files and folders ---
//
// Dragged in from Finder, or chosen with Upload file / Upload folder. In two
// steps: prepareUpload() looks at the items and at what's already on the
// server without changing anything, so the user can be asked before anything
// is replaced; startUpload() then sends everything.

// Finder's folder view settings. Never wanted on a server, and a web server
// would hand out the folder's file list with them.
const SKIPPED_NAMES = new Set([".DS_Store"]);

// Files sent at the same time. Helps most with many small files, where each
// one costs a few round trips to the server.
const UPLOAD_CONCURRENCY = 4;

interface UploadFolder {
  remotePath: string;
  display: string; // relative to the destination folder, e.g. "build/static"
}

interface UploadFile extends UploadFolder {
  localPath: string;
  size: number;
}

interface Upload {
  sessionId: string;
  folders: UploadFolder[]; // parents before their subfolders
  files: UploadFile[];
  bytesTotal: number;
  state: "ready" | "running" | "stopping";
}

const uploads = new Map<string, Upload>();

export interface UploadItem {
  name: string;
  isDirectory: boolean;
  // Already in the destination folder: a file will be replaced, a folder
  // merged (files with the same names replaced, the rest kept).
  exists: boolean;
}

export interface UploadSummary {
  id: string;
  items: UploadItem[];
  filesTotal: number;
  bytesTotal: number;
  // Inside the uploaded folders, but not uploaded: symbolic links (as with
  // OpenSSH's `sftp put -r`) and special files such as sockets.
  skipped: string[];
}

export interface UploadProgress {
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  current: string | null; // the file started last
}

export interface UploadResult {
  filesDone: number;
  stopped: boolean; // by the user, before everything was sent
}

// "EACCES: permission denied, scandir '/Users/…'" → "permission denied".
// SFTP errors already read like "Permission denied".
function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && message.startsWith(`${code}: `)) {
    return message.slice(code.length + 2).replace(/, \w+ '.*'$/s, "");
  }
  return message;
}

// What's at a remote path, following symbolic links, or null if nothing is.
async function remoteType(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<RemoteFileType | null> {
  try {
    const attrs = await call<Stats>((done) => sftp.stat(remotePath, done));
    return fileType(attrs.mode);
  } catch (err) {
    if ((err as { code?: unknown }).code === SFTP_NO_SUCH_FILE) return null;
    throw err;
  }
}

// `localPaths` come from the open panel (see ipc-handlers.ts), or from the
// preload, which reads them off dropped File objects; a File that isn't on
// disk (e.g. from a web page) has an empty one.
export async function prepareUpload(
  sessionId: string,
  localPaths: string[],
  remoteDir: string
): Promise<UploadSummary> {
  const session = sessionOrThrow(sessionId);
  checkPath(remoteDir);
  if (!Array.isArray(localPaths) || localPaths.length === 0) {
    throw new Error("Nothing to upload");
  }
  if (
    localPaths.some(
      (p) => typeof p !== "string" || !path.isAbsolute(p) || p.includes("\0")
    )
  ) {
    throw new Error("Only files and folders on this Mac can be uploaded. Drag them from Finder.");
  }

  const upload: Upload = {
    sessionId,
    folders: [],
    files: [],
    bytesTotal: 0,
    state: "ready",
  };
  const items: UploadItem[] = [];
  const skipped: string[] = [];

  const addFile = (localPath: string, remotePath: string, display: string, size: number) => {
    upload.files.push({ localPath, remotePath, display, size });
    upload.bytesTotal += size;
  };

  // Adds a folder and everything inside it. lstat-based (Dirent) types, so
  // symbolic links inside are skipped rather than followed.
  async function addFolder(localPath: string, remotePath: string, display: string) {
    upload.folders.push({ remotePath, display });
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(localPath, { withFileTypes: true });
    } catch (err) {
      throw new Error(`Couldn't read “${display}”: ${errorText(err)}`);
    }
    for (const entry of entries) {
      if (SKIPPED_NAMES.has(entry.name)) continue;
      const childLocal = path.join(localPath, entry.name);
      const childRemote = path.posix.join(remotePath, entry.name);
      const childDisplay = `${display}/${entry.name}`;
      if (entry.isDirectory()) {
        await addFolder(childLocal, childRemote, childDisplay);
      } else if (entry.isFile()) {
        let size: number;
        try {
          ({ size } = await fs.promises.lstat(childLocal));
        } catch (err) {
          throw new Error(`Couldn't read “${childDisplay}”: ${errorText(err)}`);
        }
        addFile(childLocal, childRemote, childDisplay, size);
      } else {
        skipped.push(childDisplay);
      }
    }
  }

  for (const localPath of localPaths) {
    const name = path.basename(localPath);
    if (!name || name === "." || name === "..") {
      throw new Error(`“${localPath}” can't be uploaded`);
    }
    if (items.some((item) => item.name === name)) {
      throw new Error(`Two of the items are named “${name}”. Upload them separately.`);
    }
    // stat, not lstat: an item dropped by itself is uploaded even if it's a
    // symbolic link (also like `sftp put`).
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(localPath);
    } catch (err) {
      throw new Error(`Couldn't read “${name}”: ${errorText(err)}`);
    }
    const remotePath = path.posix.join(remoteDir, name);
    if (stats.isDirectory()) {
      await addFolder(localPath, remotePath, name);
    } else if (stats.isFile()) {
      addFile(localPath, remotePath, name, stats.size);
    } else {
      throw new Error(`“${name}” isn't a file or folder, so it can't be uploaded`);
    }
    items.push({ name, isDirectory: stats.isDirectory(), exists: false });
  }

  // A file can't replace a folder or the other way round, so refuse that
  // now rather than partway through.
  const sftp = await getSftp(session);
  await Promise.all(
    items.map(async (item) => {
      const type = await remoteType(sftp, path.posix.join(remoteDir, item.name));
      if (type === null) return;
      if ((type === "directory") !== item.isDirectory) {
        const [mine, theirs] = item.isDirectory ? ["folder", "file"] : ["file", "folder"];
        throw new Error(
          `There's already a ${theirs} named “${item.name}” in this folder on the server, so your ${mine} can't be uploaded. Rename one of them first.`
        );
      }
      item.exists = true;
    })
  );

  const id = crypto.randomUUID();
  uploads.set(id, upload);
  return {
    id,
    items,
    filesTotal: upload.files.length,
    bytesTotal: upload.bytesTotal,
    skipped,
  };
}

// A folder that's already there is used as it is, keeping its other files.
async function makeUploadFolder(sftp: SFTPWrapper, folder: UploadFolder) {
  try {
    await call<void>((done) => sftp.mkdir(folder.remotePath, done));
  } catch (err) {
    const type = await remoteType(sftp, folder.remotePath).catch(() => null);
    if (type === "directory") return;
    throw new Error(
      type
        ? `Couldn't create the folder “${folder.display}”: a file with that name is in the way.`
        : `Couldn't create the folder “${folder.display}”: ${errorText(err)}`
    );
  }
}

// Sends a prepared upload. Stops at the first error, which names the file.
export async function startUpload(
  uploadId: string,
  onProgress: (progress: UploadProgress) => void
): Promise<UploadResult> {
  const upload = uploads.get(uploadId);
  if (!upload || upload.state !== "ready") throw new Error("Unknown upload");
  upload.state = "running";
  try {
    const sftp = await getSftp(sessionOrThrow(upload.sessionId));
    const { folders, files } = upload;
    const keepGoing = () => upload.state === "running";

    let foldersDone = 0;
    let filesDone = 0;
    let bytesOfFilesDone = 0;
    const inFlight = new Map<UploadFile, number>(); // bytes sent so far
    let current: string | null = null;
    let lastReport = 0;
    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - lastReport < 100) return; // ~10 updates a second
      lastReport = now;
      let bytesDone = bytesOfFilesDone;
      for (const sent of inFlight.values()) bytesDone += sent;
      onProgress({
        filesDone,
        filesTotal: files.length,
        bytesDone,
        bytesTotal: upload.bytesTotal,
        current,
      });
    };

    for (const folder of folders) {
      if (!keepGoing()) break;
      current = folder.display;
      report();
      await makeUploadFolder(sftp, folder);
      foldersDone++;
    }

    let next = 0;
    let failure: Error | null = null;
    // Each worker sends one file at a time until none are left. On an error
    // or Stop, the others finish the file they're on and then end, so nothing
    // is still being written once this returns.
    const worker = async () => {
      while (keepGoing() && !failure && next < files.length) {
        const file = files[next++];
        current = file.display;
        inFlight.set(file, 0);
        report();
        try {
          await call<void>((done) =>
            sftp.fastPut(
              file.localPath,
              file.remotePath,
              {
                step: (sent) => {
                  inFlight.set(file, sent);
                  report();
                },
              },
              done
            )
          );
        } catch (err) {
          failure ??= new Error(`Couldn't upload “${file.display}”: ${errorText(err)}`);
          return;
        } finally {
          inFlight.delete(file);
        }
        filesDone++;
        bytesOfFilesDone += file.size;
        report();
      }
    };
    await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
    // Exact final counts, also after an error (the window says how many
    // files made it). IPC keeps order, so this arrives before the result.
    current = null;
    report(true);
    if (failure) throw failure;
    return {
      filesDone,
      stopped: foldersDone < folders.length || filesDone < files.length,
    };
  } finally {
    uploads.delete(uploadId);
  }
}

// Stops a running upload once the files being sent right now are done (so
// no file is left half-written), or forgets one that hasn't started.
export function cancelUpload(uploadId: string): void {
  const upload = uploads.get(uploadId);
  if (!upload) return;
  if (upload.state === "ready") uploads.delete(uploadId);
  else upload.state = "stopping";
}

// --- Downloading files and folders, with progress ---
//
// In three steps, so the user is asked everything before anything is saved:
// prepareDownload() asks where to save the file or folder (and the window
// then asks before adding to a folder that's already there); scanDownload()
// lists everything inside a folder; startDownload() fetches it all. Stop
// takes effect at once.

interface DownloadFolder {
  localPath: string;
  display: string; // relative to where it's saved, e.g. "backup/logs"
}

interface DownloadFile extends DownloadFolder {
  remotePath: string;
  size: number; // when it was listed; files on a live server can change
}

interface ScanFolder extends DownloadFolder {
  remotePath: string;
}

interface Download {
  sessionId: string;
  remotePath: string;
  localPath: string; // of the file or folder
  isDirectory: boolean;
  folders: DownloadFolder[]; // parents before their subfolders
  files: DownloadFile[];
  bytesTotal: number;
  skipped: SkippedItem[];
  // "chosen": a folder whose contents haven't been listed yet.
  state: "chosen" | "scanning" | "ready" | "running" | "stopping";
}

const downloads = new Map<string, Download>();
// Where finished downloads were saved, for Show in Finder.
const savedDownloads = new Map<string, string>();

// Inside a downloaded folder, but not saved.
export interface SkippedItem {
  path: string; // relative to where it's saved; folders end in "/"
  reason: string;
}

export interface DownloadTarget {
  id: string;
  name: string;
  isDirectory: boolean;
  savedAs: string; // where it's going, with "~" for the home folder
  // A folder with this name is already there. The downloaded files are added
  // to it, replacing any with the same names, so the window asks first.
  exists: boolean;
}

export interface DownloadSummary {
  filesTotal: number;
  bytesTotal: number;
}

export interface DownloadScanProgress {
  filesFound: number;
  bytesFound: number;
}

export interface DownloadProgress {
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  current: string | null; // the file data came in for last
}

export interface DownloadResult {
  filesDone: number;
  bytesDone: number;
  stopped: boolean; // by the user, before everything was saved
  skipped: SkippedItem[];
}

// As in ssh2's fastGet: 32 KB requests, at most 64 of them waiting for the
// server at once (here over all the files being fetched).
const DOWNLOAD_CHUNK_SIZE = 32 * 1024;
const DOWNLOAD_REQUESTS = 64;
// Files fetched at the same time, and folders listed at the same time. Helps
// most with many small files, where each one costs a few round trips.
const DOWNLOAD_CONCURRENCY = 8;
const SCAN_CONCURRENCY = 8;

// Files inside a downloaded folder are created, or emptied if already there,
// but never written through a symbolic link, which could point anywhere.
const FOLDER_FILE_FLAGS =
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;

// The server's file got shorter while it was being downloaded.
class FileShrank extends Error {}

// Why an item inside a folder can't be downloaded, if the problem is with
// just that item: it was deleted since the folder was listed, this login may
// not read it, or it changed while downloading. These skip the item. Null
// for anything else (a full disk, a lost connection…), which stops the whole
// download.
function itemProblem(err: unknown): string | null {
  if (err instanceof FileShrank) return "it changed on the server while downloading";
  const code = (err as { code?: unknown } | null)?.code;
  if (code === SFTP_NO_SUCH_FILE) return "it's no longer on the server";
  if (code === SFTP_PERMISSION_DENIED) return "permission denied";
  return null;
}

// A name from a folder listing that can't lead outside the folder when
// saved. Servers never send others, so one that does isn't trusted.
function isPlainName(name: string): boolean {
  return (
    name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0")
  );
}

// Names a Mac's disk sees as the same: unless set up otherwise, it ignores
// upper and lower case, and how accented letters are encoded.
function macName(name: string): string {
  return name.normalize("NFD").toLowerCase();
}

// "/Users/me/Downloads/x" → "~/Downloads/x".
function homeRelative(localPath: string): string {
  const home = os.homedir();
  return localPath.startsWith(`${home}/`) ? `~${localPath.slice(home.length)}` : localPath;
}

// Buffers for read requests: one for each request waiting for the server.
// take() waits while all are in use, which caps the requests in flight over
// all the files being fetched, so Stop only waits for those (2 MB at most).
// Buffers go to the waiting file that was listed first (lowest `priority`):
// files then finish one after another rather than all near the end, so Stop
// keeps all but the last few; small ones still go several at a time.
interface ReadBuffers {
  take(priority: number): Promise<Buffer>;
  give(buffer: Buffer): void;
}

function readBuffers(count: number): ReadBuffers {
  const free: Buffer[] = [];
  const waiting: { priority: number; resolve: (buffer: Buffer) => void }[] = [];
  let made = 0;
  return {
    take(priority) {
      let buffer = free.pop();
      if (!buffer && made < count) {
        made++;
        buffer = Buffer.allocUnsafe(DOWNLOAD_CHUNK_SIZE);
      }
      if (buffer) return Promise.resolve(buffer);
      return new Promise((resolve) => waiting.push({ priority, resolve }));
    },
    give(buffer) {
      if (waiting.length === 0) {
        free.push(buffer);
        return;
      }
      let first = 0; // the earliest of the highest priority
      for (let i = 1; i < waiting.length; i++) {
        if (waiting[i].priority < waiting[first].priority) first = i;
      }
      waiting.splice(first, 1)[0].resolve(buffer);
    },
  };
}

// Opens the local file to save into (creating or emptying it), saying what's
// in the way if that fails.
async function openLocalFile(localPath: string, flags: string | number) {
  try {
    return await fs.promises.open(localPath, flags);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "EISDIR") throw new Error("there's a folder with that name in the way");
    if (code === "ELOOP") throw new Error("there's a symbolic link with that name in the way");
    throw err;
  }
}

// Copies a remote file to a local one, several requests at a time, like
// ssh2's fastGet, but checking `stopped()` before each new request: stopping
// then only waits for the requests already sent, and the channel stays
// usable. (Closing the channel instead relies on the server answering
// promptly, and in testing it sometimes didn't.) The local file is opened,
// so created or emptied, only once its data starts to arrive, and is removed
// again unless all of it does. Resolves with the size, or null if stopped
// first.
async function fetchFile(
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string,
  localFlags: string | number,
  buffers: ReadBuffers,
  priority: number,
  stopped: () => boolean,
  onBytes: (received: number) => void
): Promise<number | null> {
  const handle = await sftpCall<Buffer>(sftp, (done) => sftp.open(remotePath, "r", done));
  // Opened by the first worker to get a buffer (see below). Typed with `as`,
  // since TypeScript can't see it being set inside localFile().
  let opening = null as Promise<fs.promises.FileHandle> | null;
  const localFile = () => (opening ??= openLocalFile(localPath, localFlags));
  let saved = false;
  try {
    const { size } = await sftpCall<Stats>(sftp, (done) => sftp.fstat(handle, done));
    let next = 0; // where the next request starts
    let received = 0;
    let failure: Error | null = null;
    // Each worker keeps one buffer, and one request in flight, until there's
    // nothing left to ask for.
    const worker = async () => {
      if (failure || stopped() || next >= size) return;
      const buffer = await buffers.take(priority);
      try {
        // Again: things may have changed while waiting for the buffer.
        if (failure || stopped() || next >= size) return;
        const file = await localFile();
        while (!failure && !stopped() && next < size) {
          let position = next;
          let length = Math.min(DOWNLOAD_CHUNK_SIZE, size - position);
          next += length;
          // The server may send less than asked for: ask again for the rest.
          while (length > 0) {
            const count = await sftpCall<number>(sftp, (done) =>
              sftp.read(handle, buffer, 0, length, position, (err, bytesRead) =>
                done(err, bytesRead)
              )
            );
            if (count === 0) throw new FileShrank("the file got shorter while downloading");
            await file.write(buffer, 0, count, position);
            position += count;
            length -= count;
            received += count;
            onBytes(received);
          }
        }
      } catch (err) {
        failure ??= err instanceof Error ? err : new Error(String(err));
      } finally {
        buffers.give(buffer);
      }
    };
    const workers = Math.min(DOWNLOAD_REQUESTS, Math.ceil(size / DOWNLOAD_CHUNK_SIZE));
    await Promise.all(Array.from({ length: workers }, worker));
    if (failure) throw failure;
    if (received < size) return null; // stopped
    const file = await localFile(); // also for an empty file, with nothing to fetch
    await file.close();
    saved = true;
    return size;
  } finally {
    if (opening && !saved) {
      const file = await opening.catch(() => null);
      if (file) {
        await file.close().catch(() => {});
        await fs.promises.rm(localPath, { force: true }).catch(() => {});
      }
    }
    closeHandle(sftp, handle);
  }
}

export async function prepareDownload(
  sessionId: string,
  remotePath: string,
  // Asks the user where to save the file or folder: its local path, or null
  // if they cancel.
  chooseLocalPath: (name: string, isDirectory: boolean) => Promise<string | null>
): Promise<DownloadTarget | null> {
  const session = sessionOrThrow(sessionId);
  checkPath(remotePath);
  const name = path.posix.basename(remotePath);
  if (!name) throw new Error("The whole server can't be downloaded at once. Download the folders in it instead.");
  const sftp = await getSftp(session);
  // stat, not lstat: a symbolic link downloads what it points to.
  const attrs = await sftpCall<Stats>(sftp, (done) => sftp.stat(remotePath, done));
  const type = fileType(attrs.mode);
  if (type !== "file" && type !== "directory") {
    throw new Error("Only files and folders can be downloaded");
  }
  const isDirectory = type === "directory";
  const localPath = await chooseLocalPath(name, isDirectory);
  if (!localPath) return null;

  // For a file, the save panel has already asked about replacing one.
  let exists = false;
  if (isDirectory) {
    const stats = await fs.promises.lstat(localPath).catch(() => null);
    if (stats && !stats.isDirectory()) {
      throw new Error(
        `There's already a file named “${name}” there, so the folder can't be saved next to it. Choose another place, or rename the file first.`
      );
    }
    exists = stats !== null;
  }

  const id = crypto.randomUUID();
  downloads.set(id, {
    sessionId,
    remotePath,
    localPath,
    isDirectory,
    folders: [],
    files: isDirectory ? [] : [{ remotePath, localPath, display: name, size: attrs.size }],
    bytesTotal: isDirectory ? 0 : attrs.size,
    skipped: [],
    state: isDirectory ? "chosen" : "ready",
  });
  return { id, name, isDirectory, savedAs: homeRelative(localPath), exists };
}

// Lists everything inside a folder being downloaded, several folders at a
// time. Symbolic links and special files inside aren't downloaded (as with
// OpenSSH's `sftp get -R`), and neither are subfolders this login can't open.
// A file needs nothing listing: this resolves at once. Resolves null if
// stopped first, as the window was closed.
export async function scanDownload(
  downloadId: string,
  onProgress: (progress: DownloadScanProgress) => void
): Promise<DownloadSummary | null> {
  const download = downloads.get(downloadId);
  if (!download || (download.state !== "chosen" && download.state !== "ready")) {
    throw new Error("Unknown download");
  }
  if (download.state === "chosen") {
    download.state = "scanning";
    const stopped = () => download.state === "stopping"; // see cancelDownload()
    try {
      await listDownloadFolder(download, onProgress);
    } catch (err) {
      downloads.delete(downloadId);
      // Stopped by a disconnect, which also fails the requests in flight.
      if (stopped()) return null;
      throw err;
    }
    if (stopped()) {
      downloads.delete(downloadId);
      return null;
    }
    download.state = "ready";
  }
  return { filesTotal: download.files.length, bytesTotal: download.bytesTotal };
}

async function listDownloadFolder(
  download: Download,
  onProgress: (progress: DownloadScanProgress) => void
) {
  const sftp = await getSftp(sessionOrThrow(download.sessionId));
  const keepGoing = () => download.state === "scanning";
  const top: ScanFolder = {
    remotePath: download.remotePath,
    localPath: download.localPath,
    display: path.posix.basename(download.remotePath),
  };
  download.folders.push(top);
  let lastReport = 0;
  const report = () => {
    const now = Date.now();
    if (now - lastReport < 100) return; // ~10 updates a second
    lastReport = now;
    onProgress({ filesFound: download.files.length, bytesFound: download.bytesTotal });
  };

  // Lists one folder, adding what's in it; resolves with its subfolders.
  const list = async (folder: ScanFolder): Promise<ScanFolder[]> => {
    let entries: FileEntryWithStats[];
    try {
      entries = await readFolder(sftp, folder.remotePath);
    } catch (err) {
      const problem = itemProblem(err);
      if (folder === top || !problem) {
        throw new Error(`Couldn't open “${folder.display}”: ${errorText(err)}`);
      }
      download.skipped.push({ path: `${folder.display}/`, reason: problem });
      return [];
    }
    // In a fixed order, so the same one of two names a Mac can't tell apart
    // is kept each time.
    entries.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    const taken = new Map<string, string>(); // macName() → name, of items kept
    const subfolders: ScanFolder[] = [];
    for (const { filename: name, attrs: listed } of entries) {
      const display = `${folder.display}/${name}`;
      if (!isPlainName(name)) {
        download.skipped.push({ path: display, reason: "the server sent a name that isn't allowed" });
        continue;
      }
      const remotePath = path.posix.join(folder.remotePath, name);
      // A server that leaves the type or size out of listings is asked.
      let attrs = listed;
      if (typeof attrs.mode !== "number" || typeof attrs.size !== "number") {
        try {
          attrs = await sftpCall<Stats>(sftp, (done) => sftp.lstat(remotePath, done));
        } catch (err) {
          const problem = itemProblem(err);
          if (!problem) throw new Error(`Couldn't open “${display}”: ${errorText(err)}`);
          download.skipped.push({ path: display, reason: problem });
          continue;
        }
      }
      const type = fileType(attrs.mode);
      if (type === "symlink" || type === "other") {
        download.skipped.push({
          path: display,
          reason: type === "symlink" ? "symbolic link" : "special file",
        });
        continue;
      }
      const isDirectory = type === "directory";
      const other = taken.get(macName(name));
      if (other !== undefined) {
        download.skipped.push({
          path: isDirectory ? `${display}/` : display,
          reason: `a Mac sees it as the same name as “${other}”`,
        });
        continue;
      }
      taken.set(macName(name), name);
      const localPath = path.join(folder.localPath, name);
      if (isDirectory) {
        const subfolder = { remotePath, localPath, display };
        download.folders.push(subfolder);
        subfolders.push(subfolder);
      } else {
        download.files.push({ remotePath, localPath, display, size: attrs.size });
        download.bytesTotal += attrs.size;
      }
    }
    return subfolders;
  };

  // Lists folders as they're found, a few at a time, until all are listed, or
  // one fails, or Stop. Each is added to `download.folders` when its parent is
  // listed, so parents always come before their subfolders.
  const pending: ScanFolder[] = [top];
  let running = 0;
  let failure: unknown = null;
  await new Promise<void>((resolve) => {
    const pump = () => {
      while (!failure && keepGoing() && pending.length > 0 && running < SCAN_CONCURRENCY) {
        const folder = pending.pop()!;
        running++;
        list(folder)
          .then(
            (subfolders) => {
              pending.push(...subfolders);
              report();
            },
            (err) => {
              failure ??= closedChannels.has(sftp) ? new Error(CONNECTION_LOST) : err;
            }
          )
          .finally(() => {
            running--;
            pump();
          });
      }
      if (running === 0) resolve();
    };
    pump();
  });
  if (failure) throw failure;
}

// A folder that's already there is used as it is, keeping what's in it.
async function makeDownloadFolder(folder: DownloadFolder) {
  try {
    await fs.promises.mkdir(folder.localPath);
  } catch (err) {
    const stats = await fs.promises.lstat(folder.localPath).catch(() => null);
    if (stats?.isDirectory()) return;
    throw new Error(
      stats
        ? `Couldn't create the folder “${folder.display}”: there's a file with that name in the way.`
        : `Couldn't create the folder “${folder.display}”: ${errorText(err)}`
    );
  }
}

// Fetches a prepared download: a folder's subfolders first, then its files,
// a few at a time. A problem with one file inside a folder (see
// itemProblem()) skips just that file; anything else stops the download,
// with an error naming the file.
//
// A file goes straight to where the user chose, as before: a temporary file
// next to it could set off macOS's folder access prompt (Downloads, Desktop,
// Documents), which the save panel's choice doesn't cover.
export async function startDownload(
  downloadId: string,
  onProgress: (progress: DownloadProgress) => void
): Promise<DownloadResult> {
  const download = downloads.get(downloadId);
  if (!download || download.state !== "ready") throw new Error("Unknown download");
  download.state = "running";
  const keepGoing = () => download.state === "running"; // see cancelDownload()
  const { folders, files } = download;
  const skipped = [...download.skipped];

  let foldersDone = 0;
  let filesDone = 0;
  let filesSkipped = 0;
  let bytesOfFilesDone = 0;
  // Less what's skipped, and corrected for files that changed since listed.
  let bytesTotal = download.bytesTotal;
  const inFlight = new Map<DownloadFile, number>(); // bytes received so far
  let current: string | null = null;
  let lastReport = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (!force && now - lastReport < 100) return; // ~10 updates a second
    lastReport = now;
    let bytesDone = bytesOfFilesDone;
    for (const received of inFlight.values()) bytesDone += received;
    onProgress({ filesDone, filesTotal: files.length, bytesDone, bytesTotal, current });
  };
  const result = (stopped: boolean): DownloadResult => ({
    filesDone,
    bytesDone: bytesOfFilesDone,
    stopped,
    skipped,
  });

  try {
    const sftp = await getSftp(sessionOrThrow(download.sessionId));
    for (const folder of folders) {
      if (!keepGoing()) break;
      await makeDownloadFolder(folder);
      foldersDone++;
    }

    const buffers = readBuffers(DOWNLOAD_REQUESTS);
    const localFlags = download.isDirectory ? FOLDER_FILE_FLAGS : "w";
    let next = 0;
    let failure: Error | null = null;
    const stopped = () => !keepGoing() || failure !== null;
    // Each worker fetches one file at a time until none are left, in the
    // order they were listed (see readBuffers()). On an error or Stop, the
    // files being fetched stop too (and their partial files are removed), so
    // nothing is still being written once this returns.
    const worker = async () => {
      while (!stopped() && next < files.length) {
        const index = next++;
        const file = files[index];
        current ??= file.display;
        inFlight.set(file, 0);
        report();
        let size: number | null;
        try {
          size = await fetchFile(
            sftp,
            file.remotePath,
            file.localPath,
            localFlags,
            buffers,
            index,
            stopped,
            (received) => {
              // Not the file started last: that one may be waiting its turn.
              current = file.display;
              inFlight.set(file, received);
              report();
            }
          );
        } catch (err) {
          const problem = download.isDirectory ? itemProblem(err) : null;
          if (problem && keepGoing()) {
            skipped.push({ path: file.display, reason: problem });
            filesSkipped++;
            bytesTotal -= file.size;
            continue;
          }
          failure ??= closedChannels.has(sftp)
            ? new Error(CONNECTION_LOST)
            : new Error(`Couldn't download “${file.display}”: ${errorText(err)}`);
          return;
        } finally {
          inFlight.delete(file);
        }
        if (size === null) return; // stopped
        filesDone++;
        bytesOfFilesDone += size;
        bytesTotal += size - file.size;
        report();
      }
    };
    await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker));
    // Exact final counts, also after an error (the window says how many
    // files were saved). IPC keeps order, so this arrives before the result.
    current = null;
    report(true);
    if (failure && keepGoing()) throw failure;
    const finished =
      foldersDone === folders.length && filesDone + filesSkipped === files.length;
    if (finished) savedDownloads.set(downloadId, download.localPath);
    return result(!finished);
  } catch (err) {
    // Stopped by a disconnect, which also fails the requests in flight.
    if (!keepGoing()) return result(true);
    throw err;
  } finally {
    downloads.delete(downloadId);
  }
}

// Stops a download being listed or fetched: at once, apart from the requests
// already sent. Files already saved are kept; partial ones are removed. Or
// forgets one that hasn't started.
export function cancelDownload(downloadId: string): void {
  const download = downloads.get(downloadId);
  if (!download) return;
  if (download.state === "chosen" || download.state === "ready") downloads.delete(downloadId);
  else download.state = "stopping";
}

export function savedDownload(downloadId: string): string | null {
  return savedDownloads.get(downloadId) ?? null;
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
const SFTP_PERMISSION_DENIED = 3;

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
