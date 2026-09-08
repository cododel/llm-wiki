# Execute factchecking through webhook dispatch and MCP feedback

Status: accepted
Date: 2026-09-08
Decision authority: explicit operator agreement in the repository design conversation.

## Context

The Hermes subprocess runner couples research to a particular CLI, profile, skill, and scheduler. The operator wants external execution, including a personal agent polling for work.

## Alternatives and rationale

Keep the Hermes runner, introduce local executable adapters, or use a network boundary. The operator chose webhook task delivery with authorized MCP feedback, and added proactive MCP polling so a dedicated executor is optional.

## Decision

Share one assignment lifecycle between execution-webhook delivery and authorized MCP polling. Keep research in the executor and durable assignment/result ownership in the wiki. Enable factchecking explicitly; persist escalation events for MCP and optional notification-webhook delivery.

## Consequences and invariants

Executor implementations can vary without changing wiki lifecycle semantics. Network failures, retries, leases, and duplicate delivery require explicit handling. Client scheduler support must be verified separately.

## Reversibility and revisit conditions

Revisit transport details if real executors cannot support the assignment lifecycle; retain one queue and durable completion semantics.

Current contract: [FACTCHECK_CONTRACT.md](../FACTCHECK_CONTRACT.md).
Related decisions: [decision index](README.md).

