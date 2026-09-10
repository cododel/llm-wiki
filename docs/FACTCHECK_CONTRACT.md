# Agent work and evidence contract

Status: normative service v2 contract. Agents are external executors, not subprocesses of wiki.

## Two independently enabled processes

Incremental factcheck is disabled by default. First activation fills a bounded queue with eligible
unverified current content, then detects content/evidence fingerprint changes. A detection pass
adds at most 100 jobs and keeps at most 100 pending/running incremental jobs. Further passes
drain the initial corpus progressively. Raw, meta, ADR and generated reports are excluded as
targets; notes, ideas, drafts and ordinary readouts are included. Raw remains evidence.

Fingerprint includes type, title, body, explicit source revisions/URLs and attachments, not
timestamps, status, publication, tags, slug or workflow state. Evidence refers to exact revisions:
updating a source does not silently retarget a processed record's provenance.

Review is independently disabled. An explicit campaign fixes selected current revisions;
an independently configured interval can create a corpus campaign. A campaign does not replace
incremental checkpoints. Review may propose staleness, duplicates or useful relationships,
but never applies content corrections. Historical snapshots are evidence, not a promise to
verify truth at a historical date.

## Shared assignment lifecycle

MCP polling and optional execution webhooks use the same durable PostgreSQL queue.
Assignments contain protocol/workflow versions, ID, pinned snapshot, bounded context, source
references and the actual structured result schema. The current batch size is one record.
Instructions contain no local profile, shell, Git, cron or provider-specific Batch API assumptions.

A delivered HTTP response is not completion. Both recipients must claim atomically before
research. Claims bind to executor identity, token and lease. Each process has independent
concurrency; progress persists and renews the lease. Expired claims cannot complete or overwrite
a replacement result. Recovery preserves progress, delays retry by one minute, dispatches a new
delivery only once work is claimable, and stops after configured maximum attempts.
Pending work without an executor produces a durable event after one day.

An edit during research remains separate future work. Successful duplicate completion with the
same owned claim and payload replays; a different payload conflicts. Invalid or incomplete
results leave no successful checkpoint. Skipped/blocked results retain a reason and become
terminal for that fingerprint, preventing an immediate infinite loop. Explicit review can
revisit unchanged content.

## Results and reports

Cover exactly every assigned snapshot. Claims provide exact UTF-16 character offsets and quote,
verdict, reasoning, HTTP(S) evidence and observation dates. Confirmed/contradicted claims require
evidence. Checked coverage requires claims; no_claims/skipped/blocked require reasons.
The service validates structure and snapshot binding, not truth or evidence quality.

The service preserves the full structured result and creates a bounded immutable generated readout,
source links, audit and, for successful
incremental work, checkpoint atomically with accepted results. Contradiction is a completed check;
technical failure, blocked or partial work is not. Generated reports never recursively enqueue.
Readouts contain bounded claim previews; `wiki_assignment_result` returns the full accepted
evidence without losing long reasoning. Campaign summaries derive progress, verdict totals and proposal counts from stored results
without new research. No automatic corrections or Git operations occur.

## Delivery and escalation

Operator-configured HTTPS destinations are separate for factcheck, review and notifications.
Outbox events carry an event UUID and timestamped HMAC signature over the exact request body.
Receivers verify freshness/signature, deduplicate event IDs and still claim via authenticated MCP.
Secrets never enter task context. Redirects are not followed; network time and retry count are
bounded. Delivery failure cannot erase accepted evidence.

Discrepancies, clarifications, execution, delivery and lease failures remain queryable through
MCP regardless of notification delivery. Delivery, acknowledgement and resolution are independent.
Personal-agent event handling is audited. Optional notifications cannot recursively generate an
unbounded notification-failure loop.

Verification anchors: first pass/exclusions, polling/webhook claim race, retry timing, stale
completion, partial results, edited targets, nonrecursive reports, separate review, retained
progress, signed duplicate delivery, durable events and snapshot-derived totals.

Decisions: [network workflow](adr/adr-20260908-network-factchecking.md),
[content detection](adr/adr-20260908-content-hash-detection.md).
