import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"

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

function npm(args, options = {}) {
  if (process.platform !== "win32") return execFileSync("npm", args, options)
  const command = ["npm.cmd", ...args]
    .map((argument) => `"${argument.replaceAll('"', '""')}"`)
    .join(" ")
  return execFileSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", command],
    options,
  )
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "squid-evm-funding-pack-"))
const packDirectory = join(temporaryRoot, "pack")
const consumerDirectory = join(temporaryRoot, "consumer")
const gitConsumerDirectory = join(temporaryRoot, "git-consumer")
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

async function listFiles(directory, prefix = "") {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory())
      files.push(
        ...(await listFiles(join(directory, entry.name), relativePath)),
      )
    else files.push(relativePath)
  }
  return files
}

function assertRootExports(directory) {
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'const packageRoot = await import("squid-evm-funding")',
        'const expected = ["NATIVE_TOKEN_ADDRESS", "SquidMinimumAmountError", "executeSquidFunding", "fetchSquidCatalog", "fetchSquidStatus", "parseSquidCatalog", "parseSquidStatus", "planSquidFunding", "quoteSquidRoute", "resolveSourceToken"]',
        "const actual = Object.keys(packageRoot).sort()",
        'if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("unexpected root exports: " + actual.join(", "))',
      ].join("\n"),
    ],
    { cwd: directory, stdio: "inherit" },
  )
}

try {
  await Promise.all([
    mkdir(packDirectory),
    mkdir(consumerDirectory),
    mkdir(gitConsumerDirectory),
  ])
  pnpm(["pack", "--pack-destination", packDirectory], { stdio: "inherit" })
  const archives = (await readdir(packDirectory)).filter((file) =>
    file.endsWith(".tgz"),
  )
  if (archives.length !== 1)
    throw new Error(`expected one packed archive, found ${archives.length}`)
  const archive = join(packDirectory, archives[0])
  await writeFile(
    join(consumerDirectory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  )
  pnpm(["add", "--save-exact", archive], {
    cwd: consumerDirectory,
    stdio: "inherit",
  })
  assertRootExports(consumerDirectory)
  const installedPackage = join(
    consumerDirectory,
    "node_modules",
    "squid-evm-funding",
  )
  const packedFiles = (await listFiles(installedPackage)).sort()
  if (JSON.stringify(packedFiles) !== JSON.stringify(expectedFiles))
    throw new Error(`unexpected packed files: ${packedFiles.join(", ")}`)
  await writeFile(
    join(gitConsumerDirectory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  )
  npm(["install", `git+${pathToFileURL(process.cwd()).href}`], {
    cwd: gitConsumerDirectory,
    stdio: "inherit",
  })
  assertRootExports(gitConsumerDirectory)
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
