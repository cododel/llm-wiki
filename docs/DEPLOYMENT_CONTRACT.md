# Deployment and initialization contract

Status: normative service v2 contract.

The distribution contains Caddy, Authelia, PostgreSQL, API and worker. One pinned Bun image
runs either application mode. Only Caddy publishes host ports. PostgreSQL contains separate
wiki/Authelia databases and credentials; API/worker cannot read the Authelia database.

## Separation and lifecycle

Code, dependencies and editorial templates belong to the immutable image. Knowledge revisions,
jobs, results, outbox and audit belong to PostgreSQL. Binary originals belong to a separate
persistent volume. Credentials and local grants live in an operator-owned external directory,
not in knowledge, source control, logs or task envelopes.

Configuration generation refuses an existing target directory. Database initialization and
versioned migrations are transactional and locked; neutral taxonomy is seeded once. No personal
corpus, demonstration content, source Git history or service development documents are imported.
Interrupted database initialization rolls back and is retryable. A failed configuration
generation may leave an incomplete protected directory; the operator inspects it before choosing
a fresh directory. No automatic overwrite of partial operator configuration occurs.

Image replacement/restart preserves content and work state. Migration checksums reject changed
historical migrations. Dependencies are exact-pinned with a frozen lockfile in the image;
no code or node_modules belongs in data volumes. Search vectors are transactional PostgreSQL
derived data, not a second file vault or SQLite index.

## Recovery and acceptance

Backup includes both databases, original blob volume and protected configuration/keys.
Stop writers for a coordinated backup. Restore into a separate disposable instance and verify
before replacing live storage. Do not run down --volumes on operator instances.
[Operations](OPERATIONS.md) owns the concrete procedure, rotation and upgrade guidance.

Unified verification must use only generated disposable configuration, temporary dependency
installation, isolated database names/Compose project and loopback endpoints. Cleanup removes
only resources it created, even on failure. Operator data/credentials must not be consulted.
Real OAuth reconnect and ChatGPT scheduling are separate operator acceptance, not inferred from
local protocol tests.

Decision: [Compose storage](adr/adr-20260908-compose-instance-storage.md),
[PostgreSQL](adr/adr-20260910-postgresql-revision-store.md).
