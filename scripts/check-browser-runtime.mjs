import { readdir, readFile } from "node:fs/promises"
import { builtinModules } from "node:module"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(
  await readFile(join(packageRoot, "package.json"), "utf8"),
)
const publishedEntry = "./dist/index.js"
const expectedExports = [
  "NATIVE_TOKEN_ADDRESS",
  "executeSquidFunding",
  "planSquidFunding",
]
if (
  manifest.browser !== publishedEntry ||
  manifest.exports?.["."]?.browser !== publishedEntry
)
  throw new Error("package.json must declare the published browser entry point")

if (!process.execArgv.includes("--conditions=browser"))
  throw new Error("Browser runtime check must run with --conditions=browser")

const browserModule = await import(manifest.name)
const actualExports = Object.keys(browserModule).sort()
if (JSON.stringify(actualExports) !== JSON.stringify(expectedExports))
  throw new Error(`Unexpected browser exports: ${actualExports.join(", ")}`)

async function listJavaScriptFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await listJavaScriptFiles(path)))
    else if (entry.name.endsWith(".js")) files.push(path)
  }
  return files.sort()
}

const normalizedBuiltins = new Set(
  builtinModules.map((name) => name.replace(/^node:/, "")),
)
const forbiddenGlobals = new Set([
  "Buffer",
  "process",
  "require",
  "__dirname",
  "__filename",
])
const failures = []
let publishedBytes = 0
const runtimeDirectory = join(packageRoot, "dist")
const runtimeFiles = await listJavaScriptFiles(runtimeDirectory)
if (runtimeFiles.length === 0)
  throw new Error("Browser runtime check requires a built dist directory")

function isNodeBuiltin(specifier) {
  const normalized = specifier.replace(/^node:/, "")
  const root = normalized.split("/")[0]
  return normalizedBuiltins.has(normalized) || normalizedBuiltins.has(root)
}

for (const path of runtimeFiles) {
  const source = await readFile(path, "utf8")
  publishedBytes += new TextEncoder().encode(source).byteLength
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  )

  function record(node, message) {
    const location = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    )
    failures.push(
      `${relative(packageRoot, path)}:${location.line + 1}:${location.character + 1} ${message}`,
    )
  }

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier != null &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      isNodeBuiltin(node.moduleSpecifier.text)
    )
      record(
        node.moduleSpecifier,
        `imports Node built-in ${node.moduleSpecifier.text}`,
      )

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      isNodeBuiltin(node.arguments[0].text)
    )
      record(
        node.arguments[0],
        `imports Node built-in ${node.arguments[0].text}`,
      )

    if (ts.isIdentifier(node) && forbiddenGlobals.has(node.text))
      record(node, `uses Node global ${node.text}`)

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
}

if (failures.length > 0)
  throw new Error(
    `Published runtime is not browser-safe:\n${failures.join("\n")}`,
  )

console.log(
  `Browser runtime check passed: ${runtimeFiles.length} modules, ${publishedBytes} published JavaScript bytes, no Node built-ins or globals.`,
)
