# Service architecture decisions

Repository-level decisions live here, separately from instance knowledge records. Use the existing `adr-YYYYMMDD-decision-slug.md` naming convention. Accepted reasoning is immutable; changed choices require a successor with supersession links.

Records carry their individual decision dates; acceptance does not mean implementation is complete.

- [Standalone knowledge service](adr-20260908-standalone-knowledge-service.md)
- [External OAuth and separate agent identities](adr-20260908-external-oauth-identities.md)
- [Network factchecking through webhook and MCP](adr-20260908-network-factchecking.md)
- [Content-hash change detection](adr-20260908-content-hash-detection.md)
- [Deterministic service contracts](adr-20260908-deterministic-service-contracts.md)
- [Compose with separate instance storage](adr-20260908-compose-instance-storage.md)
- [PostgreSQL revision store](adr-20260910-postgresql-revision-store.md)
- [Owner-confirmed revision publication](adr-20260910-owner-revision-publication.md)
- [Resource-bound Authelia authentication](adr-20260910-resource-bound-authelia.md)
- [Fixed knowledge core](adr-20260910-fixed-knowledge-core.md)
- [Instruction skills as data](adr-20260910-instruction-skills-as-data.md)
- [Explicit MCP compatibility](adr-20260910-explicit-mcp-compatibility.md)

See the [contract index](../README.md).
