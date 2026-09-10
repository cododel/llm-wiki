# Local acceptance evidence

Date: 2026-09-10. Scope: standalone service replacement of the Markdown template.
This report records local evidence, not deployment or third-party client certification.

`bun run tools/verify.ts` passed with 47 tests, no failures and strict TypeScript checking.
The command also passed package integrity and the full disposable Compose probe. The test
database and instance are generated in OS temporary storage; no operator data or credentials
are used. `git diff --check` and new-source whitespace checks passed.

| Boundary | Evidence |
|---|---|
| Content acceptance | Exact original bytes, retained source revisions, sealed edges, atomic rollback, idempotency conflicts, concurrent edit winner |
| Retrieval | Eleven read tool names, v2 stable IDs, RU/EN FTS, regex/line evidence, heading sections, ambiguity and private-target filtering |
| Access | Subject/client/scope/audience/issuer checks, revoked/expired tokens, unavailable provider, no positive introspection cache |
| Publication | Real personal PKCE and separate browser OIDC, agent-token denial, CSRF, escaped content, private attachment inspection, stale approval, old public revision after private edit |
| Work | Bounded baseline across multiple passes, exclusions, claim race, lease recovery/progress, stale completion, invalid coverage, blocked terminal work, edited targets and source-order stability |
| Evidence and review | Full large structured result retained behind bounded readable report, no recursive generated checks, separate campaigns, derived totals, proposals without target edits |
| Delivery | HMAC event identity, retry delivery identity, delivery distinct from execution, retry availability aligned with claim availability |
| Recovery | Actual API/worker restart with saved progress; wiki tables including jobs/checkpoints/outbox restored; exact original blob hash; isolated Authelia database restored |
| Distribution | Twelve body templates, working local documentation links, pinned dependencies/images, disabled defaults, no private corpus, local dependencies or legacy runtime |

Two independent read-only review vectors inspected requirements and security/lifecycle behavior.
Four deduplicated defects were corrected and rechecked: mutable taxonomy disclosure, order-sensitive
provenance fingerprints, oversized generated reports, and unaccepted final blob cleanup.
Regression tests accompany those repairs. Re-review found no remaining blocker in those vectors;
the reviewers did not independently rerun the database suite.

## Replaced test scenarios

Old file-frontmatter parsing, folder/README resolution, WIKI_DIR/SQLite, embedded OAuth, stdio and
Git/Hermes subprocess tests no longer describe supported behavior. Their transferable guarantees
are covered by typed-input/source/graph tests, PostgreSQL search, HTTP MCP, real external OAuth,
assignment lifecycle and package isolation tests. The old runtime and tests remain recoverable
from repository history; they are not kept as a second backend.

## Explicit limits

- No real ChatGPT reconnect or scheduled external execution was performed. Those are operator tests.
- The owner browser flow was exercised as real HTTPS/OIDC/form requests, not a visual browser UI audit.
- Attachment format sniffing and checksums are not malware scanning or full document validation.
- Backup/restore evidence uses synthetic disposable data; operators must test their own backups.
- No push, deployment, external account connection or production data mutation was performed.
- Local passing checks are not a substitute for review of future provider/image upgrades or load testing.

Commands and recovery procedure: [operations](OPERATIONS.md). Normative boundaries:
[contracts](README.md). The selected stable Authelia pin is explained in the
[auth compatibility report](auth-compatibility-20260908.md).
