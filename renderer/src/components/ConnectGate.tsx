import { useState } from "react";
import type { ServerConnection } from "../types";
import { errorMessage } from "../format";
import { FingerprintIcon, LockIcon } from "./Icons";

// `typed`: the password was typed in just now, rather than the saved one.
function connectError(err: unknown, connection: ServerConnection, typed: boolean): string {
  const message = errorMessage(err);
  if (message.includes("HOST_KEY_REJECTED")) {
    return "Not connected: the server's host key wasn't trusted.";
  }
  if (
    connection.auth_method === "password" &&
    message.includes("All configured authentication methods failed")
  ) {
    return typed
      ? "The server didn't accept the username and password."
      : "The server didn't accept the saved username and password. To change them, right-click the server and choose Edit…";
  }
  return message;
}

export function ConnectGate({
  connection,
  onConnected,
}: {
  connection: ServerConnection;
  onConnected: (sessionId: string) => void;
}) {
  const [status, setStatus] = useState<
    "idle" | "connecting" | "need-secret" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  // The password or key passphrase, typed in when Touch ID is unavailable.
  const [typedSecret, setTypedSecret] = useState("");
  const usesPassword = connection.auth_method === "password";

  async function handleConnect() {
    setStatus("connecting");
    setError(null);
    try {
      const sessionId = await window.api.ssh.connect(connection.id);
      onConnected(sessionId);
    } catch (err) {
      const message = errorMessage(err);
      if (message.includes("TOUCHID_UNAVAILABLE")) {
        setStatus("need-secret");
      } else if (message.includes("TOUCHID_DENIED")) {
        setStatus("idle");
        setError("Touch ID was not confirmed. Try again.");
      } else {
        setStatus("error");
        setError(connectError(err, connection, false));
      }
    }
  }

  async function handleManualConnect() {
    setStatus("connecting");
    setError(null);
    try {
      const sessionId = await window.api.ssh.connectWithSecret(
        connection.id,
        typedSecret
      );
      onConnected(sessionId);
    } catch (err) {
      setStatus("error");
      setError(connectError(err, connection, true));
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border-subtle bg-surface-2 text-text-secondary">
        <LockIcon size={28} />
      </div>
      <div className="text-center">
        <h2 className="text-base font-semibold text-text-primary">
          {connection.name}
        </h2>
        <p className="text-sm text-text-muted">
          {connection.username}@{connection.host}:{connection.port}
        </p>
      </div>

      {status === "need-secret" ? (
        <div className="flex w-72 flex-col gap-2">
          <p className="text-center text-xs text-text-muted">
            Touch ID is unavailable. Enter the{" "}
            {usesPassword ? "password" : "SSH key passphrase"}.
          </p>
          <input
            type="password"
            value={typedSecret}
            onChange={(e) => setTypedSecret(e.target.value)}
            autoFocus
            className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
          />
          <button
            onClick={handleManualConnect}
            disabled={usesPassword && !typedSecret}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
          >
            Connect
          </button>
        </div>
      ) : (
        <button
          onClick={handleConnect}
          disabled={status === "connecting"}
          className="flex items-center gap-2 rounded-xl bg-accent px-6 py-3 text-sm font-medium text-surface-0 transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          <FingerprintIcon size={18} />
          {status === "connecting" ? "Verifying..." : "Verify with Touch ID"}
        </button>
      )}

      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
