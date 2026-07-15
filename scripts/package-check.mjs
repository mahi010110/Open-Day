import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "open-day-package-"));
const archiveDirectory = join(directory, "archive");
const installDirectory = join(directory, "install");
const cacheDirectory = join(directory, "npm-cache");
const environment = {
  ...process.env,
  NPM_CONFIG_CACHE: cacheDirectory,
  NODE_NO_WARNINGS: "1",
};

function run(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, { cwd, env: environment, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `Échec de ${command} ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

try {
  await mkdir(archiveDirectory, { recursive: true });
  await mkdir(installDirectory, { recursive: true });
  run("npm", ["pack", "--pack-destination", archiveDirectory, "--json"]);
  const archives = (await readdir(archiveDirectory)).filter((file) => file.endsWith(".tgz"));
  assert.equal(archives.length, 1, "Un unique paquet npm doit être produit.");
  const archive = join(archiveDirectory, archives[0]);
  run("npm", ["install", "--ignore-scripts", "--prefix", installDirectory, archive]);
  const executable = resolve(
    installDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "open-day.cmd" : "open-day",
  );
  const version = run(executable, ["--version"], installDirectory).stdout.trim();
  assert.equal(version, "0.3.0");
  await access(
    join(
      installDirectory,
      "node_modules",
      "open-day",
      "apps",
      "cli",
      "dist",
      "index.cjs.map",
    ),
  );
  for (const dependency of [
    "commander",
    "zod",
    "openai",
    "@anthropic-ai/sdk",
    "@google/genai",
  ]) {
    await access(join(installDirectory, "node_modules", dependency, "LICENSE"));
  }
  console.log("Paquet npm local validé : installation propre et binaire open-day 0.3.0.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
