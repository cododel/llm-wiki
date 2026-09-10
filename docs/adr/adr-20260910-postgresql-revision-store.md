# Store knowledge in PostgreSQL revisions

Status: accepted
Date: 2026-09-10
Decision authority: operator-approved standalone service implementation plan.

## Context and alternatives

The previous Markdown vault required agents to coordinate links, source metadata,
index, log and Git updates across files. Continuing with that representation would
retain those cross-file consistency responsibilities. The operator abandoned
Obsidian and selected a relational primary store as a simplification for enforceable
content contracts, atomic changes and independently published revisions.

## Decision

Use PostgreSQL through Bun.SQL, versioned SQL migrations and immutable revisions.
Markdown remains the text format. Store binary originals by content hash in a
separate persistent volume; keep their references and integrity metadata in the DB.
Do not retain a supported filesystem-write runtime or add automatic corpus import.

## Consequences and revisit conditions

The database provides transactional change acceptance and revision references;
agents no longer manually maintain the catalog or audit. Operation now requires
database backup/restore plus the blob volume, and database migrations have to be
tested before upgrades. Revisit the physical layout when the planned data-organization
review supplies concrete new requirements, not to restore editor compatibility.

Current contract: [knowledge](../KNOWLEDGE_CONTRACT.md).
Related: [standalone service](adr-20260908-standalone-knowledge-service.md),
[instance storage](adr-20260908-compose-instance-storage.md).
