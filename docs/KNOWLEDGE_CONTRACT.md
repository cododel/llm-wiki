# Knowledge service contract

Status: accepted target; not a statement of current runtime capability.

## Ownership

The service owns durable knowledge, provenance, revisions, structural validation, and a queryable catalog. Agents own interpretation, synthesis, semantic classification, and editorial judgment. Readers and adapters consume the service contract.

Obsidian is not a supported product dependency. Direct editing of a filesystem vault is not the primary service interface. A catalog/index must be retrievable deterministically through a tool without requiring an agent to reconstruct it. Storage layout and export representation are implementation choices.

The twelve existing content types and their distinctions remain the initial semantic vocabulary from [SCHEMA](../SCHEMA.md): raw-source, readout, entity, concept, comparison, query, idea, note, article-draft, post-draft, meta, and adr. Folder layout is not a future persistence requirement.

## Sources and relationships

- Preserve the exact accepted source payload before recording its interpretation. Compute source hashes on the server; mutable metadata is outside the immutable payload.
- Ordinary updates must not overwrite source bodies. An authorized correction creates a distinct source revision and preserves the prior evidence. Recomputing a hash after silent modification is not preservation.
- Preserve the explicitly selected source boundary: a user note, complete exchange, excerpt, or attachment must not silently become a different capture. The server verifies submitted bytes and declared boundaries; it cannot prove that a client supplied the complete original.
- Attachment intake validates size, actual format, and checksum and records its provenance. Transcription and interpretation remain distinguishable from original bytes.
- Provenance references target preserved sources or external evidence; relationships between processed knowledge are separate edges. The service maintains reverse processing relationships, represented today as `processed_to`.
- Tags come from the active taxonomy. Expanding the taxonomy is an explicit change, not an automatic side effect of assigning an unknown tag.
- References resolve consistently across reads, writes, catalog, and diagnostics. Missing and ambiguous references must not silently select a target. Retained Markdown imports use explicit README targets and preserve non-Markdown extensions.

## Changes

- Authorized content operations support creation, editing, raw intake, archival, and explicit publication, subject to the [access contract](ACCESS_CONTRACT.md).
- A logical multi-entity change validates the exact candidate and expected revisions before application. Concurrent changes must cause an explicit conflict rather than silent lost updates.
- A completed operation includes its required provenance, navigation changes, and audit event. Partial writes must not be reported as complete; interrupted operations must be recoverable.
- Maintain derived catalog/search data from accepted content. A response distinguishes durable content acceptance from any outstanding index refresh; do not claim searchability before it is established.
- Archival preserves evidence and accounts for affected references. Zero incoming links is a diagnostic, not authority to delete. Bulk-import staging is separate from archival; retained evidence cannot be discarded merely to clear warnings.
- Structural checks distinguish content, raw sources, generated evidence, attachments, and operational state. Generated readouts remain subject to content/provenance/reference validation even when exempt from curated-index and minimum-link guidance.
- Historical evidence and unrelated changes must not be mechanically rewritten as part of a scoped operation.

## Semantic boundary

The service can validate types, references, versions, payload integrity, and operation scope. It does not prove truth, citation relevance, complete claim extraction, author's intent, or semantic equivalence of a replacement link. Link quotas must not force fabricated relationships. OAuth permission is not proof that a human approved a particular text; client-supplied approval assertions alone do not establish that fact.

## Acceptance anchors

Verify source byte preservation and revision history; attachment integrity; forward/reverse provenance agreement; ambiguous-reference rejection; concurrent-update conflicts; recoverable multi-entity changes; deterministic catalog retrieval; and diagnostics that distinguish scoped regressions from pre-existing debt.

Decision provenance: [standalone service](adr/adr-20260908-standalone-knowledge-service.md), [deterministic contracts](adr/adr-20260908-deterministic-service-contracts.md).

