import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join } from "node:path"

function pnpm(args, options = {}) {
  const executable = process.env.npm_execpath
  if (executable != null)
    return execFileSync(process.execPath, [executable, ...args], options)
  return execFileSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    args,
    options,
  )
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "squid-evm-funding-pack-"))
const packDirectory = join(temporaryRoot, "pack")
const consumerDirectory = join(temporaryRoot, "consumer")
const expectedFiles = [
  "LICENSE",
  "README.md",
  "dist/catalog.d.ts",
  "dist/catalog.js",
  "dist/execution.d.ts",
  "dist/execution.js",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/planner.d.ts",
  "dist/planner.js",
  "dist/squid.d.ts",
  "dist/squid.js",
  "dist/types.d.ts",
  "dist/types.js",
  "package.json",
].sort()

function packEntryPath(entry) {
  const path = typeof entry === "string" ? entry : entry?.path
  if (typeof path !== "string" || path === "")
    throw new Error("pnpm pack did not return a valid file list")
  return path.replaceAll("\\", "/")
}

try {
  await Promise.all([mkdir(packDirectory), mkdir(consumerDirectory)])
  const packResult = JSON.parse(
    pnpm(["pack", "--json", "--pack-destination", packDirectory], {
      encoding: "utf8",
    }),
  )
  const packed = Array.isArray(packResult) ? packResult[0] : packResult
  if (packed == null || typeof packed !== "object")
    throw new Error("pnpm pack did not return package metadata")
  const filename = packed.filename ?? packed.tarball
  if (typeof filename !== "string" || filename === "")
    throw new Error("pnpm pack did not return a tarball path")
  const archive = isAbsolute(filename)
    ? filename
    : join(packDirectory, filename)
  await writeFile(
    join(consumerDirectory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  )
  pnpm(["add", "--save-exact", archive], {
    cwd: consumerDirectory,
    stdio: "inherit",
  })
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'const packageRoot = await import("squid-evm-funding")',
        'const expected = ["NATIVE_TOKEN_ADDRESS", "SquidMinimumAmountError", "executeSquidFunding", "fetchSquidCatalog", "fetchSquidStatus", "parseSquidCatalog", "parseSquidStatus", "planSquidFunding", "quoteSquidRoute", "resolveSourceToken", "sealSquidExecutionCheckpoint"]',
        "const actual = Object.keys(packageRoot).sort()",
        'if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("unexpected root exports: " + actual.join(", "))',
      ].join("\n"),
    ],
    { cwd: consumerDirectory, stdio: "inherit" },
  )
  const fileEntries = packed.files ?? packed.contents
  if (!Array.isArray(fileEntries))
    throw new Error("pnpm pack did not return a file list")
  const packedFiles = fileEntries.map(packEntryPath).sort()
  if (JSON.stringify(packedFiles) !== JSON.stringify(expectedFiles))
    throw new Error(`unexpected packed files: ${packedFiles.join(", ")}`)
  const archiveSize = (await stat(archive)).size
  console.log(
    JSON.stringify(
      {
        archive: basename(archive),
        packedBytes: archiveSize,
        files: packedFiles,
      },
      null,
      2,
    ),
  )
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
