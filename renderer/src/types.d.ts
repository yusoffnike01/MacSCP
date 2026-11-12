export interface ServerConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  // 'agent' (ssh-agent) isn't supported yet.
  auth_method: "key" | "password" | "agent";
  key_path: string | null;
  color: string;
  created_at: string;
  last_used_at: string | null;
  // Fingerprint of the server host key the user trusted (null until then).
  host_key_sha256?: string | null;
}

export interface RemoteEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
}

export type RemoteFileType = "file" | "directory" | "symlink" | "other";

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

export interface Principal {
  name: string;
  id: number;
}

export interface Principals {
  users: Principal[];
  groups: Principal[];
}

export interface PropertyChanges {
  permissions?: number;
  uid?: number;
  gid?: number;
  // Folders only: also apply to everything inside.
  recursivePermissions?: boolean;
  recursiveOwnership?: boolean;
}

export interface TextFile {
  content: string; // line endings normalized to "\n"
  eol: "lf" | "crlf";
  bom: boolean;
  modifiedAt: number;
  size: number;
}

export interface SaveTextOptions {
  eol: "lf" | "crlf";
  bom: boolean;
  // When given, the save fails with CHANGED_ON_SERVER if the file changed
  // on the server since it was read.
  expectedModifiedAt?: number;
  expectedSize?: number;
}

export interface UploadItem {
  name: string;
  isDirectory: boolean;
  // Already in the destination folder: a file will be replaced, a folder
  // merged (files with the same names replaced, the rest kept).
  exists: boolean;
}

// Files or folders chosen in the open panel (Upload file / Upload folder).
// Their local paths stay in the main process.
export interface UploadPick {
  id: string;
  names: string[];
}

export interface UploadSummary {
  id: string;
  items: UploadItem[];
  filesTotal: number;
  bytesTotal: number;
  // Inside the uploaded folders, but not uploaded: symbolic links and
  // special files. Paths relative to the destination folder.
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
  // Symbolic links and special files in a folder, and files the server
  // wouldn't give (no permission, or gone since the folder was listed).
  skipped: SkippedItem[];
}

export type ContextMenuItem =
  | { id: string; label: string; enabled?: boolean }
  | { type: "separator" };

export interface WindowApi {
  connections: {
    list: () => Promise<ServerConnection[]>;
    create: (input: Omit<ServerConnection, "id" | "created_at" | "last_used_at">) => Promise<ServerConnection>;
    update: (
      id: string,
      changes: Partial<
        Pick<
          ServerConnection,
          "name" | "host" | "port" | "username" | "auth_method" | "key_path" | "color"
        >
      >
    ) => Promise<ServerConnection>;
    delete: (id: string) => Promise<void>;
    // Saves the server's login password or key passphrase (whichever its
    // auth_method uses) in the Keychain.
    setSecret: (id: string, secret: string) => Promise<void>;
    pickKeyFile: () => Promise<string | null>;
  };
  ssh: {
    connect: (connectionId: string) => Promise<string>;
    // Without Touch ID: connect with a typed password or key passphrase.
    connectWithSecret: (connectionId: string, secret: string) => Promise<string>;
    disconnect: (sessionId: string) => Promise<void>;
    openShell: (sessionId: string, cols: number, rows: number) => Promise<void>;
    write: (sessionId: string, data: string) => void;
    resize: (sessionId: string, cols: number, rows: number) => void;
    onData: (sessionId: string, cb: (chunk: string) => void) => () => void;
    onClosed: (sessionId: string, cb: () => void) => () => void;
    // A session's connection dropped by itself (network lost, server
    // restarted). Not called after disconnect().
    onDropped: (cb: (sessionId: string) => void) => () => void;
  };
  sftp: {
    list: (sessionId: string, remotePath: string) => Promise<RemoteEntry[]>;
    // Asks where to save the file (the save panel) or folder (a folder to
    // save it in): null if the user cancels.
    prepareDownload: (sessionId: string, remotePath: string) => Promise<DownloadTarget | null>;
    // Lists what's in a folder (a file resolves at once). Null if stopped
    // first with cancelDownload().
    scanDownload: (downloadId: string) => Promise<DownloadSummary | null>;
    onDownloadScanProgress: (
      downloadId: string,
      cb: (progress: DownloadScanProgress) => void
    ) => () => void;
    startDownload: (downloadId: string) => Promise<DownloadResult>;
    // Stops at once (partial files are removed; whole ones are kept), or
    // drops one that hasn't started.
    cancelDownload: (downloadId: string) => Promise<void>;
    onDownloadProgress: (
      downloadId: string,
      cb: (progress: DownloadProgress) => void
    ) => () => void;
    // Shows a finished download in Finder.
    showDownload: (downloadId: string) => Promise<void>;
    // Files and folders dropped from Finder, into `remoteDir`. Looks at them
    // and at what's already there, without changing anything yet.
    prepareUpload: (sessionId: string, files: File[], remoteDir: string) => Promise<UploadSummary>;
    // Upload file / Upload folder: shows the open panel. Null if cancelled.
    pickUpload: (what: "files" | "folders", remoteDir: string) => Promise<UploadPick | null>;
    // prepareUpload() for what was chosen in the open panel.
    preparePickedUpload: (
      sessionId: string,
      pickId: string,
      remoteDir: string
    ) => Promise<UploadSummary>;
    startUpload: (uploadId: string) => Promise<UploadResult>;
    // Stops after the files being sent right now, or drops a prepared upload.
    cancelUpload: (uploadId: string) => Promise<void>;
    onUploadProgress: (
      uploadId: string,
      cb: (progress: UploadProgress) => void
    ) => () => void;
    stat: (sessionId: string, remotePath: string) => Promise<RemoteStat>;
    principals: (sessionId: string) => Promise<Principals>;
    setProperties: (
      sessionId: string,
      remotePath: string,
      changes: PropertyChanges
    ) => Promise<void>;
    rename: (sessionId: string, fromPath: string, toPath: string) => Promise<void>;
    mkdir: (sessionId: string, remotePath: string) => Promise<void>;
    delete: (sessionId: string, remotePath: string) => Promise<void>;
    readText: (sessionId: string, remotePath: string) => Promise<TextFile>;
    writeText: (
      sessionId: string,
      remotePath: string,
      content: string,
      options: SaveTextOptions
    ) => Promise<{ modifiedAt: number; size: number }>;
  };
  ui: {
    // Native context menu; resolves with the chosen item's id, or null.
    showContextMenu: (items: ContextMenuItem[]) => Promise<string | null>;
    copyText: (text: string) => Promise<void>;
  };
}

declare global {
  interface Window {
    api: WindowApi;
  }
}
