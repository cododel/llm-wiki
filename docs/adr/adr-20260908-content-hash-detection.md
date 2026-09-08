# Detect factcheck changes by content hash

Status: accepted
Date: 2026-09-08
Decision authority: explicit operator agreement in the repository design conversation.

## Context

Factchecking must work against mutable service-owned knowledge without depending on whether an agent created a Git commit.

## Alternatives and rationale

Retain Git SHA checkpoints or compare content hashes to checked versions. The operator chose hashes to cover current content independently of commits and retain changes made while research is running.

## Decision

Select factcheck work by content versions and pin the checked snapshot. Later edits remain eligible independently of the in-flight result.

## Consequences and invariants

The service must retain checked-version state and bounded task snapshots. Git history can no longer be used as the sole record of successful verification.

## Reversibility and revisit conditions

Revisit snapshot retention and hashing representation when storage is selected; do not equate latest content with an older checked version.

Current contract: [FACTCHECK_CONTRACT.md](../FACTCHECK_CONTRACT.md).
Related decisions: [decision index](README.md).

