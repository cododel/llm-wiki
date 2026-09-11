# Customize instance data, not the database schema

Status: accepted
Date: 2026-09-10
Decision authority: operator-approved fixed-core implementation plan.

## Context and alternatives

The original twelve editorial types imposed one person's organization on every instance.
The operator wants an independently upgradable service rather than template repositories or forks,
while retaining evidence preservation and removing deterministic bookkeeping from agents.
The discussion considered retaining the rigid types, exposing an instance-defined schema, and
using a small product-owned relational core with instance organization represented as data.

## Decision and rationale

Choose the fixed core: generic records plus specialized sources and skills, with optional topics,
formats, ordered collections and garden maturity. A new instance starts empty and a title-only
record is valid. Editorial purpose is not a persistence kind or a workflow permission.
Do not introduce user-defined fields, EAV, arbitrary JSON attributes or agent-executed DDL.
This keeps migrations and protocol guarantees within one product's ownership while allowing
individual organization without a fork. It deliberately gives up arbitrary custom schemas.

## Consequences and revisit conditions

Product upgrades own structural migrations. Organization can change independently without
rewriting history, whereas adding a genuinely new structural capability requires a service
release. Legacy types/tags need explicit compatibility projections, not synthetic native defaults.
Revisit only when concrete use cases cannot be represented by records, evidence, relations and
organization; do not infer that every specialized noun needs another table or dynamic field.

Current contract: [knowledge](../KNOWLEDGE_CONTRACT.md).
Related: [relational storage](adr-20260910-postgresql-revision-store.md).
