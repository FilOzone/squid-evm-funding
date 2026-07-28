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

try {
  await Promise.all([mkdir(packDirectory), mkdir(consumerDirectory)])
  const packed = JSON.parse(
    pnpm(["pack", "--json", "--pack-destination", packDirectory], {
      encoding: "utf8",
    }),
  )
  const archive = isAbsolute(packed.filename)
    ? packed.filename
    : join(packDirectory, packed.filename)
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
  const packedFiles = packed.files
    .map(({ path }) => path.replaceAll("\\", "/"))
    .sort()
  const unexpected = packedFiles.filter(
    (path) =>
      path !== "LICENSE" &&
      path !== "README.md" &&
      path !== "package.json" &&
      !path.startsWith("dist/"),
  )
  if (unexpected.length > 0)
    throw new Error(`unexpected packed files: ${unexpected.join(", ")}`)
  if (!packedFiles.includes("dist/index.js"))
    throw new Error("packed package is missing dist/index.js")
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
