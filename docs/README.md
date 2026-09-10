# Service architecture and contracts

These documents describe the accepted target for the standalone knowledge service. They are development documentation, not knowledge belonging to a wiki instance, and must not be copied into a newly initialized instance.

## Authority and implementation boundary

The operator accepted the service direction on 2026-09-08 and the implementation boundaries in the subsequent plan. Living contracts govern the service implementation; they are not evidence that every deployment or client integration has passed acceptance. Root `SCHEMA.md` defines semantic types, not a filesystem layout. Historical ADR reasoning remains unchanged; successor decisions record PostgreSQL, owner-approved revisions and the tested external auth version.

- [Architecture decisions](adr/README.md) preserve accepted choices and alternatives.
- [Knowledge contract](KNOWLEDGE_CONTRACT.md) owns content, provenance, changes, and catalog semantics.
- [Access contract](ACCESS_CONTRACT.md) owns identities, permissions, and publication.
- [Factcheck contract](FACTCHECK_CONTRACT.md) owns work detection, execution, results, and escalation.
- [Deployment contract](DEPLOYMENT_CONTRACT.md) owns initialization and persistence boundaries.

## Selected implementation boundary

The approved implementation uses Bun, PostgreSQL through Bun.SQL, external Authelia,
stable-ID MCP v2, owner-confirmed revision publication, and separate incremental
factchecking and review processes. The original eleven read names remain; file-path
arguments are replaced, not silently emulated. API and worker share a PostgreSQL
queue and outbox without another broker.

Modules live in `src/content`, `src/factcheck`, `src/auth`, `src/storage`, `src/search`,
`src/mcp`, `src/delivery`, and `src/runtime`. Automatic bidirectional filesystem
synchronization is not part of the accepted service direction.

ChatGPT scheduled execution of external MCP tools has not been verified. The service must support authorized MCP polling regardless of the scheduler; documentation must not promise client capabilities without verification.

The old Hermes instructions are research input, not normative authority. Conflicts are resolved by these accepted boundaries and the current content semantics they retain.

## Verification boundary

Implementation acceptance must demonstrate the observable guarantees in each contract, including concurrent changes, authorization denial, interrupted operations, duplicate delivery, and restart recovery. Documentation acceptance proves only coherent records and working references; it is not runtime acceptance.

See [local acceptance evidence](VERIFICATION.md) for the verified scenarios and explicit limits.
