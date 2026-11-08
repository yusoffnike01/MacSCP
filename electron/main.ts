import "./app-setup"; // keep first: fixes the data folder before db.ts loads
import { app, BrowserWindow } from "electron";
import path from "node:path";
import { registerIpcHandlers } from "./ipc-handlers";
import { disconnectAll } from "./ssh";

const isDev = !app.isPackaged;

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
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", () => {
  disconnectAll();
});
