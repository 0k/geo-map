#!/usr/bin/env node
/**
 * Deliver this package to every consumer, in one command, atomically.
 *
 * ## ⚠ Why a script exists at all
 *
 * The delivery mechanism is a committed tarball under each consumer's
 * `vendor/` (see README.org § Why not a registry). That mechanism's one
 * real cost is a multi-step ritual per change — pack, copy, repoint,
 * reinstall — performed once PER CONSUMER. A ritual performed by hand
 * for N consumers fails by being performed for N-1 of them, and the
 * consumer that was missed then holds a STALE COMPATIBILITY POLICY
 * while looking perfectly healthy: it installs, it builds, its tests
 * pass, and it ships a map bundle that is not the audited one on
 * the one device the pin exists for.
 *
 * That is the exact drift the extraction was performed to end,
 * reintroduced one layer down. So the ritual is a program, and the
 * program's central rule is:
 *
 *   ⚠ **ALL consumers are validated BEFORE any is written, and a
 *   failure anywhere writes NOTHING.**
 *
 * A half-applied vendor is worse than a refused one, because a refusal
 * is loud and leaves every consumer on the same (old) version, while a
 * half-application is silent and leaves them on two different ones.
 *
 * ## What it does NOT do
 *
 * It does not commit, and it does not build. Both are the operator's,
 * deliberately: the tarball is a binary entering two repositories, and
 * it should enter them through a diff someone read.
 *
 * Usage:  npm run vendor  [--dry-run]
 *         npm run try      (review uncommitted work in consumers; see TRY)
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every consumer of this package, read from `vendor-consumers.yml` at the
 * package root.  That file is machine-local (git-ignored): consumers live
 * wherever each developer checked them out.  Format:
 *
 *     consumers:
 *       my-app: /path/to/my-app/frontend
 *
 * ⚠ Adding a consumer means adding it THERE, not just adding a
 * dependency line to it. A consumer this list does not know about is
 * one `npm run vendor` will silently leave behind — which is the
 * failure mode this whole script exists to make impossible.  A missing
 * or empty list is therefore an error, never "zero consumers".
 */
function readConsumers() {
  const path = join(OWNER, "vendor-consumers.yml");
  if (!existsSync(path)) {
    console.error(`vendor: ${path} is missing (see bin/vendor.mjs for its format).`);
    process.exit(1);
  }
  const consumers = [];
  let inList = false;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (/^consumers:\s*$/.test(line)) { inList = true; continue; }
    const entry = /^\s+([A-Za-z0-9._-]+):\s*(\S.*)$/.exec(line);
    if (!inList || !entry) {
      console.error(`vendor: cannot parse ${path}: ${JSON.stringify(raw)}`);
      process.exit(1);
    }
    consumers.push({ name: entry[1], dir: entry[2] });
  }
  if (!consumers.length) {
    console.error(`vendor: ${path} lists no consumer.`);
    process.exit(1);
  }
  return consumers;
}

const CONSUMERS = readConsumers();

const DRY_RUN = process.argv.includes("--dry-run");
/**
 * `--try` (`npm run try`): put the WORKING TREE's build into every
 * consumer's installed copy (`node_modules/<name>/dist`) so uncommitted
 * changes can be reviewed in the real host, without a version bump.
 *
 * It writes nothing a consumer tracks (no tarball, no package.json, no
 * lockfile): the overlay lives only in `node_modules`, and the next
 * `npm run vendor` (or `npm install`/`npm ci` there) replaces it.
 */
const TRY = process.argv.includes("--try");

function fail(message) {
  console.error(`vendor: ${message}`);
  console.error("vendor: NOTHING was written. Fix the above and re-run.");
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const ownerPkg = readJson(join(OWNER, "package.json"));
const { name, version } = ownerPkg;
if (!name || !version) fail("owner package.json lacks a name or version");

// npm's tarball naming: `@scope/pkg` -> `scope-pkg-<version>.tgz`.
const tarballName = `${name.replace(/^@/, "").replace(/\//g, "-")}-${version}.tgz`;

console.log(`vendor: ${name}@${version} -> ${CONSUMERS.length} consumer(s)`);

// ── Phase 1: validate EVERY consumer before writing to ANY ────────────
//
// Each consumer must exist, be a package, and already declare this
// dependency. "Already declares it" is required on purpose: this script
// PROMOTES a version, it does not ONBOARD a consumer. Wiring a new
// consumer touches its build config and its imports, which is review
// work, not something a delivery script should do behind a `--force`.
const planned = [];
for (const consumer of CONSUMERS) {
  const pkgPath = join(consumer.dir, "package.json");
  if (!existsSync(pkgPath)) {
    fail(`consumer '${consumer.name}': no package.json at ${pkgPath}`);
  }
  const pkg = readJson(pkgPath);
  const current = pkg.dependencies?.[name];
  if (!current) {
    fail(
      `consumer '${consumer.name}' does not declare ${name}. ` +
        "Wire it up by hand first (see README.org § Adding a consumer).",
    );
  }
  const expected = `file:vendor/${tarballName}`;
  const installed = join(consumer.dir, "node_modules", name);
  if (TRY && !existsSync(join(installed, "package.json"))) {
    fail(`consumer '${consumer.name}': ${name} is not installed at ${installed} (run npm install there first)`);
  }
  planned.push({ ...consumer, pkgPath, pkg, current, expected, installed });
  if (TRY) {
    console.log(`vendor:   ${consumer.name}: overlay working tree onto ${installed}/dist`);
    continue;
  }
  const state = current === expected ? "already current" : `${current} -> ${expected}`;
  console.log(`vendor:   ${consumer.name}: ${state}`);
}

if (TRY) {
  execFileSync("npm", ["run", "build"], { cwd: OWNER, stdio: "inherit" });
  for (const c of planned) {
    const target = join(c.installed, "dist");
    rmSync(target, { recursive: true, force: true });
    cpSync(join(OWNER, "dist"), target, { recursive: true });
    console.log(`vendor:   ${c.name}: ${target} <- working tree`);
  }
  console.log("");
  console.log(`vendor: try: uncommitted ${name} is installed in ${planned.length} consumer(s); nothing tracked was written.`);
  console.log("vendor: rebuild and restart each consumer to see it; `npm run vendor` (or npm install there) undoes it.");
  process.exit(0);
}

// ── Phase 2: pack ONCE ────────────────────────────────────────────────
//
// ⚠ One tarball is packed and the SAME bytes are copied everywhere.
// Packing per consumer would produce artifacts that could differ (npm
// embeds no timestamp today, but relying on that is relying on an
// implementation detail to keep every consumer in sync),
// and the lockfile `integrity` hashes would then legitimately diverge
// with no way to tell that from a real mismatch.
const staging = mkdtempSync(join(tmpdir(), "geo-map-vendor-"));
let packed;
try {
  execFileSync("npm", ["run", "build"], { cwd: OWNER, stdio: "inherit" });
  execFileSync("npm", ["pack", "--pack-destination", staging], {
    cwd: OWNER,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const produced = readdirSync(staging).filter((f) => f.endsWith(".tgz"));
  if (produced.length !== 1) {
    fail(`npm pack produced ${produced.length} tarballs, expected exactly 1`);
  }
  if (produced[0] !== tarballName) {
    fail(`npm pack produced '${produced[0]}', expected '${tarballName}'`);
  }
  packed = join(staging, produced[0]);

  if (DRY_RUN) {
    console.log(`vendor: --dry-run, packed ${produced[0]} and stopped.`);
    process.exit(0);
  }

  // ── Phase 3: apply to every consumer ───────────────────────────────
  for (const c of planned) {
    const vendorDir = join(c.dir, "vendor");
    mkdirSync(vendorDir, { recursive: true });

    // Drop superseded tarballs of THIS package only, so a consumer does
    // not accumulate every version it ever held. Other packages' vendored
    // artifacts (if any ever appear) are left strictly alone.
    const stalePrefix = `${name.replace(/^@/, "").replace(/\//g, "-")}-`;
    for (const f of readdirSync(vendorDir)) {
      if (f.startsWith(stalePrefix) && f.endsWith(".tgz") && f !== tarballName) {
        unlinkSync(join(vendorDir, f));
        console.log(`vendor:   ${c.name}: removed stale ${f}`);
      }
    }

    copyFileSync(packed, join(vendorDir, tarballName));

    if (c.current !== c.expected) {
      c.pkg.dependencies[name] = c.expected;
      writeFileSync(c.pkgPath, `${JSON.stringify(c.pkg, null, 2)}\n`);
    }

    // ⚠ `npm install <tarball>` (not a bare `npm install`, and not
    // `--package-lock-only`): the lockfile's `integrity` hash must be
    // recomputed from the tarball that is now on disk, and node_modules
    // must actually hold the new source or the very next build silently
    // compiles the previous version.  A bare `npm install` is NOT enough
    // when the version did not change: npm sees the spec already
    // satisfied by the lockfile and leaves the stale copy in place, even
    // though the tarball bytes (and their hash) differ.  Naming the
    // tarball forces the reinstall and the integrity refresh.
    console.log(`vendor:   ${c.name}: npm install ${c.expected}…`);
    execFileSync("npm", ["install", "--no-audit", "--no-fund", c.expected], {
      cwd: c.dir,
      stdio: ["ignore", "inherit", "inherit"],
    });
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}

console.log("");
console.log(`vendor: done. ${name}@${version} is live in ${planned.length} consumer(s).`);
console.log("vendor: NOT committed and NOT built — review the diffs, then in each consumer:");
console.log("vendor:   git add vendor/ package.json package-lock.json");
console.log("vendor: and run that project's own build/test gate.");
