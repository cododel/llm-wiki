# Service architecture and contracts

These documents describe the accepted target for the standalone knowledge service. They are development documentation, not knowledge belonging to a wiki instance, and must not be copied into a newly initialized instance.

## Authority and implementation boundary

The operator accepted these decisions on 2026-09-08. They govern future implementation; they do not claim that the current checkout implements the target.

The current implementation remains a Markdown template with readonly MCP, embedded single-owner OAuth, and an optional Hermes subprocess runner. Root `SCHEMA.md` describes that existing content representation. The service contracts below supersede its file/editor and readonly assumptions for the target service; source-preservation, knowledge-layer, taxonomy, and explicit-public semantics continue as specified below. Existing runtime instructions apply when operating the current code.

- [Architecture decisions](adr/README.md) preserve accepted choices and alternatives.
- [Knowledge contract](KNOWLEDGE_CONTRACT.md) owns content, provenance, changes, and catalog semantics.
- [Access contract](ACCESS_CONTRACT.md) owns identities, permissions, and publication.
- [Factcheck contract](FACTCHECK_CONTRACT.md) owns work detection, execution, results, and escalation.
- [Deployment contract](DEPLOYMENT_CONTRACT.md) owns initialization and persistence boundaries.

## Unresolved implementation choices

No database engine, relational schema, OAuth product/version, authentication grant for unattended agents, exact MCP tool names, wire schemas, retry timings, or notification payload has been selected. Abandoning Obsidian does not by itself select SQLite or PostgreSQL.

A relational primary store was discussed as a simplification; choosing and specifying it remains implementation-design work. Automatic bidirectional filesystem synchronization is not part of the accepted service direction.

ChatGPT scheduled execution of external MCP tools has not been verified. The service must support authorized MCP polling regardless of the scheduler; documentation must not promise client capabilities without verification.

The old Hermes instructions are research input, not normative authority. Conflicts are resolved by these accepted boundaries and the current content semantics they retain.

## Verification boundary

Implementation acceptance must demonstrate the observable guarantees in each contract, including concurrent changes, authorization denial, interrupted operations, duplicate delivery, and restart recovery. Documentation acceptance proves only coherent records and working references; it is not runtime acceptance.

