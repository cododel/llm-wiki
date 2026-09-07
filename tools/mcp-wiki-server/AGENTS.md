# MCP implementation contract

Read the root `AGENTS.md` and this module's README. This module is a readonly MCP server, not a write agent or a multi-user identity provider.

- `access.ts` is the sole authorization gate. Every returned page, snippet, relation, candidate, and provenance response must be gated. Read bodies through `readServable`; metadata must never be used to bypass path safety.
- Publication requires explicit `visibility: public`. Missing/malformed/duplicate metadata, unknown scope, traversal, symlink escape, and blocked paths fail closed. Admin remains read-only and cannot read operational directories.
- Stdout belongs to JSON-RPC; diagnostics go to stderr. Reindex with `quiet: true`.
- Reuse the FTS library rather than forking parsers/search. Tool checkout and `WIKI_DIR` are distinct: diagnostic scripts come from the checkout and receive the selected root explicitly.
- Keep direct dependencies exact-pinned and commit the lockfile. Runtime npm imports are dynamic. Never create `node_modules` in a vault; the isolated test harness installs into OS temp only.
- Add/run regression tests for changed behavior before implementation where execution is available. Gate changes require an adversarial allow/deny matrix and non-leakage tests across every tool. Never claim a red/green run that was not executed.
- Preserve typed boundary validation and make scoped changes. Report unrelated security concerns instead of silently changing publication metadata or deployment settings.
- Remote admin HTTP requires OAuth configuration; never add a static-token bypass. Do not log credentials, authorization codes, tokens, or private source data.

Verify with `bun run tools/mcp-wiki-server/test.ts` and the root `tools/verify.ts`. Read the actual output; test presence alone is not evidence of a passing run.
