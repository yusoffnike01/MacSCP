import "./app-setup"; // keep first: fixes the data folder before db.ts loads
import { app, BrowserWindow, dialog, type MessageBoxOptions } from "electron";
import path from "node:path";
import { registerIpcHandlers } from "./ipc-handlers";
import { disconnectAll } from "./ssh";

const isDev = !app.isPackaged;

// Set once the user agrees to quit, so the window then closes without
// asking a second time.
let quitConfirmed = false;
// A close/quit question is on screen. Further requests are dropped rather
// than stacking a second question (e.g. ⌘Q while the close sheet is open).
let asking = false;

// Closing the window or quitting disconnects every server, so ask first.
// Resolves true if the user agrees.
async function confirmExit(action: "close" | "quit", win?: BrowserWindow) {
  if (asking) return false;
  asking = true;
  try {
    const options: MessageBoxOptions = {
      type: "question",
      message: `Are you sure you want to ${action} MacSCP?`,
      detail: "Any open server connection will be disconnected.",
      buttons: [action === "quit" ? "Quit" : "Close", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    };
    const { response } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    return response === 0;
  } finally {
    asking = false;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0b0d12",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The red close button or ⌘W. On macOS the app keeps running, but
  // closing its window disconnects every server (see window-all-closed).
  let closeConfirmed = false;
  win.on("close", (event) => {
    if (closeConfirmed || quitConfirmed) return;
    event.preventDefault();
    void confirmExit("close", win).then((ok) => {
      if (!ok || win.isDestroyed()) return;
      closeConfirmed = true;
      win.close();
    });
  });

  if (isDev) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "..", "renderer", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  // A packaged app takes its icon from the bundle (build/icon.icns); run
  // unpackaged with `electron .`, the Dock would show Electron's logo.
  if (process.platform === "darwin" && !app.isPackaged) {
    app.dock?.setIcon(path.join(__dirname, "..", "build", "icon.png"));
  }
  // Once per app, not per window: ipcMain allows one handler per channel,
  // and on macOS a window can be closed and recreated from the Dock.
  registerIpcHandlers();
  createWindow();
});

app.on("window-all-closed", () => {
  disconnectAll();
  if (process.platform !== "darwin") {
    quitConfirmed = true; // closing the last window was confirmed already
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ⌘Q, Quit from the Dock, or the Mac restarting or shutting down.
app.on("before-quit", (event) => {
  if (quitConfirmed) {
    disconnectAll();
    return;
  }
  event.preventDefault();
  // Come to the front so the question is seen, e.g. after Quit from the
  // Dock while another app is active.
  app.focus({ steal: true });
  void confirmExit("quit").then((ok) => {
    if (!ok) return;
    quitConfirmed = true;
    app.quit();
  });
});
