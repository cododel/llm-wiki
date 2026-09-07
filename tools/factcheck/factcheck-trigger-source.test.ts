// Source-policy checks complement the disposable-repository integration test.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const text = readFileSync(new URL("./factcheck-trigger.ts", import.meta.url).pathname, "utf8");

test("automatic Git mutation is explicit opt-in", () => {
  expect(text).toContain('const AUTO_COMMIT = env.FACTCHECK_AUTO_COMMIT === "1"');
  expect(text).toContain("function commitGeneratedReadouts");
  expect(text).toContain("if (!AUTO_COMMIT) return");
  expect(text).toContain("docs(factcheck): record readouts for");
  expect(text).toContain('"--only"');
  expect(text).toContain("commitGeneratedReadouts(state)");
});

test("external commands and Hermes identity are parameterized", () => {
  expect(text).toContain("HERMES_BIN");
  expect(text).toContain("HERMES_PROFILE");
  expect(text).toContain("HERMES_SKILL");
  expect(text).toContain("FACTCHECK_TIMEOUT_BIN");
  expect(text).toContain("resolveWikiDir()");
});

test("no-op flag name is FACTCHECK_PRINT_NOOP", () => {
  expect(text).toContain("FACTCHECK_PRINT_NOOP");
  expect(text).toContain("const PRINT_NOOP");
  expect(text).toContain("if (!PRINT_NOOP) return");
});

test("generated readouts are normalized before the lint gate", () => {
  expect(text).toContain("normalizeGeneratedReadoutsForState(state);");
  expect(text).toContain("function normalizeGeneratedReadoutWikilinks");
  expect(text).toContain("BARE_WIKI_MD_PATH_RE");
  expect(text).toContain("wikiMdPathToWikilink");
});

test("prompts forbid bare md paths everywhere", () => {
  expect(text).toContain("This applies everywhere in the readout body");
  expect(text).toContain("This applies everywhere in the summary body");
  expect(text).toContain("Never write bare wiki paths");
});

// Ported from cron's test_inner_timeout_has_kill_margin_before_cron_timeout.
test("inner timeout has a kill margin before the cron timeout", () => {
  expect(text).toContain('const TIMEOUT_SEC = intEnv("FACTCHECK_TIMEOUT_SEC", 720)');
  expect(text).toContain('const TIMEOUT_KILL_AFTER_SEC = intEnv("FACTCHECK_TIMEOUT_KILL_AFTER_SEC", 30)');
  expect(text).toContain('"-k",');
  expect(text).toContain('`${TIMEOUT_KILL_AFTER_SEC}s`');
  expect(text).toContain('Math.ceil((TIMEOUT_SEC + TIMEOUT_KILL_AFTER_SEC) / 60) + 10');
});

// Ported from cron's test_queue_counts_running_separately_from_pending.
test("queue counts running separately from pending", () => {
  expect(text).toContain('running: state.batches.filter((b) => b.status === "running").length');
  expect(text).toContain("the queue is waiting for a running batch");
  expect(text).toContain("pending: ${q.pending}, failed: ${q.failed}");
});
