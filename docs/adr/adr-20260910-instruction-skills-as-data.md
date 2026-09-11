# Keep reusable agent instructions as revisioned data

Status: accepted
Date: 2026-09-10
Decision authority: operator-approved fixed-core implementation plan.

## Context and alternatives

Agent-facing workflows need reusable guidance without depending on a particular local agent
runtime or loading every instruction into every conversation. The accepted scope distinguishes
instruction context from executable extensions and authentication configuration. Runtime-specific
skills retain coupling; server-executed plugins would widen trust and operational boundaries.

## Decision and rationale

Store skills as specialized revisioned knowledge: purpose, applicability, instructions,
requirements and exact dependency revisions. Discover small descriptions before fetching full
context. Record applicable skills by stable ID and actual usage by revision. These are data,
never server-executed code or a source of permissions. A personal agent can edit an unlocked
skill; changing locks requires a separate explicitly assigned local capability.

## Consequences and revisit conditions

Instruction updates remain auditable and prior executions can retain their actual basis.
Executors still have to interpret requirements, fetch dependencies and honor their own instruction
hierarchy. The service does not certify that a skill is safe or that an agent actually followed it.
Adding execution or extension hooks would be a new architectural/security decision, not an
implementation detail of this data model.

Current contracts: [knowledge](../KNOWLEDGE_CONTRACT.md), [access](../ACCESS_CONTRACT.md).
