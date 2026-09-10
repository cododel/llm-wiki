# Knowledge service contract

Status: normative service v2 contract. Verification evidence is separate from this specification.

## Ownership and representation

The service owns records, immutable revisions, source preservation, structural validation,
taxonomy, catalog, search and audit. Agents own interpretation, synthesis and editorial judgment.
PostgreSQL is the working store; Markdown is body text, not a filesystem schema.
The twelve types and required discovery tags are defined in [SCHEMA](../SCHEMA.md).

Stable record UUIDs are independent of mutable titles and slugs. Slug/title resolution returns
ambiguity instead of selecting arbitrarily. Relations use record IDs; provenance uses immutable
raw revision IDs or explicit HTTP(S) URLs. Reverse `processed_to` is computed from accepted
provenance. Markdown links are editorial content, not an implicit second relationship store.

## Revisions and atomic changes

A revision contains body, metadata, tags, relations, provenance and attachment references.
Accepted revisions and their edge sets are sealed against subsequent mutation. Current and
published pointers are distinct. Search vectors, catalog and audit become visible with the
accepted transaction; there is no asynchronous indexing promise or manually maintained index/log.

A logical change group contains at most 50 typed operations. Validate all types, tags, target
references and expected revisions before committing the transaction. Any invalid operation rolls
back the whole group. New record relations can target IDs created in the same group.
A request key is scoped to its authenticated actor: identical repetition replays the result;
a different payload with the same key conflicts. Concurrent edits with the same expected revision
have exactly one winner. No last-write-wins fallback is permitted.

Archival hides public access and removes the record from current catalogs without deleting history
or existing evidence. A correction creates a new revision, never modifies earlier evidence.
Generated reports use the same content validation and immutable storage.

## Originals and attachments

A raw-source operation preserves submitted original bytes separately from editable metadata and
display text. The server computes SHA-256 and checks the supplied checksum. Text intake is bounded
to 1 MB, with canonical base64 transport; source_kind, source_channel and capture_boundary are
required, with source_url for web sources. New source originals require an explicit source
operation with expected revision. The server cannot prove a client supplied the entire original.

Binary originals are content-addressed in a separate volume. Intake is bounded to 20 MiB,
checks checksum and allowed PNG/JPEG/PDF signatures, and never fetches arbitrary content URLs.
Signature validation is not malware scanning or proof that a document is benign.
Files are staged, synced and finalized before a database reference can be accepted. Duplicate
intake is safe. Referenced blobs cannot be removed by staging cleanup; incomplete staging older
than 24 hours is cleaned. Unaccepted final files older than 24 hours are reconciled under the
same per-hash lock as finalization; accepted blobs are never removed by this cleanup.
Downloads are authorized independently of possession of a hash.

## Taxonomy and semantic limits

Tags must exist in the managed taxonomy and satisfy type discovery requirements. Extending it
requires an explicit authorized tag operation; assigning an unknown tag never creates it.
Counts/show/suggest/validate are deterministic queries; suggest returns context, not model advice.
Public taxonomy output includes only tags present on public revisions, never mutable descriptions.

Structural validity does not prove truth, complete claim extraction, citation relevance, author
intent or semantic equivalence. Link quotas must not fabricate relationships. Draft originals
and edited versions remain distinguishable. Facts, hypotheses, dated evidence and durable
synthesis retain their different meanings.

## Verification anchors

Source byte equality and revision history; sealed edges; checksum and symlink denial; atomic
rollback; idempotency conflicts; concurrent edit races; ambiguous resolution; RU/EN lexical
search and bounded ripgrep syntax; reverse provenance; no index/log maintenance.

Decisions: [revision storage](adr/adr-20260910-postgresql-revision-store.md),
[deterministic boundaries](adr/adr-20260908-deterministic-service-contracts.md).
