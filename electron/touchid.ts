// Spawns the compiled Swift Touch ID helper and resolves true/false.
// This is the ONLY place that decides "is the human allowed to proceed."
// It never sees or touches SSH keys/passphrases itself.

import { execFile } from "node:child_process";
import path from "node:path";
import { app } from "electron";

const HELPER_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "touchid-auth")
  : path.join(__dirname, "..", "electron", "touchid", "touchid-auth");

export type TouchIdResult = "ok" | "fail" | "unavailable";

export function requestTouchId(reason: string): Promise<TouchIdResult> {
  return new Promise((resolve) => {
    execFile(HELPER_PATH, [reason], { timeout: 30_000 }, (error, stdout) => {
      const out = stdout.toString().trim();
      if (out.includes("TOUCHID_OK")) return resolve("ok");
      if (out.includes("TOUCHID_UNAVAILABLE")) return resolve("unavailable");
      // Any other exit (cancelled, failed match, timeout, missing binary)
      // is treated as a hard fail — never silently allow access.
      resolve("fail");
    });
  });
}
