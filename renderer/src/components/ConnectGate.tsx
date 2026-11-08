import { useState } from "react";
import type { ServerConnection } from "../types";
import { errorMessage } from "../format";

function connectError(err: unknown): string {
  const message = errorMessage(err);
  if (message.includes("HOST_KEY_REJECTED")) {
    return "Not connected: the server's host key wasn't trusted.";
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
    "idle" | "connecting" | "need-passphrase" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");

  async function handleConnect() {
    setStatus("connecting");
    setError(null);
    try {
      const sessionId = await window.api.ssh.connect(connection.id);
      onConnected(sessionId);
    } catch (err) {
      const message = errorMessage(err);
      if (message.includes("TOUCHID_UNAVAILABLE")) {
        setStatus("need-passphrase");
      } else if (message.includes("TOUCHID_DENIED")) {
        setStatus("idle");
        setError("Touch ID was not confirmed. Try again.");
      } else {
        setStatus("error");
        setError(connectError(err));
      }
    }
  }

  async function handleManualConnect() {
    setStatus("connecting");
    setError(null);
    try {
      const sessionId = await window.api.ssh.connectWithPassphrase(
        connection.id,
        passphrase
      );
      onConnected(sessionId);
    } catch (err) {
      setStatus("error");
      setError(connectError(err));
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-2 text-3xl">
        🔒
      </div>
      <div className="text-center">
        <h2 className="text-base font-semibold text-text-primary">
          {connection.name}
        </h2>
        <p className="text-sm text-text-muted">
          {connection.username}@{connection.host}:{connection.port}
        </p>
      </div>

      {status === "need-passphrase" ? (
        <div className="flex w-72 flex-col gap-2">
          <p className="text-center text-xs text-text-muted">
            Touch ID is unavailable. Enter the SSH key passphrase.
          </p>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoFocus
            className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
          />
          <button
            onClick={handleManualConnect}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-surface-0 hover:opacity-90"
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
          <span className="text-lg">👆</span>
          {status === "connecting" ? "Verifying..." : "Verify with Touch ID"}
        </button>
      )}

      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
