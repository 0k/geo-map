import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import ts from "typescript";

// What a host's bundler ships: this package's ``tsc`` output, and the
// browser ESM entry of each pinned runtime library (the file its
// ``exports`` / ``main`` resolves to for a browser build).  The host's
// own build targets Chrome 91; this audit proves the code it receives
// needs no API or syntax newer than that.
const roots = [
  "dist",
  "node_modules/leaflet/dist/leaflet-src.js",
  "node_modules/@tmcw/togeojson/dist/togeojson.es.mjs",
  "node_modules/fflate/esm/browser.js",
  "node_modules/yaml/browser",
];
const files = [];
function collect(path) {
  if (!existsSync(path)) throw new Error(`${path}: missing (run npm install and npm run build first)`);
  if (!statSync(path).isDirectory()) {
    files.push(path);
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) collect(child);
    else if ([".js", ".mjs"].includes(extname(entry.name))) files.push(child);
  }
}
for (const root of roots) collect(root);
if (!files.some((file) => file.startsWith("dist"))) throw new Error("No emitted JavaScript found in dist/");

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics.length) throw new Error(`${file}: ${parsed.parseDiagnostics[0].messageText}`);
  let staticBlock = false;
  function visit(node) {
    if (ts.isClassStaticBlockDeclaration(node)) staticBlock = true;
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  if (staticBlock) throw new Error(`${file}: class static initialization blocks require Chrome 94`);
  // Runtime APIs newer than Chrome 91 that no syntax target lowers.
  const apis = [
    [/\bPromise\.withResolvers\s*\(/, 'Promise.withResolvers'],
    [/\.at\(\s*-?\d/, 'Array/String.prototype.at'],
    [/\bObject\.hasOwn\s*\(/, 'Object.hasOwn'],
    [/\.findLast(Index)?\s*\(/, 'Array.prototype.findLast'],
    [/\bstructuredClone\s*\(/, 'structuredClone'],
    [/\.to(Sorted|Reversed|Spliced)\s*\(/, 'change-array-by-copy'],
  ];
  for (const [pattern, api] of apis) {
    if (pattern.test(source)) throw new Error(`${file}: ${api} requires a browser newer than Chrome 91`);
  }
}
console.log(`Chrome 91 syntax inspection passed for ${files.length} files (dist/ and the pinned libraries)`);
