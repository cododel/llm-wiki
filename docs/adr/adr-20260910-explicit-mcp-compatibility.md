# Version native MCP semantics without hiding legacy incompatibility

Status: accepted
Date: 2026-09-10
Decision authority: operator-approved fixed-core implementation plan.

## Context and alternatives

The generic model cannot be represented faithfully by v2's mandatory editorial type and tags.
Silently inventing legacy defaults or omitting new objects would break the agent's view of the
knowledge base. Replacing the existing endpoint outright would also break retained clients,
historical snapshots and assignments.

## Decision and rationale

Keep the same MCP endpoint and OAuth audience. Existing tools default to v2; an explicit
contract_version selects v3, and new discovery/organization tools use v3. Preserve historical
v2 payloads and task snapshots. Return an explicit unsupported-contract error when a legacy
response cannot represent native data instead of approximating or silently filtering it.
Upgrade with additive migrations and resumable historical projections during a maintenance
window, preserving source bytes, revisions, publication pointers and checkpoint identity.

## Consequences and revisit conditions

The service maintains two explicit contracts and clients must handle incompatibility by
discovering v3. Shared authorization does not mean every old tool can express every new kind.
Rollback requires the matching pre-upgrade backup, not a destructive reverse migration.
Revisit v2 support only through an explicit deprecation decision with evidence about remaining
clients and historical access; never infer obsolescence merely from successful v3 tests.

Current contracts: [MCP](../MCP.md), [operations](../OPERATIONS.md).
