import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

interface PackEntry {
  filename: string;
  files: Array<{ path: string }>;
  bundled?: string[];
}

function run(
  command: string,
  args: string[],
  cwd: string,
): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

async function listPackageFiles(
  root: string,
  directory = root,
): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    if (entry.isDirectory()) {
      if (path === "node_modules" || path.startsWith("node_modules/")) {
        continue;
      }
      files.push(...await listPackageFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort();
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const coreRoot = fileURLToPath(new URL("../../..", import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "agenttool-word-pack-"));

try {
  const currentCorePack = JSON.parse(
    run(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        scratch,
      ],
      coreRoot,
    ),
  ) as PackEntry[];
  const coreEntry = currentCorePack[0];
  if (!coreEntry) throw new Error("npm pack returned no core package");
  const digest = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");
  const installedCoreRoot = join(packageRoot, "node_modules", "word-layer");
  const expectedCorePaths = coreEntry.files.map((file) => file.path).sort();
  const installedCorePaths = await listPackageFiles(installedCoreRoot);
  if (
    expectedCorePaths.length !== installedCorePaths.length
    || expectedCorePaths.some(
      (path, index) => path !== installedCorePaths[index],
    )
  ) {
    throw new Error(
      "installed bundled core file set is stale; rebuild the root package, "
      + "refresh vendor/word-layer-0.3.0.tgz, and update bun.lock",
    );
  }
  for (const file of coreEntry.files) {
    const [rootFile, installedFile] = await Promise.all([
      readFile(join(coreRoot, file.path)),
      readFile(join(installedCoreRoot, file.path)),
    ]);
    if (digest(rootFile) !== digest(installedFile)) {
      throw new Error(
        `installed bundled core is stale at ${file.path}; regenerate bun.lock`,
      );
    }
  }

  const packed = JSON.parse(
    run(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        scratch,
      ],
      packageRoot,
    ),
  ) as PackEntry[];
  const entry = packed[0];
  if (!entry) throw new Error("npm pack returned no package");
  if (!entry.bundled?.includes("word-layer")) {
    throw new Error("packed sidecar did not bundle the exact word-layer core");
  }
  const paths = new Set(entry.files.map((file) => file.path));
  if (!paths.has("node_modules/word-layer/dist/src/library.js")) {
    throw new Error("packed sidecar omitted the word-layer library runtime");
  }
  if (
    [...paths].some((path) =>
      path.includes("/.git/")
      || path.startsWith("tests/")
      || path.startsWith("src/")
    )
  ) {
    throw new Error("packed sidecar leaked repository source or test state");
  }

  await writeFile(
    join(scratch, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
    "utf8",
  );
  const tarball = join(scratch, entry.filename);
  run(
    "npm",
    [
      "install",
      tarball,
      "@agenttool/browser@0.5.0",
      "--ignore-scripts",
    ],
    scratch,
  );
  run(
    "node",
    [
      "--input-type=module",
      "--eval",
      "const m=await import('@word-layer/agenttool');"
        + "if(m.WORD_JSONL_PROTOCOL_VERSION!=='agenttool-word-jsonl/0.1'"
        + "||m.WORD_BROWSER_OPERATIONS.length!==14)process.exit(1)",
    ],
    scratch,
  );
  const help = run(
    join(scratch, "node_modules", ".bin", "agenttool-word"),
    ["help"],
    scratch,
  );
  if (!help.startsWith("agenttool-word 0.1.0")) {
    throw new Error("freshly installed CLI help smoke failed");
  }

  process.stdout.write("fresh package install/import/bin smoke passed\n");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
