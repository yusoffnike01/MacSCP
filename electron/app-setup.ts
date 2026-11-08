// Must be the first import in main.ts: db.ts reads the userData path as soon
// as it is loaded, so the path has to be fixed before that.

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

// One data folder for development (`electron .`) and the packaged
// MacSCP.app, so saved servers are shared:
// ~/Library/Application Support/MacSCP
const appData = app.getPath("appData");
const dataDir = path.join(appData, "MacSCP");

// Before the rename, the app ("Server Access") kept its data in
// "server-access-app". Move it over once so saved servers aren't lost.
const oldDataDir = path.join(appData, "server-access-app");
if (!fs.existsSync(dataDir) && fs.existsSync(oldDataDir)) {
  try {
    fs.renameSync(oldDataDir, dataDir);
  } catch {
    // Leave the old folder alone; the app starts with an empty server list.
  }
}

app.setPath("userData", dataDir);

// Shown in the app menu ("About/Hide/Quit MacSCP").
app.setName("MacSCP");
