import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import ts from "typescript";

const roots = ["dist"];
const files = [];
function collect(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) collect(child);
    else if ([".js", ".cjs"].includes(extname(entry.name))) files.push(child);
  }
}
for (const root of roots) collect(root);
if (!files.length) throw new Error("No emitted JavaScript bundles found");

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
console.log(`Chrome 91 syntax inspection passed for ${files.length} emitted bundles`);
