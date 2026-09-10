# Knowledge service development contract

This repository contains a standalone single-owner knowledge service, not an instance's knowledge. Read `docs/README.md` and the relevant living contracts before changing stable behavior.

## Authority

- An implementation request permits scoped local code, tests and documentation changes. It does not permit importing personal knowledge, publishing, deploying, connecting external accounts, enabling schedules or mutating operator databases.
- Work only against proven disposable test databases. Never use an operator's `DATABASE_URL` for tests.
- Preserve accepted ADR reasoning. Record significant operator-approved changes in successors or separate decisions.
- English is the documentation and synthetic fixture language.

## Ownership

- `src/content` owns revisions, taxonomy, provenance and publication.
- `src/auth` verifies external identities and browser sessions; it does not issue OAuth tokens.
- `src/storage` owns PostgreSQL migrations and immutable original bytes.
- `src/search` searches authorized revisions before ranking.
- `src/factcheck` owns detection, snapshots, claim/lease, results and escalation.
- `src/delivery` owns signed outbox delivery, not successful research.
- `src/mcp` owns strict v2 tool schemas; `src/runtime` composes API and worker.
- No shell, arbitrary filesystem access or auth-configuration operations may be exposed through MCP.

## Invariants

Source bytes, accepted revisions and their relationships are immutable. Current and published revisions differ. Agent tokens never confirm publication. Publication, factcheck and periodic review start disabled. Agents do not manually maintain a filesystem index or Git history of knowledge.

Scopes do not assign roles: require a verified subject/client pair in external local configuration. Introspection runs on every authorized HTTP request and fails closed. Gate content, metadata, links, counts, excerpts and attachments before disclosure.

## Verification and runtime

Use Bun with the pinned manifest and lockfile. Dependencies belong in the image or OS-temp test workspace, never the repository or data volumes. Do not run `bun install` without `--lockfile-only` in this checkout.

`bun run tools/verify.ts` is the complete local acceptance command. It creates only isolated test resources and must clean them even on failure. Security changes require allow/deny and non-leakage tests. Changing a test expectation requires approved semantics or a demonstrated defect in the test.

No supported Markdown-vault runtime, embedded OAuth, Hermes subprocess runner, SQLite search index, Obsidian dependency or Git-based knowledge write remains. Templates are editorial scaffolds, not an alternate persistence interface.
