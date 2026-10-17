// Read-only evidence collectors shared by runAll.js and report.js (plan Part F).
//
// SAFETY: every git command here only reads. `--no-optional-locks` stops `git status`/`git diff` from
// refreshing the index as a side effect. Nothing here commits, stashes, checks out, fetches or touches refs.
// The environment fingerprint records versions and file presence only; it never reads `.env` or prints a
// variable's value (paths excepted).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const BACKEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const resolveFrontendRoot = (env = process.env) =>
  resolve(BACKEND_ROOT, env.VIVASAYI_FRONTEND_DIR || join("..", "VivasayiAI-Frontend"));

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export const sha1 = (data) => createHash("sha1").update(data).digest("hex");

export const toPosix = (path) => path.split(sep).join("/");

// Repo-relative POSIX path when `absolute` lies inside `root`, otherwise the input unchanged.
export const relativeToRoot = (root, absolute) => {
  if (!absolute) return absolute;
  if (!root || !isAbsolute(absolute)) return toPosix(absolute);
  const rel = relative(root, absolute);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? toPosix(rel) : toPosix(absolute);
};

// `YYYYMMDDTHHMMSSZ-<shortCommit>`: ISO time plus the backend's short commit, safe in file names.
export const makeRunId = (date, shortCommit) => {
  const stamp = date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
  return `${stamp}-${(shortCommit || "nocommit").replace(/[^A-Za-z0-9._-]/g, "")}`;
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding === null ? undefined : "utf8",
    maxBuffer: 512 * 1024 * 1024,
    timeout: options.timeoutMs ?? 60_000,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
};

const git = (cwd, args, options) => run("git", ["--no-optional-locks", ...args], { cwd, ...options });
const gitText = (cwd, args) => {
  const result = git(cwd, args);
  return result.status === 0 ? String(result.stdout).trim() : null;
};

// Per-repo git record (plan Part F "Git record per repo", critique B7). `baseline` comes from
// acceptanceItems.json gitBaseline: { head, branch, refs: { refname: sha } }.
export const collectGitState = (repoRoot, baseline = null) => {
  if (!repoRoot || !existsSync(repoRoot)) return { available: false, reason: "repository path does not exist" };
  if (gitText(repoRoot, ["rev-parse", "--is-inside-work-tree"]) !== "true") return { available: false, reason: "not a git work tree" };

  const head = gitText(repoRoot, ["rev-parse", "HEAD"]);
  const branch = gitText(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const statusLines = (gitText(repoRoot, ["status", "--porcelain=v1"]) || "").split("\n").filter(Boolean);
  const diff = git(repoRoot, ["diff", "HEAD", "--no-color", "--no-ext-diff", "--binary"], { encoding: null });
  const shortstat = gitText(repoRoot, ["diff", "HEAD", "--shortstat"]) || "";
  const untracked = (gitText(repoRoot, ["ls-files", "--others", "--exclude-standard"]) || "").split("\n").filter(Boolean).sort();
  const stashList = (gitText(repoRoot, ["stash", "list"]) || "").split("\n").filter(Boolean);
  const stashRef = git(repoRoot, ["rev-parse", "-q", "--verify", "refs/stash"]);
  const refs = Object.fromEntries(
    (gitText(repoRoot, ["for-each-ref", "--format=%(refname) %(objectname)"]) || "")
      .split("\n").filter(Boolean).map((line) => line.split(" ")),
  );
  const inProgress = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"].filter((name) => {
    const path = gitText(repoRoot, ["rev-parse", "--git-path", name]);
    return path && existsSync(resolve(repoRoot, path));
  });

  // Untracked files are not in `git diff HEAD`, so their contents get their own combined hash.
  const untrackedHashes = untracked.map((file) => {
    try {
      const full = join(repoRoot, file);
      const size = statSync(full).size;
      return `${size > 64 * 1024 * 1024 ? `skipped-large:${size}` : sha256(readFileSync(full))}  ${file}`;
    } catch {
      return `unreadable  ${file}`;
    }
  });

  const comparison = baseline ? {
    expectedHead: baseline.head ?? null,
    headUnchanged: baseline.head ? head === baseline.head : null,
    expectedBranch: baseline.branch ?? null,
    newRefs: Object.keys(refs).filter((ref) => !(ref in (baseline.refs || {}))).sort(),
    movedRefs: Object.keys(refs).filter((ref) => baseline.refs && ref in baseline.refs && baseline.refs[ref] !== refs[ref]).sort(),
    missingRefs: Object.keys(baseline.refs || {}).filter((ref) => !(ref in refs)).sort(),
  } : null;

  return {
    available: true,
    head,
    shortHead: head ? head.slice(0, 7) : null,
    branch,
    dirty: statusLines.length > 0,
    statusPorcelain: statusLines,
    diffHeadSha256: diff.status === 0 ? sha256(diff.stdout) : null,
    diffHeadBytes: diff.status === 0 ? diff.stdout.length : null,
    diffShortstat: shortstat,
    untracked,
    untrackedContentSha256: sha256(untrackedHashes.join("\n")),
    stash: { count: stashList.length, refsStashExists: stashRef.status === 0 },
    refs,
    refsSha256: sha256(Object.entries(refs).map(([ref, sha]) => `${ref} ${sha}`).join("\n")),
    operationInProgress: inProgress,
    baseline: comparison,
  };
};

export const repoSummary = (path, gitState) => ({
  path,
  available: Boolean(gitState?.available),
  commit: gitState?.head ?? null,
  branch: gitState?.branch ?? null,
  dirty: gitState?.available ? gitState.dirty : null,
  git: gitState ?? null,
});

const readVersion = (packageJsonPath) => {
  try { return JSON.parse(readFileSync(packageJsonPath, "utf8")).version ?? null; } catch { return null; }
};

const firstLine = (text) => String(text || "").split("\n").find((line) => line.trim()) ?? null;

export const MONGOD_CANDIDATES = ["/opt/homebrew/bin/mongod", "/usr/local/bin/mongod", "/usr/bin/mongod"];

const findMongod = (env) => {
  const candidates = [env.MONGOMS_SYSTEM_BINARY, ...MONGOD_CANDIDATES].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  const which = run("which", ["mongod"]);
  return which.status === 0 ? String(which.stdout).trim() || null : null;
};

const playwrightBrowsersDir = (env) => {
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== "0") return env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === "darwin") return join(os.homedir(), "Library", "Caches", "ms-playwright");
  if (process.platform === "win32") return join(env.LOCALAPPDATA || os.homedir(), "ms-playwright");
  return join(os.homedir(), ".cache", "ms-playwright");
};

// Versions and presence only. Never reads .env and never records a credential's value.
export const collectEnvironment = ({ backendRoot = BACKEND_ROOT, frontendRoot = resolveFrontendRoot(), env = process.env } = {}) => {
  const mongod = findMongod(env);
  const mongodVersion = mongod ? firstLine(run(mongod, ["--version"]).stdout) : null;
  const browsersDir = playwrightBrowsersDir(env);
  let browsers = [];
  try { browsers = existsSync(browsersDir) ? readdirSync(browsersDir).filter((name) => !name.startsWith(".")).sort() : []; } catch { browsers = []; }
  const npm = run(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"]);
  return {
    node: process.version,
    npm: npm.status === 0 ? String(npm.stdout).trim() : null,
    platform: `${process.platform}-${process.arch}`,
    os: `${os.type()} ${os.release()}`,
    cpus: os.cpus().length,
    totalMemGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    mongod: { path: mongod, version: mongodVersion, note: mongod ? null : "no local mongod: mongodb-memory-server would download a binary" },
    vitest: {
      backend: readVersion(join(backendRoot, "node_modules", "vitest", "package.json")),
      frontend: readVersion(join(frontendRoot, "node_modules", "vitest", "package.json")),
    },
    playwright: {
      version: readVersion(join(frontendRoot, "node_modules", "@playwright", "test", "package.json")),
      browsersDir,
      browsers,
    },
    frontendDir: frontendRoot,
    frontendPresent: existsSync(join(frontendRoot, "package.json")),
    backendDotEnvPresent: existsSync(join(backendRoot, ".env")),
    flags: {
      CI: Boolean(env.CI),
      VIVASAYI_SKIP_DOTENV: env.VIVASAYI_SKIP_DOTENV ?? null,
      VIVASAYI_FRONTEND_DIR: env.VIVASAYI_FRONTEND_DIR ?? null,
      MONGOMS_SYSTEM_BINARY: env.MONGOMS_SYSTEM_BINARY ?? null,
    },
  };
};

export const FROZEN_HASHES_PATH = "docs/research/evaluation/live/FROZEN_HASHES.json";

const HEX64 = /^[0-9a-f]{64}$/i;

// Accepts the shapes a FROZEN_HASHES.json may reasonably take: { files: { path: sha } }, { files: [{ path, sha256 }] },
// or a flat { path: sha } map. Paths resolve against the repo root, then against the JSON file's own folder.
export const parseFrozenHashes = (json) => {
  const entries = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const path = item?.path ?? item?.file;
        const hash = item?.sha256 ?? item?.hash;
        if (typeof path === "string" && typeof hash === "string" && HEX64.test(hash)) entries.push({ path, sha256: hash.toLowerCase() });
      }
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (typeof value === "string" && HEX64.test(value) && /[./]/.test(key)) entries.push({ path: key, sha256: value.toLowerCase() });
        else if (value && typeof value === "object" && typeof value.sha256 === "string" && HEX64.test(value.sha256) && /[./]/.test(key)) {
          entries.push({ path: key, sha256: value.sha256.toLowerCase() });
        } else if (["files", "hashes", "artifacts", "frozen"].includes(key)) visit(value);
      }
    }
  };
  visit(json);
  return entries;
};

export const checkFrozenHashes = (repoRoot = BACKEND_ROOT, manifestPath = FROZEN_HASHES_PATH) => {
  const full = resolve(repoRoot, manifestPath);
  if (!existsSync(full)) return { status: "not_available", reason: `${manifestPath} does not exist yet`, checked: 0, mismatched: [], missing: [] };
  let entries;
  try { entries = parseFrozenHashes(JSON.parse(readFileSync(full, "utf8"))); } catch (error) {
    return { status: "error", reason: `cannot parse ${manifestPath}: ${error.message}`, checked: 0, mismatched: [], missing: [] };
  }
  if (entries.length === 0) return { status: "error", reason: `${manifestPath} lists no sha256 entries`, checked: 0, mismatched: [], missing: [] };
  const mismatched = [];
  const missing = [];
  const files = [];
  for (const entry of entries) {
    const candidates = [resolve(repoRoot, entry.path), resolve(dirname(full), entry.path)];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) { missing.push(entry.path); continue; }
    const actual = sha256(readFileSync(found));
    files.push({ path: relativeToRoot(repoRoot, found), expected: entry.sha256, actual });
    if (actual !== entry.sha256) mismatched.push({ path: relativeToRoot(repoRoot, found), expected: entry.sha256, actual });
  }
  return {
    status: mismatched.length === 0 && missing.length === 0 ? "passed" : "failed",
    reason: mismatched.length || missing.length ? `${mismatched.length} changed, ${missing.length} missing` : null,
    checked: entries.length,
    mismatched,
    missing,
    files,
  };
};

const SWEEP_EXCLUDES = new Set(["node_modules", ".git", "test-results", ".rag-local", "coverage", "dist", "playwright-report"]);

export const listJsFiles = (root) => {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SWEEP_EXCLUDES.has(entry.name) && !entry.name.startsWith(".")) walk(join(dir, entry.name));
      } else if (/\.(c|m)?js$/.test(entry.name)) out.push(join(dir, entry.name));
    }
  };
  walk(root);
  return out.sort();
};

// The backend has no lint or build step (critique B8), so every .js file gets a syntax check instead.
export const nodeCheckSweep = (root = BACKEND_ROOT) => {
  const files = listJsFiles(root);
  const failed = [];
  for (const file of files) {
    const result = run(process.execPath, ["--check", file], { timeoutMs: 30_000 });
    if (result.status !== 0) {
      failed.push({ file: relativeToRoot(root, file), error: String(result.stderr).split("\n").filter(Boolean).slice(0, 6).join("\n") });
    }
  }
  return { status: failed.length === 0 ? "passed" : "failed", checked: files.length, failed };
};
