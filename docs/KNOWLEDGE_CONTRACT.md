# Knowledge service contract

Status: normative service v3 contract, with explicit v2 compatibility. Verification evidence is separate.

## Ownership and representation

The service owns records, immutable revisions, source preservation, structural validation,
taxonomy, catalog, search and audit. Agents own interpretation, synthesis and editorial judgment.
PostgreSQL is the working store; Markdown is body text, not a filesystem schema.
Fixed kinds, optional organization and editorial guidance are defined in [SCHEMA](../SCHEMA.md).
Generic records, sources and skills share IDs/revisions; sources and skills have specialized tables.
Topics/formats and ordered collections customize instance data, not the product-owned schema.
No dynamic fields, EAV, per-instance DDL or executable plugins are supported. New instances are empty.

Stable record UUIDs are independent of mutable titles and slugs. Slug/title resolution returns
ambiguity instead of selecting arbitrarily. Relations use record IDs; provenance uses immutable
raw revision IDs or explicit HTTP(S) URLs. Reverse `processed_to` is computed from accepted
provenance. Markdown links are editorial content, not an implicit second relationship store.

## Revisions and atomic changes

A native revision contains body, fixed attributes, pinned topic/format labels, relations,
provenance, derivations, applicable skills and attachments. Skill revisions additionally hold
description, use/avoid guidance, requirements and pinned required/optional dependencies.
Accepted revisions and their edge sets are sealed against subsequent mutation. Current and
published pointers are distinct. Search vectors, catalog and audit become visible with the
accepted transaction; there is no asynchronous indexing promise or manually maintained index/log.

A logical change group contains at most 50 typed operations. Validate all kinds, classifications, target
references and expected revisions before committing the transaction. Any invalid operation rolls
back the whole group. New record relations can target IDs created in the same group.
A request key is scoped to its authenticated actor: identical repetition replays the result;
a different payload with the same key conflicts. Concurrent edits with the same expected revision
have exactly one winner. No last-write-wins fallback is permitted.

Archival hides public access and removes the record from current catalogs without deleting history
or existing evidence. A correction creates a new revision, never modifies earlier evidence.
Generated reports use the same content validation and immutable storage.

Omitted fields in a native edit preserve their prior values; explicit empty lists clear edges.
Creation requires only a title. Specialized source/skill operations replace their complete
document and require expected revision for updates. Source intake can supply a new revision UUID
so a source and its interpretation can be accepted in one atomic group; sources are handled first.
Stable-ID skill applicability differs from revision-pinned actual use. Dependencies can be
retrieved by revision alone and are never silently redirected to newer content.

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

## Organization, compatibility and semantic limits

Topic/format assignments require existing IDs in the correct vocabulary. One format and up to
30 topics can be assigned; neither is mandatory. Renames and aliases are version-checked registry
changes, not edits to old revision labels. Public names/aliases come only from published revision
snapshots. Collections are ordered private navigation; their version-checked changes are audited
without revising members or altering content fingerprints. Active reads omit archived members.

V2 retains its original typed metadata/tag validation for legacy writes and reads. Legacy type
and tag columns are compatibility storage, not native required classifications. Native revisions
cannot be replaced through v2. Full old representations remain reachable by their immutable
legacy revision pointer. Upgrades add fixed projections without changing old hashes or snapshots.
An edit with unchanged evidence content retains its previous fingerprint across the v2/v3 boundary.

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
