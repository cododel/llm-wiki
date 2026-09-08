# Package Compose with separate initialized instance storage

Status: accepted
Date: 2026-09-08
Decision authority: explicit operator agreement in the repository design conversation.

## Context

The standalone service needs deployable runtime packaging while its data organization is expected to evolve.

## Alternatives and rationale

Keep deployment examples only, or include Compose and a dedicated initialized instance volume. The operator selected the complete Compose service with minimal reuse of the existing template, deferring a broad storage redesign.

## Decision

Separate packaged code/template from instance storage and seed a new empty volume once. Preserve existing instance data across restarts and image updates.

## Consequences and invariants

Deployment must handle first-run recovery and persistent operational state. Developer documents and demonstrations must not become instance knowledge. The choice does not select a database engine.

## Reversibility and revisit conditions

Revisit initialization/migration details when the persistent data model is chosen; never treat image replacement as consent to overwrite an instance.

Current contract: [DEPLOYMENT_CONTRACT.md](../DEPLOYMENT_CONTRACT.md).
Related decisions: [decision index](README.md).

