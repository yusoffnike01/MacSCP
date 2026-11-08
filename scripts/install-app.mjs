// Copies the freshly built MacSCP.app into /Applications, replacing any
// older copy. Run via `npm run install:app` (which builds it first).
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

// electron-builder puts Apple Silicon builds in mac-arm64/, Intel in mac/.
const built = `release/${process.arch === "arm64" ? "mac-arm64" : "mac"}/MacSCP.app`;
const target = "/Applications/MacSCP.app";

if (!existsSync(built)) {
  console.error(`Build not found at ${built}. Run "npm run dist" first.`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
// ditto keeps the app bundle's symlinks, permissions and code signature intact.
execFileSync("ditto", [built, target], { stdio: "inherit" });
console.log(`Installed ${target}`);
