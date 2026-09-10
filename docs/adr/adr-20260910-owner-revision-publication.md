# Require owner confirmation of exact publication revisions

Status: accepted
Date: 2026-09-10
Decision authority: operator-approved service implementation plan.

## Context and alternatives

The template exposed explicitly marked Markdown pages. A writable service cannot
treat a personal agent's full content permission as permission to publish on the
owner's behalf. Publishing the moving current revision would also expose later
private edits without another review.

## Decision and rationale

An agent may request publication of a concrete revision and selected attachments.
Only the distinct owner browser identity confirms it, with session, CSRF and stale
revision checks. Keep the current and published revision pointers separate.
Factchecking informs the owner but does not veto the owner's decision.

## Consequences and revisit conditions

A small approval page is required even though a full editor UI is out of scope.
The old approved revision remains public while edits stay private. The additional
human step is intentional; no confirmation MCP tool is provided. Revisit only if
the operator explicitly changes the publication authority boundary.

Current contract: [access](../ACCESS_CONTRACT.md).
Related: [external identities](adr-20260908-external-oauth-identities.md).
