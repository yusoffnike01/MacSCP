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
    download: (sessionId: string, remotePath: string) => Promise<string | null>;
    upload: (sessionId: string, remoteDir: string) => Promise<string | null>;
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
