# Local acceptance evidence

## Expanded personal-use verification — 2026-09-11

Base revision: `a6a335d24dcad976a353e73ea121dfe09c5d2a0d`, with the local expanded-testing
changes. Runtime implementation and migrations were not changed by this work. The retained JSON
reports fingerprint both tracked and untracked source contents; this is not evidence for an
unmodified base checkout or a deployed instance.

The final baseline run passed **78 tests / 988 assertions**, strict TypeScript, package integrity,
both sequential capacity fixtures and the original real OAuth/Compose acceptance. Added scenarios
cover exact text and 20 MiB binary boundaries, patch preservation and append-only restoration,
seeded rollback/replay sequences, a lost HTTP response after commit, interrupted database writes,
attachment finalization failure, all 38 MCP tools across four domain identities, private edge and
attachment canaries, locked operations, interrupted legacy backfill, stale claims and delivery
checkpoint failure after a receiver's successful response.

The extended Compose probe additionally passed provider/database outage recovery and restoration
into a second isolated project with new databases and an attachment volume. The restored service
retained publication isolation and original hashes, continued an unfinished assignment and completed
a new authenticated write/publication cycle. Generated test authentication configuration and keys
were reused: this does not prove recovery of lost operator configuration or migration to another host.

The complete `bun run tools/verify.ts --extended` exited successfully. Both eight-client profiles
passed their final revision-count, sealed-history, queue-drain, private-canary and blob-byte checks:

| Fixture records | Measured duration | Completed cycles | Cycle latency p50 / p95 / max | Maximum sampled probe RSS |
| --- | --- | --- | --- | --- |
| 10,000 | 3,601.163 seconds | 21,404 | 240 / 835 / 6,217 ms | 173.42 MiB |
| 100,000 | 126.326 seconds | 89 | 8,591 / 20,583 / 21,404 ms | 56.94 MiB |

A cycle includes multiple operations, not one MCP request. The workload drains in-flight cycles
after its nominal duration. Resource samples observed at most 15 PostgreSQL connections and one
lock waiter; these are sampled observations, not enforced resource bounds. The 100k profile passed
correctness checks but does not demonstrate interactive responsiveness at that size. The environment
was Bun 1.3.14 on macOS ARM64 with PostgreSQL 17.11 in a local Linux container. In-memory MCP,
tmpfs storage and the short headroom duration limit generalization. No unexplained execution errors
were reported. The verifier's containers and named volumes were absent after completion.

Evidence comes from two runs: the full extended run began with 76 tests; the subsequent complete
baseline validated the final 78-test inventory. The running endurance source was hash-compared with
the final workload file. Later harness timeout/cleanup adjustments passed both focused process tests;
they did not change workload or product semantics. The baseline run overlapped the beginning of the
endurance run, so timings must not be treated as an isolated benchmark.

Independent read-only coverage and harness reviews led to stronger timeout failure handling,
source fingerprinting, retained CI reports, explicit failure metrics, private relationship markers,
lock checks and post-delivery rollback coverage. Reported findings were repaired and relevant checks
rerun. Manual extended CI is configured but was not remotely executed.

Real-agent acceptance and independent original capture through an actual client remain **not run**.
Automated source round trips prove preservation of received bytes, not faithful agent transcription.
The fixed operator scenarios and remaining gates are in [extended testing](EXTENDED_TESTING.md).
Do not infer sole-copy safety or completed personal-use acceptance from the automated results alone.

## Historical baseline — 2026-09-10

Date: 2026-09-10. Scope: fixed knowledge core and v2-to-v3 service evolution.
This report records local evidence, not deployment or third-party client certification.

The prior v2 baseline passed 47 tests. Final `bun run tools/verify.ts` passed 60 tests with strict TypeScript checking.
The command also passed package integrity and the full disposable Compose probe. The test
database and instance are generated in OS temporary storage; no operator data or credentials
are used. `git diff --check` and new-source whitespace checks passed.

| Boundary | Evidence |
|---|---|
| Content acceptance | Exact original bytes, retained source revisions, sealed edges, atomic rollback, idempotency conflicts, concurrent edit winner |
| Retrieval | Eleven retained read names, v2/v3 dispatch, cold-client describe/create/context, RU/EN FTS, regex, exact revisions, 201 reverse links with continuation |
| Fixed core | Title-only records, partial patches, source-plus-record atomic intake, skill dependencies, separate locks, topic label pinning, private ordered collections |
| Upgrade | Actual v2 schema fixture, partial backfill/restart, retained legacy metadata/history/publication/jobs/checkpoints, no migration-induced recheck, empty fresh initialization |
| Access | Subject/client/scope/audience/issuer checks, revoked/expired tokens, unavailable provider, no positive introspection cache |
| Publication | Real personal PKCE and separate browser OIDC, agent-token denial, CSRF, escaped content, private attachment inspection, stale approval, old public revision after private edit |
| Work | Bounded baseline across multiple passes, exclusions, claim race, lease recovery/progress, stale completion, invalid coverage, blocked terminal work, edited targets and source-order stability |
| Evidence and review | Full large structured result retained behind bounded readable report, no recursive generated checks, separate campaigns, derived totals, proposals without target edits |
| Delivery | HMAC event identity, retry delivery identity, delivery distinct from execution, retry availability aligned with claim availability |
| Recovery | Actual API/worker restart with saved progress; wiki tables including jobs/checkpoints/outbox restored; exact original blob hash; isolated Authelia database restored |
| Distribution | Optional body templates, working documentation links, pins, disabled defaults, no private corpus/dependencies/runtime state; PostgreSQL UID 70 reads only mounted required test secrets |

Independent read-only reviews inspected task-contract coverage and access/compatibility behavior.
Repairs add complete legacy metadata to owner approval previews, reject legacy taxonomy fallback
under v3, explicitly paginate reverse links, and align exact archived native reads with the
compatibility guard. Focused regressions accompany these fixes. Reviewers inspected source/tests;
they did not independently rerun the database suite. Targeted re-review closed all reported findings.

## Synthetic load probe

`tools/verify-service.ts` runs `tests/load-probe.ts` in its own disposable database. Each fixture
record has three revisions, with 10% exposing the first revision and a newer private current
revision. Fixtures are loaded through bounded SQL batches; write timings use the actual native
change service. Each operation has a warm-up and ten sequential measured runs. Probe-created
records add a few extra rows beyond the named fixture size. These are not concurrency tests or SLA.

Representative local run: Bun 1.3.14, PostgreSQL 17.11 Linux container on OrbStack/macOS ARM64,
loopback database connection, PostgreSQL data in tmpfs. Values are milliseconds, median / p95
(with ten samples, the reported p95 is the largest sample).

| Fixture records / revisions | Catalog | RU/EN FTS | Resolve | Five-record context | Create |
| --- | --- | --- | --- | --- | --- |
| 10,000 / 30,000 | 8.37 / 8.68 | 3.34 / 3.89 | 12.39 / 16.46 | 8.66 / 11.53 | 8.02 / 10.31 |
| 100,000 / 300,000 | 86.43 / 108.66 | 15.58 / 15.97 | 155.50 / 167.53 | 8.75 / 11.83 | 4.79 / 5.28 |

The catalog and title/slug resolution scan grows materially at 100k. No universal latency or
capacity guarantee is inferred. Real corpora, storage, concurrent agents and network conditions
need their own measurements before operational sizing.

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
- Local passing checks are not a substitute for review of future upgrades or production-shaped load testing.
- Container permissions were exercised with the real PostgreSQL UID inside Linux containers;
  this local run is not a separate bare-metal Linux-host certification.

Commands and recovery procedure: [operations](OPERATIONS.md). Normative boundaries:
[contracts](README.md). The selected stable Authelia pin is explained in the
[auth compatibility report](auth-compatibility-20260908.md).
