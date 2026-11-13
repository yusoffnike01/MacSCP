// Open with Cursor / VS Code, like WinSCP's external editor: the file is
// copied to a private folder on this Mac and opened in the editor, and every
// time it's saved there, it's sent back to the server over MacFlux's own
// connection. Before replacing a file that someone else changed on the server
// in the meantime, the user is asked.

import { app, BrowserWindow, dialog, type WebContents } from "electron";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ssh from "./ssh";

const EDITORS = {
  cursor: { name: "Cursor", bundle: "Cursor.app" },
  vscode: { name: "VS Code", bundle: "Visual Studio Code.app" },
} as const;

type EditorId = keyof typeof EDITORS;

export interface ExternalEditor {
  id: EditorId;
  name: string;
}

// What the window is told after each save in the editor.
export interface ExternalSave {
  sessionId: string;
  remotePath: string;
  // "skipped": changed on the server too, and the user chose not to replace it.
  status: "saved" | "skipped" | "error";
  message?: string;
}

// Saves are sent once the editor has stopped writing for this long: some
// write a file in several steps.
const SAVE_DELAY_MS = 300;

// Copies being edited: one private folder each, in the temporary folder.
const ROOT = path.join(app.getPath("temp"), "MacFlux-edit");

interface OpenFile {
  sessionId: string;
  remotePath: string;
  localPath: string;
  folder: string;
  editorName: string;
  sender: WebContents;
  known: ssh.RemoteVersion; // the server's version, when last fetched or sent
  sentLocal: number; // the local copy's mtimeMs when it was last fetched or sent
  watcher: fs.FSWatcher;
  timer: NodeJS.Timeout | null;
  sending: boolean;
  sendAgain: boolean; // saved again while sending
}

const openFiles = new Map<string, OpenFile>();
const fileKey = (sessionId: string, remotePath: string) => `${sessionId}\0${remotePath}`;

function findApp(bundle: string): string | null {
  for (const dir of ["/Applications", path.join(os.homedir(), "Applications")]) {
    const appPath = path.join(dir, bundle);
    if (fs.existsSync(appPath)) return appPath;
  }
  return null;
}

// The editors installed on this Mac, for the right-click menu.
export function installedEditors(): ExternalEditor[] {
  return (Object.keys(EDITORS) as EditorId[])
    .filter((id) => findApp(EDITORS[id].bundle))
    .map((id) => ({ id, name: EDITORS[id].name }));
}

function launch(appPath: string, localPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("open", ["-a", appPath, localPath], (err) => (err ? reject(err) : resolve()));
  });
}

export async function openInEditor(
  sender: WebContents,
  sessionId: string,
  remotePath: string,
  editorId: string
): Promise<void> {
  if (!Object.hasOwn(EDITORS, editorId)) throw new Error("Unknown editor");
  const editor = EDITORS[editorId as EditorId];
  const appPath = findApp(editor.bundle);
  if (!appPath) throw new Error(`${editor.name} isn't installed in Applications`);

  // Already open: show the same copy again, so saves aren't split between two.
  const existing = openFiles.get(fileKey(sessionId, remotePath));
  if (existing) {
    existing.sender = sender;
    await launch(appPath, existing.localPath);
    return;
  }

  const name = path.posix.basename(remotePath);
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const folder = fs.mkdtempSync(path.join(ROOT, `${crypto.randomUUID().slice(0, 8)}-`));
  const localPath = path.join(folder, name);
  let known: ssh.RemoteVersion;
  try {
    known = await ssh.fetchToLocal(sessionId, remotePath, localPath);
  } catch (err) {
    fs.rmSync(folder, { recursive: true, force: true });
    throw err;
  }

  // The folder, not the file: some editors save by writing a new file and
  // renaming it over the old one, which a watch on the file would miss.
  const file: OpenFile = {
    sessionId,
    remotePath,
    localPath,
    folder,
    editorName: editor.name,
    sender,
    known,
    sentLocal: fs.statSync(localPath).mtimeMs,
    watcher: fs.watch(folder, () => scheduleSend(file)),
    timer: null,
    sending: false,
    sendAgain: false,
  };
  file.watcher.on("error", () => {});
  openFiles.set(fileKey(sessionId, remotePath), file);
  await launch(appPath, localPath);
}

function scheduleSend(file: OpenFile) {
  if (file.timer) clearTimeout(file.timer);
  file.timer = setTimeout(() => {
    file.timer = null;
    void send(file);
  }, SAVE_DELAY_MS);
}

function notify(file: OpenFile, status: ExternalSave["status"], message?: string) {
  if (file.sender.isDestroyed()) return;
  const update: ExternalSave = { sessionId: file.sessionId, remotePath: file.remotePath, status, message };
  file.sender.send("sftp:external-save", update);
}

// Sends the local copy to the server if it changed since last sent.
async function send(file: OpenFile): Promise<void> {
  if (openFiles.get(fileKey(file.sessionId, file.remotePath)) !== file) return;
  if (file.sending) {
    file.sendAgain = true;
    return;
  }
  file.sending = true;
  try {
    const local = await fs.promises.stat(file.localPath).catch(() => null);
    // Gone for a moment while being replaced, or not changed (e.g. only
    // touched by the editor's own housekeeping).
    if (!local || local.mtimeMs === file.sentLocal) return;

    const current = await ssh.remoteVersion(file.sessionId, file.remotePath);
    if (!current || current.mtime !== file.known.mtime || current.size !== file.known.size) {
      if (!(await confirmReplace(file, current === null))) {
        file.sentLocal = local.mtimeMs;
        notify(file, "skipped");
        return;
      }
    }
    file.known = await ssh.sendLocalFile(file.sessionId, file.localPath, file.remotePath);
    file.sentLocal = local.mtimeMs;
    notify(file, "saved");
  } catch (err) {
    notify(file, "error", err instanceof Error ? err.message : String(err));
  } finally {
    file.sending = false;
    if (file.sendAgain) {
      file.sendAgain = false;
      void send(file);
    }
  }
}

async function confirmReplace(file: OpenFile, deleted: boolean): Promise<boolean> {
  const name = path.posix.basename(file.remotePath);
  const options = {
    type: "warning" as const,
    message: deleted
      ? `“${name}” was deleted from the server`
      : `“${name}” was changed on the server`,
    detail: deleted
      ? `It was deleted after you opened it in ${file.editorName}. Save your version to the server again?`
      : `Someone changed it after you opened it in ${file.editorName}. Replace their version with yours?`,
    buttons: ["Don't Save", deleted ? "Save" : "Replace"],
    defaultId: 0,
    cancelId: 0,
  };
  const win = file.sender.isDestroyed() ? null : BrowserWindow.fromWebContents(file.sender);
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  return response === 1;
}

// Stops watching a session's files once it's disconnected. A copy with saves
// that never reached the server is kept, so the work isn't lost; the others
// are removed.
function stopSession(sessionId: string) {
  for (const [key, file] of openFiles) {
    if (file.sessionId !== sessionId) continue;
    openFiles.delete(key);
    file.watcher.close();
    if (file.timer) clearTimeout(file.timer);
    let unsent = false;
    try {
      unsent = fs.statSync(file.localPath).mtimeMs !== file.sentLocal;
    } catch {
      // Gone already.
    }
    if (!unsent) fs.rmSync(file.folder, { recursive: true, force: true });
  }
}

ssh.onDisconnect(stopSession);
