// Preload: the ONLY bridge between the sandboxed renderer and the main
// process. No fs/child_process/keytar/ssh2 modules are ever exposed
// directly — only these narrow, purpose-built functions.

import { contextBridge, ipcRenderer, webUtils } from "electron";

// Calls `cb` with each message on `channel`; returns a function to stop.
function listen(channel: string, cb: (value: unknown) => void): () => void {
  const listener = (_evt: unknown, value: unknown) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("api", {
  connections: {
    list: () => ipcRenderer.invoke("connections:list"),
    create: (input: unknown) => ipcRenderer.invoke("connections:create", input),
    update: (id: string, changes: unknown) =>
      ipcRenderer.invoke("connections:update", id, changes),
    delete: (id: string) => ipcRenderer.invoke("connections:delete", id),
    setSecret: (id: string, secret: string) =>
      ipcRenderer.invoke("connections:set-secret", id, secret),
    pickKeyFile: () => ipcRenderer.invoke("connections:pick-key-file"),
  },
  ssh: {
    connect: (connectionId: string) => ipcRenderer.invoke("ssh:connect", connectionId),
    connectWithSecret: (connectionId: string, secret: string) =>
      ipcRenderer.invoke("ssh:connect-with-secret", connectionId, secret),
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
    // Any session, so a drop right after connecting isn't missed.
    onDropped: (cb: (sessionId: string) => void) => {
      const listener = (_evt: unknown, sessionId: string) => cb(sessionId);
      ipcRenderer.on("ssh:dropped", listener);
      return () => ipcRenderer.removeListener("ssh:dropped", listener);
    },
  },
  sftp: {
    list: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke("sftp:list", sessionId, remotePath),
    // Asks where to save the file or folder (resolves null if cancelled);
    // then scanDownload() lists what's in a folder, and startDownload()
    // fetches it all.
    prepareDownload: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke("sftp:prepare-download", sessionId, remotePath),
    scanDownload: (downloadId: string) => ipcRenderer.invoke("sftp:scan-download", downloadId),
    onDownloadScanProgress: (downloadId: string, cb: (progress: unknown) => void) =>
      listen(`sftp:download-scan:${downloadId}`, cb),
    startDownload: (downloadId: string) =>
      ipcRenderer.invoke("sftp:start-download", downloadId),
    cancelDownload: (downloadId: string) =>
      ipcRenderer.invoke("sftp:cancel-download", downloadId),
    onDownloadProgress: (downloadId: string, cb: (progress: unknown) => void) =>
      listen(`sftp:download-progress:${downloadId}`, cb),
    showDownload: (downloadId: string) =>
      ipcRenderer.invoke("sftp:show-download", downloadId),
    // Files and folders dropped from Finder. Their local paths are looked up
    // here, so the page never chooses local paths itself: only a File from a
    // real drop has one (a File the page makes up has an empty path).
    prepareUpload: (sessionId: string, files: File[], remoteDir: string) =>
      ipcRenderer.invoke(
        "sftp:prepare-upload",
        sessionId,
        Array.from(files, (file) => webUtils.getPathForFile(file)),
        remoteDir
      ),
    // Upload file / Upload folder: shows the open panel (resolves null if
    // cancelled). The chosen paths stay in the main process, and
    // preparePickedUpload() then does what prepareUpload() does for a drop.
    pickUpload: (what: "files" | "folders", remoteDir: string) =>
      ipcRenderer.invoke("sftp:pick-upload", what, remoteDir),
    preparePickedUpload: (sessionId: string, pickId: string, remoteDir: string) =>
      ipcRenderer.invoke("sftp:prepare-picked-upload", sessionId, pickId, remoteDir),
    startUpload: (uploadId: string) => ipcRenderer.invoke("sftp:start-upload", uploadId),
    cancelUpload: (uploadId: string) => ipcRenderer.invoke("sftp:cancel-upload", uploadId),
    onUploadProgress: (uploadId: string, cb: (progress: unknown) => void) =>
      listen(`sftp:upload-progress:${uploadId}`, cb),
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
