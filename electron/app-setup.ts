// Must be the first import in main.ts: db.ts reads the userData path as soon
// as it is loaded, so the path has to be fixed before that.

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

// One data folder for development (`electron .`) and the packaged
// MacFlux.app, so saved servers are shared:
// ~/Library/Application Support/MacFlux
const appData = app.getPath("appData");
const dataDir = path.join(appData, "MacFlux");

// Folders earlier versions kept their data in, newest first: "MacSCP", and
// before that "server-access-app" (when the app was called "Server Access").
// The first one found is moved over once, so saved servers aren't lost.
const oldDataDirs = ["MacSCP", "server-access-app"].map((name) => path.join(appData, name));
if (!fs.existsSync(dataDir)) {
  const oldDataDir = oldDataDirs.find((dir) => fs.existsSync(dir));
  if (oldDataDir) {
    try {
      fs.renameSync(oldDataDir, dataDir);
    } catch {
      // Leave the old folder alone; the app starts with an empty server list.
    }
  }
}

app.setPath("userData", dataDir);

// Shown in the app menu ("About/Hide/Quit MacFlux").
app.setName("MacFlux");
