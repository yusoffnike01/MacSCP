// IPC surface exposed to the renderer (via preload.ts contextBridge).
// This is the choke point where Touch ID gating is enforced before any
// SSH connect ever happens — the renderer can never bypass it because
// it has no direct access to fs, keytar, or ssh2.

import {
  ipcMain,
  dialog,
  clipboard,
  Menu,
  BrowserWindow,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
  type OpenDialogOptions,
  type SaveDialogOptions,
  type WebContents,
} from "electron";
import {
  listConnections,
  createConnection,
  deleteConnection,
  touchLastUsed,
  getConnection,
  updateConnection,
  setTrustedHostKey,
  type ConnectionChanges,
  type ServerConnection,
} from "./db";
import { requestTouchId } from "./touchid";
import { getPassphrase, setPassphrase, deletePassphrase } from "./keychain";
import * as ssh from "./ssh";

// Dialogs attach to the window that asked. There is no fixed "main" window:
// on macOS it can be closed and a new one opened from the Dock.
function showOpenDialog(sender: WebContents, options: OpenDialogOptions) {
  const win = BrowserWindow.fromWebContents(sender);
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
}

function showSaveDialog(sender: WebContents, options: SaveDialogOptions) {
  const win = BrowserWindow.fromWebContents(sender);
  return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options);
}

// Connects to a saved server. If its host key isn't trusted yet, or doesn't
// match the trusted one, the user is asked first (like WinSCP, PuTTY and
// OpenSSH); a key they accept is remembered for next time.
async function connectTrusted(
  sender: WebContents,
  conn: ServerConnection,
  passphrase: string | null
): Promise<string> {
  if (!conn.key_path) throw new Error("No SSH key file is set for this server");
  const params = {
    host: conn.host,
    port: conn.port,
    username: conn.username,
    privateKeyPath: conn.key_path,
    passphrase,
  };
  // Tell the window if the connection drops later, so it stops showing the
  // server as connected.
  const onDropped = (sessionId: string) => {
    if (!sender.isDestroyed()) sender.send("ssh:dropped", sessionId);
  };
  try {
    return await ssh.connect(
      { ...params, trustedHostKey: conn.host_key_sha256 },
      onDropped
    );
  } catch (err) {
    if (!(err instanceof ssh.HostKeyError)) throw err;
    if (!(await confirmHostKey(sender, conn, err))) throw new Error("HOST_KEY_REJECTED");
    setTrustedHostKey(conn.id, err.fingerprint);
    return ssh.connect({ ...params, trustedHostKey: err.fingerprint }, onDropped);
  }
}

async function confirmHostKey(
  sender: WebContents,
  conn: ServerConnection,
  key: ssh.HostKeyError
): Promise<boolean> {
  const address = `${conn.host}:${conn.port}`;
  const algorithm = key.keyType.includes("ed25519")
    ? "ed25519"
    : key.keyType.startsWith("ecdsa")
      ? "ecdsa"
      : key.keyType.includes("rsa")
        ? "rsa"
        : null;
  const keyLabel = algorithm ? algorithm.toUpperCase() : key.keyType;
  const options: MessageBoxOptions = key.previous
    ? {
        type: "warning",
        message: `The identity of “${conn.name}” has changed`,
        detail: [
          `The host key sent by ${address} is not the one you trusted before.`,
          "",
          "Someone may be intercepting the connection (a man-in-the-middle attack), or the server was reinstalled or its keys were replaced.",
          "",
          `Trusted before: ${key.previous}`,
          `Sent now: ${key.fingerprint} (${keyLabel})`,
          "",
          "Only continue if you know why the key changed.",
        ].join("\n"),
        buttons: ["Cancel", "Trust New Key"],
        defaultId: 0,
        cancelId: 0,
      }
    : {
        type: "question",
        message: `Trust “${conn.name}”?`,
        detail: [
          `This is the first connection to ${address}. Its host key fingerprint is:`,
          "",
          `${key.fingerprint} (${keyLabel})`,
          "",
          "To check it is the right server, compare it with the output of this command on the server:",
          `ssh-keygen -lf /etc/ssh/ssh_host_${algorithm ?? "ed25519"}_key.pub`,
        ].join("\n"),
        buttons: ["Cancel", "Trust and Connect"],
        defaultId: 1,
        cancelId: 0,
      };
  const win = BrowserWindow.fromWebContents(sender);
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  return response === 1;
}

// Call once at startup (ipcMain allows a single handler per channel).
export function registerIpcHandlers() {
  ipcMain.handle("connections:list", () => listConnections());

  ipcMain.handle("connections:create", (_evt, input) => createConnection(input));

  ipcMain.handle(
    "connections:update",
    (_evt, id: string, changes: ConnectionChanges) => updateConnection(id, changes)
  );

  ipcMain.handle("connections:delete", async (_evt, id: string) => {
    await deletePassphrase(id);
    deleteConnection(id);
  });

  ipcMain.handle("connections:set-passphrase", async (_evt, id: string, passphrase: string) => {
    // Called once during setup, right after the user generates/imports a key.
    // Not gated by Touch ID itself — the GATE is on retrieval, not storage.
    await setPassphrase(id, passphrase);
  });

  ipcMain.handle("connections:pick-key-file", async (evt) => {
    const result = await showOpenDialog(evt.sender, {
      title: "Choose your SSH private key",
      properties: ["openFile", "showHiddenFiles"],
      defaultPath: require("node:os").homedir() + "/.ssh",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // --- Connect flow: Touch ID gate -> Keychain passphrase -> ssh2 connect ---
  ipcMain.handle("ssh:connect", async (evt, connectionId: string) => {
    const conn = getConnection(connectionId);
    if (!conn) throw new Error("Connection not found");

    const touchIdResult = await requestTouchId(
      `Confirm access to ${conn.name} (${conn.host})`
    );
    if (touchIdResult === "fail") {
      throw new Error("TOUCHID_DENIED");
    }
    // "unavailable" (no biometric hardware/enrollment) falls through to
    // the renderer, which must then prompt the user to type the
    // passphrase manually instead of silently connecting.
    let passphrase: string | null = null;
    if (touchIdResult === "ok") {
      passphrase = conn.key_path ? await getPassphrase(connectionId) : null;
    } else {
      throw new Error("TOUCHID_UNAVAILABLE");
    }

    const sessionId = await connectTrusted(evt.sender, conn, passphrase);
    touchLastUsed(connectionId);
    return sessionId;
  });

  ipcMain.handle(
    "ssh:connect-with-passphrase",
    async (evt, connectionId: string, passphrase: string) => {
      // Manual fallback path when Touch ID is unavailable or the user
      // opts to type the passphrase directly. Still never written to disk.
      const conn = getConnection(connectionId);
      if (!conn) throw new Error("Connection not found");

      const sessionId = await connectTrusted(evt.sender, conn, passphrase);
      touchLastUsed(connectionId);
      return sessionId;
    }
  );

  ipcMain.handle("ssh:disconnect", (_evt, sessionId: string) => {
    ssh.disconnect(sessionId);
  });

  ipcMain.handle(
    "ssh:open-shell",
    (evt, sessionId: string, cols: number, rows: number) => {
      // Reply to the renderer that opened the shell, and stop sending once its
      // window is gone (output can still arrive while the app is closing).
      const sender = evt.sender;
      const send = (channel: string, ...args: unknown[]) => {
        if (!sender.isDestroyed()) sender.send(channel, ...args);
      };
      return ssh.openShell(
        sessionId,
        { cols: cols || 80, rows: rows || 24 },
        (chunk) => send(`ssh:data:${sessionId}`, chunk.toString("utf-8")),
        () => send(`ssh:closed:${sessionId}`)
      );
    }
  );

  ipcMain.on("ssh:write", (_evt, sessionId: string, data: string) => {
    ssh.writeToShell(sessionId, data);
  });

  ipcMain.on("ssh:resize", (_evt, sessionId: string, cols: number, rows: number) => {
    ssh.resizeShell(sessionId, cols, rows);
  });

  ipcMain.handle("sftp:list", (_evt, sessionId: string, remotePath: string) => {
    return ssh.listDirectory(sessionId, remotePath);
  });

  ipcMain.handle(
    "sftp:download",
    async (evt, sessionId: string, remotePath: string) => {
      const result = await showSaveDialog(evt.sender, {
        defaultPath: remotePath.split("/").pop(),
      });
      if (result.canceled || !result.filePath) return null;
      await ssh.downloadFile(sessionId, remotePath, result.filePath);
      return result.filePath;
    }
  );

  ipcMain.handle(
    "sftp:upload",
    async (evt, sessionId: string, remoteDir: string) => {
      const result = await showOpenDialog(evt.sender, {
        properties: ["openFile"],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const localPath = result.filePaths[0];
      const fileName = localPath.split("/").pop();
      const remotePath = `${remoteDir.replace(/\/$/, "")}/${fileName}`;
      await ssh.uploadFile(sessionId, localPath, remotePath);
      return remotePath;
    }
  );

  ipcMain.handle("sftp:stat", (_evt, sessionId: string, remotePath: string) => {
    return ssh.statPath(sessionId, remotePath);
  });

  ipcMain.handle("sftp:principals", (_evt, sessionId: string) => {
    return ssh.listPrincipals(sessionId);
  });

  ipcMain.handle(
    "sftp:set-properties",
    (_evt, sessionId: string, remotePath: string, changes: ssh.PropertyChanges) => {
      return ssh.setProperties(sessionId, remotePath, changes);
    }
  );

  ipcMain.handle(
    "sftp:rename",
    (_evt, sessionId: string, fromPath: string, toPath: string) => {
      return ssh.renamePath(sessionId, fromPath, toPath);
    }
  );

  ipcMain.handle("sftp:mkdir", (_evt, sessionId: string, remotePath: string) => {
    return ssh.makeDirectory(sessionId, remotePath);
  });

  ipcMain.handle("sftp:delete", (_evt, sessionId: string, remotePath: string) => {
    return ssh.deletePath(sessionId, remotePath);
  });

  ipcMain.handle("sftp:read-text", (_evt, sessionId: string, remotePath: string) => {
    return ssh.readTextFile(sessionId, remotePath);
  });

  ipcMain.handle(
    "sftp:write-text",
    (
      _evt,
      sessionId: string,
      remotePath: string,
      content: string,
      options: ssh.SaveTextOptions
    ) => {
      return ssh.writeTextFile(sessionId, remotePath, content, options);
    }
  );

  // --- Small UI helpers the sandboxed renderer can't do itself ---

  ipcMain.handle("ui:context-menu", (evt, items: ContextMenuItem[]) => {
    return popupContextMenu(evt.sender, items);
  });

  ipcMain.handle("ui:copy-text", (_evt, text: string) => {
    clipboard.writeText(String(text));
  });
}

type ContextMenuItem =
  | { id: string; label: string; enabled?: boolean }
  | { type: "separator" };

// Shows a native context menu and resolves with the chosen item's id, or
// null if it was dismissed.
function popupContextMenu(
  sender: WebContents,
  items: ContextMenuItem[]
): Promise<string | null> {
  return new Promise((resolve) => {
    const template: MenuItemConstructorOptions[] = items.map((item) =>
      "id" in item
        ? {
            label: String(item.label),
            enabled: item.enabled !== false,
            click: () => resolve(item.id),
          }
        : { type: "separator" }
    );
    Menu.buildFromTemplate(template).popup({
      window: BrowserWindow.fromWebContents(sender) ?? undefined,
      // Electron runs a clicked item's handler before this close callback;
      // the extra tick is a safety margin, and a second resolve is a no-op.
      callback: () => setTimeout(() => resolve(null), 0),
    });
  });
}
