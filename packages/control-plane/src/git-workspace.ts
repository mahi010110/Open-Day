import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import {
  assertFileChangeSemantics,
  type FileChange,
  type FileChangeSet,
} from "@open-day/domain";

const MAX_GIT_OUTPUT_BYTES = 8_000_000;
const MAX_CONTEXT_FILES = 80;
const MAX_CONTEXT_FILE_BYTES = 50_000;
const MAX_CONTEXT_CHARACTERS = 250_000;

export interface GitRepositoryIdentity {
  root: string;
  head: string;
}

export interface RepositoryContextFile {
  path: string;
  sha256: string;
  content: string;
}

export interface RepositoryContext {
  baseCommit: string;
  files: RepositoryContextFile[];
  omittedPaths: string[];
}

export interface MaterializedChangeSet {
  worktreePath: string;
  diff: string;
  diffHash: string;
}

export type DiffApplicationStatus =
  | "NOT_APPLIED"
  | "APPLIED"
  | "PARTIAL_OR_DIVERGED";

export class GitWorkspaceManager {
  async inspectCleanRepository(
    workspacePath: string,
    signal?: AbortSignal,
  ): Promise<GitRepositoryIdentity> {
    const requested = realpathSync(resolve(workspacePath));
    const rootOutput = await runGit(requested, ["rev-parse", "--show-toplevel"], signal);
    const root = realpathSync(rootOutput.trim());
    const status = await runGit(
      root,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      signal,
    );
    if (status.trim()) {
      throw new Error(
        "Le dépôt doit être propre avant une exécution. Committez, stash-ez ou retirez les changements existants.",
      );
    }
    const head = (await runGit(root, ["rev-parse", "HEAD"], signal)).trim();
    if (!/^[a-f0-9]{40,64}$/.test(head)) {
      throw new Error("Git n'a pas renvoyé un commit de base exploitable.");
    }
    return { root, head };
  }

  defaultWorktreeRoot(repositoryRoot: string, executionId: string): string {
    const parent = dirname(repositoryRoot);
    const repositoryName = basename(repositoryRoot).replace(/[^a-zA-Z0-9._-]/g, "-");
    return resolve(parent, ".open-day-worktrees", repositoryName, executionId);
  }

  async collectContext(
    repositoryRoot: string,
    baseCommit: string,
    signal?: AbortSignal,
  ): Promise<RepositoryContext> {
    const tracked = await runGit(repositoryRoot, ["ls-files", "-z"], signal);
    const paths = tracked.split("\0").filter(Boolean).sort();
    const files: RepositoryContextFile[] = [];
    const omittedPaths: string[] = [];
    let totalCharacters = 0;

    for (const path of paths) {
      if (files.length >= MAX_CONTEXT_FILES) {
        omittedPaths.push(path);
        continue;
      }
      let normalized: string;
      try {
        normalized = validateRelativeRepositoryPath(path);
      } catch {
        omittedPaths.push(path);
        continue;
      }
      if (isSensitiveRepositoryPath(normalized)) {
        omittedPaths.push(normalized);
        continue;
      }
      const absolute = resolveInside(repositoryRoot, normalized);
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONTEXT_FILE_BYTES) {
        omittedPaths.push(normalized);
        continue;
      }
      const buffer = readFileSync(absolute);
      if (buffer.includes(0)) {
        omittedPaths.push(normalized);
        continue;
      }
      const content = buffer.toString("utf8");
      if (containsLikelySecret(content)) {
        omittedPaths.push(normalized);
        continue;
      }
      if (totalCharacters + content.length > MAX_CONTEXT_CHARACTERS) {
        omittedPaths.push(normalized);
        continue;
      }
      totalCharacters += content.length;
      files.push({ path: normalized, sha256: sha256(buffer), content });
    }
    return { baseCommit, files, omittedPaths };
  }

  async createWorktree(
    repositoryRoot: string,
    baseCommit: string,
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (existsSync(worktreePath)) {
      throw new Error(`Le worktree existe déjà : ${worktreePath}`);
    }
    mkdirSync(dirname(worktreePath), { recursive: true, mode: 0o700 });
    await runGit(
      repositoryRoot,
      ["worktree", "add", "--detach", worktreePath, baseCommit],
      signal,
    );
  }

  async materializeChangeSet(input: {
    repositoryRoot: string;
    baseCommit: string;
    worktreePath: string;
    changeSet: FileChangeSet;
    ownedPaths: string[];
    signal?: AbortSignal;
  }): Promise<MaterializedChangeSet> {
    assertFileChangeSemantics(input.changeSet);
    let createdHere = false;
    if (!existsSync(input.worktreePath)) {
      await this.createWorktree(
        input.repositoryRoot,
        input.baseCommit,
        input.worktreePath,
        input.signal,
      );
      createdHere = true;
    }
    try {
      const head = (await runGit(input.worktreePath, ["rev-parse", "HEAD"], input.signal)).trim();
      if (head !== input.baseCommit) {
        throw new Error("Le worktree ne pointe plus sur le commit autorisé.");
      }

      for (const change of input.changeSet.changes) {
        this.applyFileChange(input.worktreePath, change, input.ownedPaths);
      }
      const createdPaths = input.changeSet.changes
        .filter((change) => change.operation === "CREATE")
        .map((change) => validateRelativeRepositoryPath(change.path));
      if (createdPaths.length) {
        await runGit(
          input.worktreePath,
          ["add", "-N", "-f", "--", ...createdPaths],
          input.signal,
        );
      }
      const diff = await this.readWorktreeDiff(input.worktreePath, input.signal);
      if (!diff.trim()) throw new Error("Le candidat n'a produit aucune modification Git.");
      return { worktreePath: input.worktreePath, diff, diffHash: sha256(diff) };
    } catch (error) {
      if (createdHere) {
        await this.removeWorktree(input.repositoryRoot, input.worktreePath).catch(
          () => undefined,
        );
      }
      throw error;
    }
  }

  async readWorktreeDiff(worktreePath: string, signal?: AbortSignal): Promise<string> {
    return runGit(
      worktreePath,
      ["diff", "--binary", "--no-ext-diff", "--full-index", "--"],
      signal,
    );
  }

  async removeWorktree(
    repositoryRoot: string,
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await runGit(
        repositoryRoot,
        ["worktree", "remove", "--force", worktreePath],
        signal,
      );
    } catch (error) {
      if (existsSync(worktreePath)) throw error;
    }
    await runGit(repositoryRoot, ["worktree", "prune"], signal);
  }

  async applyApprovedDiff(input: {
    repositoryRoot: string;
    baseCommit: string;
    worktreePath: string;
    expectedDiffHash: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const identity = await this.inspectCleanRepository(input.repositoryRoot, input.signal);
    if (identity.root !== realpathSync(input.repositoryRoot)) {
      throw new Error("La racine Git a changé depuis la création de l'exécution.");
    }
    if (identity.head !== input.baseCommit) {
      throw new Error(
        "HEAD a changé depuis le début de l'exécution. Créez une nouvelle exécution sur la nouvelle base.",
      );
    }
    const candidateHead = (
      await runGit(input.worktreePath, ["rev-parse", "HEAD"], input.signal)
    ).trim();
    if (candidateHead !== input.baseCommit) {
      throw new Error("Le candidat approuvé n'est plus basé sur le commit autorisé.");
    }
    const diff = await this.readWorktreeDiff(input.worktreePath, input.signal);
    const diffHash = sha256(diff);
    if (diffHash !== input.expectedDiffHash) {
      throw new Error("Le diff a changé depuis la validation humaine.");
    }
    await runGitWithInput(
      input.repositoryRoot,
      ["apply", "--check", "--binary", "--whitespace=nowarn", "-"],
      diff,
      input.signal,
    );
    await runGitWithInput(
      input.repositoryRoot,
      ["apply", "--binary", "--whitespace=nowarn", "-"],
      diff,
      input.signal,
    );
    return diffHash;
  }

  async inspectDiffApplication(input: {
    repositoryRoot: string;
    baseCommit: string;
    diff: string;
    signal?: AbortSignal;
  }): Promise<DiffApplicationStatus> {
    const requested = realpathSync(resolve(input.repositoryRoot));
    const root = realpathSync(
      (await runGit(requested, ["rev-parse", "--show-toplevel"], input.signal)).trim(),
    );
    if (root !== requested) throw new Error("La racine Git a changé depuis l'exécution.");
    const head = (await runGit(root, ["rev-parse", "HEAD"], input.signal)).trim();
    if (head !== input.baseCommit) {
      throw new Error("HEAD a changé; l'application ne peut pas être réconciliée automatiquement.");
    }
    const canApply = await canApplyDiff(root, input.diff, false, input.signal);
    const canReverse = await canApplyDiff(root, input.diff, true, input.signal);
    if (canApply && !canReverse) return "NOT_APPLIED";
    if (!canApply && canReverse) return "APPLIED";
    return "PARTIAL_OR_DIVERGED";
  }

  private applyFileChange(
    worktreeRoot: string,
    change: FileChange,
    ownedPaths: string[],
  ): void {
    const path = validateRelativeRepositoryPath(change.path);
    if (isSensitiveRepositoryPath(path)) {
      throw new Error(`Chemin sensible ou réservé interdit : ${path}`);
    }
    if (!ownedPaths.some((pattern) => pathMatchesPattern(path, pattern))) {
      throw new Error(`Le chemin ${path} n'appartient pas au lot autorisé.`);
    }
    const absolute = resolveInside(worktreeRoot, path);
    assertSafePathAncestors(worktreeRoot, path);
    const exists = existsSync(absolute);
    if (exists && lstatSync(absolute).isSymbolicLink()) {
      throw new Error(`Les liens symboliques ne peuvent pas être modifiés : ${path}`);
    }
    if (change.operation === "CREATE") {
      if (exists) throw new Error(`CREATE cible un fichier existant : ${path}`);
      mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
      writeFileSync(absolute, change.content!, { encoding: "utf8", mode: 0o600 });
      return;
    }
    if (!exists || !lstatSync(absolute).isFile()) {
      throw new Error(`${change.operation} cible un fichier absent : ${path}`);
    }
    const actualHash = sha256(readFileSync(absolute));
    if (actualHash !== change.expectedBaseHash) {
      throw new Error(`Le hash de base ne correspond pas pour ${path}.`);
    }
    if (change.operation === "DELETE") {
      unlinkSync(absolute);
    } else {
      writeFileSync(absolute, change.content!, { encoding: "utf8", mode: 0o600 });
    }
  }
}

export function validateRelativeRepositoryPath(rawPath: string): string {
  const path = rawPath.trim().replaceAll("\\", "/");
  if (!path || isAbsolute(path) || path.startsWith("/") || path.includes("\0")) {
    throw new Error(`Chemin de dépôt invalide : ${rawPath}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Chemin de dépôt invalide : ${rawPath}`);
  }
  return segments.join("/");
}

export function pathMatchesPattern(path: string, rawPattern: string): boolean {
  if (rawPattern.trim() === "**") return true;
  const pattern = validateRelativeRepositoryPath(rawPattern.replace(/\/\*\*$/, "/__all__"));
  if (pattern.endsWith("/__all__")) {
    const prefix = pattern.slice(0, -"__all__".length);
    return path.startsWith(prefix);
  }
  return path === pattern;
}

export function isSensitiveRepositoryPath(path: string): boolean {
  const normalized = path.toLowerCase();
  const segments = normalized.split("/");
  const name = segments.at(-1) ?? "";
  return (
    segments.includes(".git") ||
    segments.includes(".open-day") ||
    name === ".env" ||
    name.startsWith(".env.") ||
    [".npmrc", ".pypirc", ".netrc", "auth.json"].includes(name) ||
    /^(id_rsa|id_ed25519)(\.|$)/.test(name) ||
    /\.(pem|key|p12|pfx|jks|keystore)$/.test(name) ||
    /(^|[-_.])(secret|secrets|credentials)([-_.]|$)/.test(name)
  );
}

export function containsLikelySecret(content: string): boolean {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content) ||
    /\bAKIA[0-9A-Z]{16}\b/.test(content) ||
    /\bAIza[0-9A-Za-z_-]{30,}\b/.test(content) ||
    /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/.test(content) ||
    /\b(?:ghp|github_pat|xox[baprs]|sk_live)_[A-Za-z0-9_-]{16,}\b/.test(content)
  );
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveInside(root: string, path: string): string {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, path);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`Le chemin sort du worktree : ${path}`);
  }
  return absolute;
}

function assertSafePathAncestors(root: string, path: string): void {
  const segments = path.split("/").slice(0, -1);
  let current = resolve(root);
  for (const segment of segments) {
    current = resolve(current, segment);
    if (!existsSync(current)) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Un parent du chemin est un lien symbolique : ${path}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Un parent du chemin n'est pas un dossier : ${path}`);
    }
    if (existsSync(resolve(current, ".git"))) {
      throw new Error(`Les dépôts imbriqués et sous-modules sont hors périmètre : ${path}`);
    }
  }
}

async function canApplyDiff(
  cwd: string,
  diff: string,
  reverse: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await runGitWithInput(
      cwd,
      [
        "apply",
        "--check",
        ...(reverse ? ["--reverse"] : []),
        "--binary",
        "--whitespace=nowarn",
        "-",
      ],
      diff,
      signal,
    );
    return true;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

async function runGit(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  return runGitWithInput(cwd, args, null, signal);
}

async function runGitWithInput(
  cwd: string,
  args: string[],
  input: string | null,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(signal ? { signal } : {}),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_GIT_OUTPUT_BYTES) {
        child.kill();
        reject(new Error("La sortie Git dépasse la limite de sécurité."));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => reject(error));
    child.on("close", (code, closeSignal) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(
        new Error(
          `Git a échoué (${closeSignal ?? code ?? "inconnu"})${detail ? ` : ${detail}` : ""}`,
        ),
      );
    });
    if (input === null) child.stdin.end();
    else child.stdin.end(input, "utf8");
  });
}
