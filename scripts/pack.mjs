import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
// `artifacts/` is not tracked: a fresh clone has none, and `npm pack` will not create it.
mkdirSync(new URL("../artifacts/", import.meta.url), { recursive: true });
for (const args of [["run", "build"], ["pack", "--pack-destination", "artifacts", "--ignore-scripts"]]) {
  const result = spawnSync("npm", args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
