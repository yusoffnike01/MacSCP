import { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";

export function TerminalView({ sessionId }: { sessionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"SF Mono", Menlo, Consolas, monospace',
      theme: {
        background: "#0b0d12",
        foreground: "#e8eaf0",
        cursor: "#7c9eff",
        selectionBackground: "#2a3350",
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(host);
    fitAddon.fit();
    term.focus();

    let disposed = false;
    let shellReady = false;

    const unsubData = window.api.ssh.onData(sessionId, (chunk) => {
      term.write(chunk);
    });
    const unsubClosed = window.api.ssh.onClosed(sessionId, () => {
      term.write("\r\n\x1b[31m[Connection closed]\x1b[0m\r\n");
    });

    term.onData((data) => {
      window.api.ssh.write(sessionId, data);
    });

    // Keep the remote PTY the same size as the terminal. Resizes that happen
    // before the shell exists are caught up once it opens (below).
    term.onResize(({ cols, rows }) => {
      if (shellReady) window.api.ssh.resize(sessionId, cols, rows);
    });

    // Open the shell at the fitted size instead of a fixed 80x30.
    const openedCols = term.cols;
    const openedRows = term.rows;
    window.api.ssh
      .openShell(sessionId, openedCols, openedRows)
      .then(() => {
        if (disposed) return;
        shellReady = true;
        if (term.cols !== openedCols || term.rows !== openedRows) {
          window.api.ssh.resize(sessionId, term.cols, term.rows);
        }
      })
      .catch((err: unknown) => {
        if (disposed) return;
        const message = err instanceof Error ? err.message : String(err);
        term.write(`\r\n\x1b[31m[Could not open shell: ${message}]\x1b[0m\r\n`);
      });

    // Refit when the host element changes size. Fitting is deferred to the
    // next frame so it never changes layout inside the observer callback, and
    // skipped while the view is hidden (0x0, e.g. on the Files tab).
    let frame = 0;
    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (host.clientWidth === 0 || host.clientHeight === 0) return;
        fitAddon.fit();
      });
    });
    resizeObserver.observe(host);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      unsubData();
      unsubClosed();
      term.dispose();
      // The SSH session is owned by App (the file manager shares it), so it
      // is not disconnected here.
    };
  }, [sessionId]);

  // FitAddon sizes the terminal from its parent element's computed size, so
  // the padding lives on an outer wrapper; the host itself must have none.
  return (
    <div className="h-full w-full p-3">
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
