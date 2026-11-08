// Preload: the ONLY bridge between the sandboxed renderer and the main
// process. No fs/child_process/keytar/ssh2 modules are ever exposed
// directly — only these narrow, purpose-built functions.

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  connections: {
    list: () => ipcRenderer.invoke("connections:list"),
    create: (input: unknown) => ipcRenderer.invoke("connections:create", input),
    update: (id: string, changes: unknown) =>
      ipcRenderer.invoke("connections:update", id, changes),
    delete: (id: string) => ipcRenderer.invoke("connections:delete", id),
    setPassphrase: (id: string, passphrase: string) =>
      ipcRenderer.invoke("connections:set-passphrase", id, passphrase),
    pickKeyFile: () => ipcRenderer.invoke("connections:pick-key-file"),
  },
  ssh: {
    connect: (connectionId: string) => ipcRenderer.invoke("ssh:connect", connectionId),
    connectWithPassphrase: (connectionId: string, passphrase: string) =>
      ipcRenderer.invoke("ssh:connect-with-passphrase", connectionId, passphrase),
    disconnect: (sessionId: string) => ipcRenderer.invoke("ssh:disconnect", sessionId),
    openShell: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke("ssh:open-shell", sessionId, cols, rows),
    write: (sessionId: string, data: string) => ipcRenderer.send("ssh:write", sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.send("ssh:resize", sessionId, cols, rows),
    onData: (sessionId: string, cb: (chunk: string) => void) => {
      const channel = `ssh:data:${sessionId}`;
      const listener = (_evt: unknown, chunk: string) => cb(chunk);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    onClosed: (sessionId: string, cb: () => void) => {
      const channel = `ssh:closed:${sessionId}`;
      const listener = () => cb();
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
  },
  sftp: {
    list: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke("sftp:list", sessionId, remotePath),
    download: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke("sftp:download", sessionId, remotePath),
    upload: (sessionId: string, remoteDir: string) =>
      ipcRenderer.invoke("sftp:upload", sessionId, remoteDir),
    stat: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke("sftp:stat", sessionId, remotePath),
    principals: (sessionId: string) =>
      ipcRenderer.invoke("sftp:principals", sessionId),
    setProperties: (sessionId: string, remotePath: string, changes: unknown) =>
      ipcRenderer.invoke("sftp:set-properties", sessionId, remotePath, changes),
    rename: (sessionId: string, fromPath: string, toPath: string) =>
      ipcRenderer.invoke("sftp:rename", sessionId, fromPath, toPath),
    mkdir: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke("sftp:mkdir", sessionId, remotePath),
    delete: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke("sftp:delete", sessionId, remotePath),
    readText: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke("sftp:read-text", sessionId, remotePath),
    writeText: (
      sessionId: string,
      remotePath: string,
      content: string,
      options: unknown
    ) =>
      ipcRenderer.invoke("sftp:write-text", sessionId, remotePath, content, options),
  },
  ui: {
    showContextMenu: (items: unknown) =>
      ipcRenderer.invoke("ui:context-menu", items),
    copyText: (text: string) => ipcRenderer.invoke("ui:copy-text", text),
  },
});
