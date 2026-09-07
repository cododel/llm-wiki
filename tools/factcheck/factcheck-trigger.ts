#!/usr/bin/env bun
/**
 * Wiki factcheck orchestrator.
 *
 * Runs small bounded Hermes factchecker batches instead of one giant weekly prompt.
 * The runner is optional and scheduler-agnostic. Stdout is concise so an
 * operator or an external scheduler can decide whether and where to notify.
 * This entrypoint intentionally keeps queue transitions, persisted state, and
 * Git side effects together: splitting them would duplicate the recovery
 * invariants that must be evaluated atomically on each scheduler invocation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveWikiDir } from "../lib/paths.ts";

const env = process.env;

const WIKI_DIR = resolveWikiDir();
const HERMES_BIN = env.HERMES_BIN?.trim() || "hermes";
const HERMES_PROFILE = env.HERMES_PROFILE?.trim() || "factchecker";
const HERMES_SKILL = env.HERMES_SKILL?.trim() || "wiki/factcheck-wiki";
const TIMEOUT_BIN = env.FACTCHECK_TIMEOUT_BIN?.trim() || "timeout";
const STAMP_FILE = env.FACTCHECK_STAMP_FILE ?? join(WIKI_DIR, ".factcheck-last-run");
const STATE_FILE = env.FACTCHECK_STATE_FILE ?? join(WIKI_DIR, ".factcheck-state.json");
const LOG_FILE = env.FACTCHECK_LOG_FILE ?? join(WIKI_DIR, ".factcheck-log.md");
const BATCH_SIZE = intEnv("FACTCHECK_BATCH_SIZE", 5);
const MAX_BATCHES_PER_RUN = intEnv("FACTCHECK_MAX_BATCHES_PER_RUN", 1);
const TIMEOUT_SEC = intEnv("FACTCHECK_TIMEOUT_SEC", 720);
const MAX_RETRIES = intEnv("FACTCHECK_MAX_RETRIES", 2);
const TIMEOUT_KILL_AFTER_SEC = intEnv("FACTCHECK_TIMEOUT_KILL_AFTER_SEC", 30);
const RUNNING_STALE_MINUTES = intEnv("FACTCHECK_RUNNING_STALE_MINUTES", Math.ceil((TIMEOUT_SEC + TIMEOUT_KILL_AFTER_SEC) / 60) + 10);
const PRINT_NOOP = env.FACTCHECK_PRINT_NOOP === "1";
const AUTO_COMMIT = env.FACTCHECK_AUTO_COMMIT === "1";

const fullMode = process.argv.includes("--full") || env.FACTCHECK_FULL === "1";

const CHECKABLE_EXCLUDE = /^(\.factcheck|\.hermes\/|raw\/|tools\/|templates\/|examples\/|docs\/|\.github\/|\.gitignore|_archive\/|README\.md|AGENTS\.md|SCHEMA\.md|index\.md|log(-\d{4}-\d{2}-\d{2})?\.md|readouts\/\d{4}-\d{2}-\d{2}-factcheck.*\.md)/;

type BatchStatus = "pending" | "running" | "done" | "failed";

type Batch = {
  id: string;
  files: string[];
  status: BatchStatus;
  attempts: number;
  readout: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
  error?: string;
};

type FactcheckState = {
  version: 1;
  mode: "incremental" | "full";
  baseSha: string | null;
  targetSha: string;
  targetShort: string;
  createdAt: string;
  updatedAt: string;
  batchSize: number;
  batches: Batch[];
  summaryReadout?: string;
  completedAt?: string;
};

type CmdResult = { code: number; stdout: string; stderr: string };

function intEnv(name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function now(): string {
  return new Date().toISOString();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): CmdResult {
  const res = Bun.spawnSync({
    cmd,
    cwd: opts.cwd ?? WIKI_DIR,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: res.exitCode ?? 1,
    stdout: new TextDecoder().decode(res.stdout ?? new Uint8Array()),
    stderr: new TextDecoder().decode(res.stderr ?? new Uint8Array()),
  };
}

function mustRun(cmd: string[], cwd = WIKI_DIR): string {
  const res = run(cmd, { cwd });
  if (res.code !== 0) {
    throw new Error(`${cmd.join(" ")} failed (${res.code})\n${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

function commitGeneratedReadouts(state: FactcheckState): void {
  if (!AUTO_COMMIT) return;
  const readouts = generatedReadoutsForState(state).filter((p) => existsSync(join(WIKI_DIR, p)));
  if (readouts.length === 0) return;

  const add = run(["git", "add", ...readouts], { cwd: WIKI_DIR });
  if (add.code !== 0) {
    appendLog(`${now()}: factcheck readout git add failed: ${add.stderr || add.stdout}`);
    return;
  }

  const diff = run(["git", "diff", "--cached", "--quiet", "--", ...readouts], { cwd: WIKI_DIR });
  if (diff.code === 0) return;

  const commit = run([
    "git",
    "commit",
    "--only",
    "-m",
    `docs(factcheck): record readouts for ${state.targetShort}`,
    "--",
    ...readouts,
  ], { cwd: WIKI_DIR });
  if (commit.code !== 0) {
    appendLog(`${now()}: factcheck readout commit failed: ${commit.stderr || commit.stdout}`);
    return;
  }

  appendLog(`${now()}: committed factcheck readouts for ${state.targetShort}`);
}

function validateGeneratedReadoutsForCommit(state: FactcheckState): boolean {
  normalizeGeneratedReadoutsForState(state);

  const res = run([process.execPath, "run", "tools/wiki_lint.ts", "--json"], { cwd: WIKI_DIR });
  if (res.code !== 0 && !res.stdout.trim()) {
    appendLog(`${now()}: factcheck readout lint gate failed to run: ${res.stderr || res.stdout}`);
    return false;
  }

  try {
    const lint = JSON.parse(res.stdout);
    const badSources = Array.isArray(lint.bad_sources) ? lint.bad_sources.length : 0;
    const badWikilinks = Array.isArray(lint.bad_wikilinks) ? lint.bad_wikilinks.length : 0;
    if (badSources > 0 || badWikilinks > 0) {
      appendLog(`${now()}: factcheck readout lint gate blocked commit (${badSources} bad_sources, ${badWikilinks} bad_wikilinks)`);
      console.log("Wiki factcheck: generated readouts failed the lint gate.");
      console.log(`Bad sources: ${badSources}; bad wikilinks: ${badWikilinks}`);
      console.log("The stamp was not updated; repair the readouts or prompt and retry.");
      return false;
    }
    return true;
  } catch (err) {
    appendLog(`${now()}: factcheck readout lint gate JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

const BARE_WIKI_MD_PATH_RE = /(?<![\[\w])(concepts|ideas|entities|notes|comparisons|queries|drafts|pages|readouts)\/(?:[A-Za-z0-9][-A-Za-z0-9_]*\/)*[A-Za-z0-9][-A-Za-z0-9_]*\.md(?![\]\w])/g;

function frontmatterEndOffset(text: string): number {
  if (!text.startsWith("---\n")) return 0;
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return 0;
  return end + "\n---\n".length;
}

function wikiMdPathToWikilink(path: string): string {
  let target = path.replace(/\.md$/, "");
  target = target.replace(/\/README$/, "");
  return `[[${target}]]`;
}

function normalizeGeneratedReadoutWikilinks(relPath: string): boolean {
  const fullPath = join(WIKI_DIR, relPath);
  if (!existsSync(fullPath)) return false;

  const text = readFileSync(fullPath, "utf8");
  const bodyOffset = frontmatterEndOffset(text);
  const head = text.slice(0, bodyOffset);
  const body = text.slice(bodyOffset);
  const normalizedBody = body.replace(BARE_WIKI_MD_PATH_RE, (match) => wikiMdPathToWikilink(match));
  if (normalizedBody === body) return false;

  writeFileSync(fullPath, head + normalizedBody);
  appendLog(`${now()}: normalized bare .md wiki paths in ${relPath}`);
  return true;
}

function normalizeGeneratedReadoutsForState(state: FactcheckState): void {
  for (const relPath of generatedReadoutsForState(state)) {
    normalizeGeneratedReadoutWikilinks(relPath);
  }
}

function appendLog(text: string): void {
  writeFileSync(LOG_FILE, text + "\n", { flag: "a" });
}

function readStamp(): string | null {
  if (!existsSync(STAMP_FILE)) return null;
  const value = readFileSync(STAMP_FILE, "utf8").trim();
  return value.length > 0 ? value : null;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function readState(): FactcheckState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (parsed?.version === 1 && Array.isArray(parsed?.batches)) return parsed as FactcheckState;
  } catch {
    // Treat corrupt state as absent; do not delete it.
  }
  return null;
}

function saveState(state: FactcheckState): void {
  state.updatedAt = now();
  writeJson(STATE_FILE, state);
}

function isCheckable(path: string): boolean {
  return path.endsWith(".md") && !CHECKABLE_EXCLUDE.test(path);
}

function nonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function uniqueSorted(paths: string[]): string[] {
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function readoutPath(targetShort: string, id: string): string {
  return `readouts/${today()}-factcheck-${targetShort}-batch-${id}.md`;
}

function summaryReadoutPath(targetShort: string): string {
  return `readouts/${today()}-factcheck-${targetShort}-summary.md`;
}

function generatedReadoutsForState(state: FactcheckState): string[] {
  const paths = state.batches.map((b) => b.readout);
  if (state.summaryReadout) paths.push(state.summaryReadout);
  return paths;
}

function buildState(mode: "incremental" | "full", baseSha: string | null, targetSha: string, files: string[]): FactcheckState {
  const targetShort = targetSha.slice(0, 12);
  const batches = chunk(files, BATCH_SIZE).map((filesForBatch, idx) => {
    const id = String(idx + 1).padStart(2, "0");
    return {
      id,
      files: filesForBatch,
      status: "pending" as const,
      attempts: 0,
      readout: readoutPath(targetShort, id),
    };
  });
  return {
    version: 1,
    mode,
    baseSha,
    targetSha,
    targetShort,
    createdAt: now(),
    updatedAt: now(),
    batchSize: BATCH_SIZE,
    batches,
  };
}

function discoverFiles(current: string, stamp: string | null): { raw: string[]; checkable: string[]; mode: "incremental" | "full"; baseSha: string | null } {
  if (fullMode) {
    const raw = nonEmptyLines(mustRun(["git", "ls-files", "*.md"]));
    return { raw, checkable: uniqueSorted(raw.filter(isCheckable)), mode: "full", baseSha: stamp };
  }

  if (!stamp) {
    console.log("Wiki factcheck: no stamp exists, so the incremental run was skipped.");
    console.log("Run an explicit baseline: FACTCHECK_FULL=1 bun run tools/factcheck/factcheck-trigger.ts");
    process.exit(0);
  }

  if (stamp === current) {
    return { raw: [], checkable: [], mode: "incremental", baseSha: stamp };
  }

  const diff = run(["git", "diff", "--name-only", stamp, current, "--", "*.md"]);
  if (diff.code !== 0) {
    throw new Error(`git diff failed from stamp ${stamp} to ${current}:\n${diff.stderr || diff.stdout}`);
  }
  const raw = uniqueSorted(nonEmptyLines(diff.stdout));
  return { raw, checkable: uniqueSorted(raw.filter(isCheckable)), mode: "incremental", baseSha: stamp };
}

function promptForBatch(state: FactcheckState, batch: Batch): string {
  const files = batch.files.join("\n");
  return `Wiki factcheck ${state.mode} batch ${batch.id}/${state.batches.length}.

Target SHA: ${state.targetSha}
Base SHA: ${state.baseSha ?? "<none/full baseline>"}
Batch readout path: ${WIKI_DIR}/${batch.readout}

Files to check (${batch.files.length}):
${files}

Workflow:
1. Read ${WIKI_DIR}/SCHEMA.md, ${WIKI_DIR}/index.md, and recent ${WIKI_DIR}/log.md first.
2. For each listed file, extract verifiable factual claims.
3. Verify claims with current authoritative sources and cite the evidence.
4. Categorize each claim as confirmed, contradicted, unverified, or opinion.
5. Append concise findings to ${LOG_FILE}.
6. Write this batch readout to ${WIKI_DIR}/${batch.readout}. Do not overwrite unrelated readouts.
   - Reference every checked file with an Obsidian wikilink using the shortest unambiguous target. Strip only the .md extension, but keep enough path to avoid ambiguity and nested-page loss: ideas/foo.md → [[foo]] when unique; concepts/topic/architecture.md → [[concepts/topic/architecture]]; ideas/project/README.md → [[ideas/project]].
   - In a ## Checked files section, list each file as a wikilink bullet.
   - This applies everywhere in the readout body: headings, issue titles, tables, bold text, and prose. Never write bare wiki paths like entities/foo.md or drafts/posts/foo.md; write [[entities/foo]] / [[drafts/posts/foo]] instead.
   - sources: must be [] unless you are citing raw material from raw/. Do not list checked wiki pages in sources:; the wikilinks in Checked files already reference them.
7. Final answer only: files checked, claims found, verdict counts, HIGH/MEDIUM issues.

Do not update ${STAMP_FILE}. The orchestrator owns the stamp.`;
}

function promptForSummary(state: FactcheckState, readout: string): string {
  const batchReadouts = state.batches.map((b) => b.readout).join("\n");
  return `Synthesize completed wiki factcheck batches into one final summary readout.

Target SHA: ${state.targetSha}
Summary readout path: ${WIKI_DIR}/${readout}

Batch readouts:
${batchReadouts}

Workflow:
1. Read every batch readout listed above.
2. Do NOT redo web verification; synthesize the existing batch findings.
3. Write ${WIKI_DIR}/${readout} with totals, top HIGH/MEDIUM issues, and recommended fixes.
   - Reference every checked file with an Obsidian wikilink, exactly as the batch readouts do: shortest unambiguous target, extensionless, with path kept for nested/ambiguous/README cases.
   - In a ## Checked files section, list each file as a wikilink subheading.
   - This applies everywhere in the summary body: headings, issue titles, tables, bold text, and prose. Never write bare wiki paths like entities/foo.md or drafts/posts/foo.md; write [[entities/foo]] / [[drafts/posts/foo]] instead.
   - sources: must be [] (empty list) unless you are citing raw material from raw/. Do NOT list checked wiki pages or batch readouts in sources:.
4. Append a concise summary line to ${LOG_FILE}.
5. Final answer only: total files, claims, verdict counts if available, top issues, summary path.

Do not update ${STAMP_FILE}. The orchestrator owns the stamp.`;
}

function runHermes(prompt: string): CmdResult {
  return run([
    TIMEOUT_BIN,
    "-k",
    `${TIMEOUT_KILL_AFTER_SEC}s`,
    String(TIMEOUT_SEC),
    HERMES_BIN,
    "-p",
    HERMES_PROFILE,
    "chat",
    "-s",
    HERMES_SKILL,
    "-Q",
    "--max-turns",
    "80",
    "-q",
    prompt,
  ]);
}

function ensureReadout(path: string): boolean {
  return existsSync(join(WIKI_DIR, path));
}

function tail(text: string, max = 1800): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return "…" + trimmed.slice(trimmed.length - max);
}

function noop(lines: string[]): void {
  if (!PRINT_NOOP) return;
  for (const line of lines) console.log(line);
}

function formatCompletionSummary(readoutRelPath: string): string | null {
  const fullPath = join(WIKI_DIR, readoutRelPath);
  if (!existsSync(fullPath)) return null;
  const content = readFileSync(fullPath, "utf8");

  // Support the established English summary format without making notification
  // transport part of the factcheck contract.
  const metrics: Record<string, string> = {};
  const metricsStart = content.indexOf("| Metric");
  if (metricsStart === -1) return null;
  const metricsEnd = content.indexOf("\n\n", metricsStart);
  const metricsBlock = metricsEnd !== -1 ? content.slice(metricsStart, metricsEnd) : content.slice(metricsStart);
  for (const line of metricsBlock.split("\n")) {
    const m = line.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/);
    if (m && m[1] !== "Metric") metrics[m[1].trim()] = m[2].trim().replace(/\*\*/g, "");
  }

  // Extract the per-file table when the summary contains one.
  const fileRows: string[] = [];
  const filesAnchor = content.indexOf("| File | Claims");
  if (filesAnchor !== -1) {
    // Find the end of the table: next blank line after the table header
    const afterAnchor = content.slice(filesAnchor);
    const tableEnd = afterAnchor.indexOf("\n\n");
    const filesBlock = tableEnd !== -1 ? afterAnchor.slice(0, tableEnd) : afterAnchor;
    for (const line of filesBlock.split("\n")) {
      const m = line.match(/^\|\s*(.+?)\s*\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/);
      if (m && m[1] !== "File" && !m[1].startsWith("-")) {
        const fname = m[1].replace(/\.md$/, "");
        const [claims, ok, warn, opinion] = [m[2], m[3], m[4], m[5]];
        const flags: string[] = [];
        if (warn.trim() !== "0") flags.push(`${warn.trim()} unverified`);
        if (opinion.trim() !== "0") flags.push(`${opinion.trim()} opinion`);
        const flagStr = flags.length ? ` (${flags.join(" ")})` : "";
        fileRows.push(`${fname}: ${ok.trim()} confirmed${flagStr}`);
      }
    }
  }

  // Count issues from metrics (more reliable than regex on full content)
  const highCount = parseInt(metrics["HIGH"] || "0", 10);
  const medCount = parseInt(metrics["MEDIUM"] || "0", 10);

  const lines: string[] = [];
  const hasFindings = parseInt(metrics["Unverified"] || "0", 10) > 0 || parseInt(metrics["Contradicted"] || "0", 10) > 0;
  if (!hasFindings) return null; // silent when everything is clean

  lines.push("Wiki factcheck");
  lines.push("");
  lines.push(`Checked: ${metrics["Files checked"] || "?"} files, ${metrics["Claims"] || "?"} claims`);
  lines.push(`Confirmed ${metrics["Confirmed"] || "0"}; unverified ${metrics["Unverified"] || "0"}; contradicted ${metrics["Contradicted"] || "0"}; opinion ${metrics["Opinion"] || "0"}`);
  if (highCount > 0 || medCount > 0) {
    const issueParts: string[] = [];
    if (highCount > 0) issueParts.push(`${highCount} HIGH`);
    if (medCount > 0) issueParts.push(`${medCount} MEDIUM`);
    lines.push(`Issues: ${issueParts.join("  ")}`);
  }
  if (fileRows.length) {
    lines.push("");
    lines.push(...fileRows);
  }
  lines.push("");
  lines.push(`Details: ${WIKI_DIR}/${readoutRelPath}`);

  return lines.join("\n");
}

function runOneBatch(state: FactcheckState, batch: Batch): boolean {
  batch.status = "running";
  batch.startedAt = now();
  batch.attempts += 1;
  batch.exitCode = undefined;
  batch.error = undefined;
  saveState(state);

  const res = runHermes(promptForBatch(state, batch));
  batch.exitCode = res.code;

  if (res.code === 0 && ensureReadout(batch.readout)) {
    batch.status = "done";
    batch.completedAt = now();
    saveState(state);
    return true;
  }

  batch.status = "failed";
  batch.error = res.code === 124
    ? `timeout after ${TIMEOUT_SEC}s`
    : res.code === 0
      ? `Hermes exited 0 but readout was not created: ${batch.readout}`
      : `Hermes exit ${res.code}: ${tail(res.stderr || res.stdout)}`;
  appendLog(`${now()}: factcheck batch ${batch.id} failed: ${batch.error}`);
  saveState(state);
  return false;
}

function runSummary(state: FactcheckState): boolean {
  const readout = state.summaryReadout ?? summaryReadoutPath(state.targetShort);
  state.summaryReadout = readout;
  saveState(state);

  const res = runHermes(promptForSummary(state, readout));
  if (res.code === 0 && ensureReadout(readout)) {
    if (!validateGeneratedReadoutsForCommit(state)) return false;
    state.completedAt = now();
    saveState(state);
    writeFileSync(STAMP_FILE, state.targetSha + "\n");
    return true;
  }

  const error = res.code === 124
    ? `summary timeout after ${TIMEOUT_SEC}s`
    : res.code === 0
      ? `summary exited 0 but readout was not created: ${readout}`
      : `summary exit ${res.code}: ${tail(res.stderr || res.stdout)}`;
  appendLog(`${now()}: factcheck summary failed: ${error}`);
  console.log("Wiki factcheck: batches are complete, but the summary was not created.");
  console.log(`Target: ${state.targetShort}`);
  console.log(`Error: ${error}`);
  console.log("The stamp was not updated; the next run will retry the summary.");
  return false;
}

function printableQueue(state: FactcheckState): { done: number; failed: number; pending: number; running: number; total: number } {
  return {
    done: state.batches.filter((b) => b.status === "done").length,
    failed: state.batches.filter((b) => b.status === "failed").length,
    pending: state.batches.filter((b) => b.status === "pending").length,
    running: state.batches.filter((b) => b.status === "running").length,
    total: state.batches.length,
  };
}

function main(): void {
  const current = mustRun(["git", "rev-parse", "HEAD"]);
  const stamp = readStamp();
  const existing = readState();

  if (existing && !existing.completedAt) {
    // Resume an in-flight queue even if HEAD moved after the queue was created.
    // Long full baselines can run for hours while docs/tooling commits happen;
    // rebuilding the queue on targetSha !== HEAD would discard completed batches.
    processState(existing);
    return;
  }

  const discovered = discoverFiles(current, stamp);

  if (!fullMode && stamp === current) {
    noop(["Wiki factcheck: no changes.", `HEAD/stamp: ${current.slice(0, 12)}`]);
    return;
  }

  if (discovered.checkable.length === 0) {
    if (discovered.raw.length === 0) {
      writeFileSync(STAMP_FILE, current + "\n");
      noop(["Wiki factcheck: no Markdown changes.", "Stamp updated.", `HEAD/stamp: ${current.slice(0, 12)}`]);
      return;
    }
    writeFileSync(STAMP_FILE, current + "\n");
    noop([
      "Wiki factcheck: Markdown changed, but no checkable files were found.",
      `Raw markdown diff: ${discovered.raw.length}`,
      "Stamp updated to avoid repeating an ignored-only diff.",
      `HEAD/stamp: ${current.slice(0, 12)}`,
    ]);
    return;
  }

  const state = buildState(discovered.mode, discovered.baseSha, current, discovered.checkable);
  saveState(state);
  processState(state);
}

function processState(state: FactcheckState): void {
  const staleBefore = Date.now() - RUNNING_STALE_MINUTES * 60_000;
  let recoveredStale = false;
  for (const batch of state.batches) {
    if (batch.status !== "running") continue;
    if (ensureReadout(batch.readout)) {
      batch.status = "done";
      batch.completedAt = batch.completedAt ?? now();
      appendLog(`${now()}: factcheck batch ${batch.id} marked done because readout already exists`);
      recoveredStale = true;
      continue;
    }
    const startedAt = batch.startedAt ? Date.parse(batch.startedAt) : Number.NaN;
    if (!Number.isFinite(startedAt) || startedAt < staleBefore) {
      batch.status = "failed";
      batch.error = `stale running batch recovered after ${RUNNING_STALE_MINUTES} minutes`;
      batch.exitCode = undefined;
      appendLog(`${now()}: factcheck batch ${batch.id} marked failed for stale running recovery`);
      recoveredStale = true;
    }
  }
  if (recoveredStale) saveState(state);

  const runnable = state.batches.filter((b) =>
    b.status === "pending" || (b.status === "failed" && b.attempts < MAX_RETRIES)
  );

  if (runnable.length === 0 && state.batches.some((b) => b.status !== "done")) {
    const q = printableQueue(state);
    const running = state.batches.find((b) => b.status === "running");
    if (running) {
      console.log("Wiki factcheck: the queue is waiting for a running batch.");
      console.log(`Target: ${state.targetShort}`);
      console.log(`Running: ${running.id}/${state.batches.length}, startedAt: ${running.startedAt ?? "unknown"}`);
      console.log(`Done: ${q.done}/${q.total}, pending: ${q.pending}, failed: ${q.failed}`);
      console.log(`State: ${STATE_FILE}`);
      return;
    }
    console.log("Wiki factcheck: the queue is blocked by failed batches.");
    console.log(`Target: ${state.targetShort}`);
    console.log(`Done: ${q.done}/${q.total}, pending: ${q.pending}, failed: ${q.failed}`);
    console.log(`State: ${STATE_FILE}`);
    process.exit(1);
  }

  const toRun = runnable.slice(0, MAX_BATCHES_PER_RUN);
  const completedThisRun: Batch[] = [];

  for (const batch of toRun) {
    const ok = runOneBatch(state, batch);
    if (!ok) {
      const q = printableQueue(state);
      console.log("Wiki factcheck batch failed.");
      console.log(`Target: ${state.targetShort}`);
      console.log(`Batch: ${batch.id}/${state.batches.length}`);
      console.log(`Error: ${batch.error}`);
      console.log(`Done: ${q.done}/${q.total}, remaining: ${q.pending + q.running + q.failed}`);
      console.log("The stamp was not updated.");
      process.exit(batch.exitCode && batch.exitCode > 0 ? batch.exitCode : 1);
    }
    completedThisRun.push(batch);
  }

  const q = printableQueue(state);
  if (q.done === q.total) {
    if (completedThisRun.length > 0 && (!state.summaryReadout || !ensureReadout(state.summaryReadout))) {
      appendLog(`${now()}: all batches done (${state.batches.length}), summary deferred to next tick`);
      return;
    }

    if (!state.summaryReadout || !ensureReadout(state.summaryReadout)) {
      const ok = runSummary(state);
      if (!ok) process.exit(1);
    } else {
      if (!validateGeneratedReadoutsForCommit(state)) process.exit(1);
      writeFileSync(STAMP_FILE, state.targetSha + "\n");
      state.completedAt = state.completedAt ?? now();
      saveState(state);
    }

    // Completion: optional compact stdout summary. Git mutation remains opt-in.
    commitGeneratedReadouts(state);
    const summaryPath = state.summaryReadout ?? summaryReadoutPath(state.targetShort);
    const compact = formatCompletionSummary(summaryPath);
    if (compact) {
      console.log(compact);
    }
    appendLog(`${now()}: factcheck complete (${state.mode}, ${state.batches.reduce((n, b) => n + b.files.length, 0)} files, ${state.batches.length} batches)`);
    return;
  }

  // Intermediate progress is logged without producing routine stdout noise.
  appendLog(`${now()}: batch run done (${completedThisRun.length} this tick, ${q.done}/${q.total} total, ${q.pending + q.running + q.failed} remaining)`);
}

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  appendLog(`${now()}: factcheck orchestrator failed: ${message}`);
  console.log("Wiki factcheck orchestrator failed.");
  console.log(message);
  process.exit(1);
}
