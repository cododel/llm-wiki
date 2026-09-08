# Factcheck protocol contract

Status: accepted target; not a statement of current runtime capability.

## Activation and entrypoints

Factchecking requires an explicit instance-level opt-in. An authorized agent can poll through MCP to detect and obtain necessary work. With an execution webhook configured, a background detector can dispatch work automatically. Both paths share one logical queue and must not duplicate the same pending work.

A separate executor is optional. The personal agent can use the same assignment protocol. Scheduling belongs to the invoking scheduler or configured background service; no client-specific schedule capability is assumed.

## Detection and context

- Detect changes using content hashes against successfully checked versions, independently of Git commits.
- Pin each assignment to its source snapshots and a versioned workflow. Changes during execution remain eligible for a later check.
- Include bounded context, source references, expected result requirements, and assignment identity. Workflows travel with tasks; model/provider/profile configuration belongs to the external executor.
- Exclude runtime, packaging, preserved raw as verification targets, and self-generated factcheck evidence from recursive work generation. Raw remains available as research evidence. Fine-grained target eligibility is not yet selected.
- No eligible changes means no research dispatch. A first baseline and explicit recheck use the same bounded execution lifecycle; precise activation controls remain to be specified.

## Execution and feedback

Webhook acceptance acknowledges delivery, not successful research. Feedback uses authorized MCP operations for obtaining/reserving work, reporting progress, completing work, and reporting failure; the exact tool names remain unselected.

A reservation belongs to a verified executor for a bounded lease. Progress can renew the lease. Expired work is recoverable under a bounded retry policy. A stale executor must not overwrite a newer assignment outcome.

Repeated delivery and completion are idempotent. Conflicting repeated results are rejected. A task identifier is not a credential.

## Results and completion

- Account for every assigned page: checked, no verifiable claims, skipped with a reason, or blocked. No page may silently disappear from the result.
- Submit individual claims with their location in the checked snapshot, verdict, reasoning, cited evidence, and observation date. Verdicts distinguish confirmed, contradicted, unverified, and opinion.
- The service validates the structured result, builds readout metadata and references, calculates totals, and records completion. Semantic interpretation remains the agent's responsibility.
- Preserve the distinction between lack of evidence and contradiction. Evidence links and structural validity do not prove the truth or completeness of a result. Severity thresholds and source-authority classification have not been selected.
- A successful check may identify contradictions. It saves evidence and creates an operator-review event; it does not automatically edit the checked knowledge.
- Technical failure or an invalid/incomplete result does not advance successful verification state. Verification state advances only for the accepted snapshot after the required results and aggregate report are durably saved.
- Aggregate counts derive from accepted results. A narrative synthesis must not redo research merely to summarize completed batches.
- Writing readouts does not implicitly enable Git commits or pushes. The existing optional Git behavior is not a requirement of this network protocol.

## Escalation

Persist discrepancies, clarification requests, execution failures, and delivery/lease failures as observable events. Expose them through MCP to the personal agent and optionally deliver them to a separately configured notification webhook.

The service detects missing executors independently of executor self-reporting. Notification failure must not erase the event or undo accepted research. An acknowledged delivery must not be confused with operator resolution. Exact acknowledgement and notification retry interfaces remain to be specified.

## Acceptance anchors

Verify polling-only and webhook modes against the same queue; no-op behavior; duplicate dispatch; concurrent claims; lease expiry and stale completion; invalid results; changes during research; accepted contradictions versus failed execution; durable notifications through restart; and no automatic edits of checked pages.

Decision provenance: [network execution](adr/adr-20260908-network-factchecking.md), [content detection](adr/adr-20260908-content-hash-detection.md), [deterministic contracts](adr/adr-20260908-deterministic-service-contracts.md).
Related: [access](ACCESS_CONTRACT.md), [knowledge](KNOWLEDGE_CONTRACT.md).

