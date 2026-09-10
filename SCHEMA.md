# Knowledge content vocabulary

This document owns the retained semantic vocabulary. The [knowledge contract](docs/KNOWLEDGE_CONTRACT.md) owns persistence and changes; [access](docs/ACCESS_CONTRACT.md) owns publication. Wire validation is defined in `src/content/schema.ts` and exposed through MCP v2 tool schemas.

## Twelve record types

| Type | Purpose | Required discovery tag |
| --- | --- | --- |
| raw-source | Exact preserved original, separate from interpretation | source |
| readout | Dated evidence, observations and research | readout |
| entity | A notable person, organization, tool or other thing | Relevant semantic tag |
| concept | Durable synthesis with evidence and uncertainty | Relevant semantic tag |
| comparison | Alternatives, dimensions, evidence and limitations | comparison |
| query | A researched question and bounded answer | summary |
| idea | Hypothesis, motivation, variants and open questions | idea |
| note | Lightweight observations, bookmarks or learning | thought or learning |
| article-draft | Source-backed working article, preserving the original | content |
| post-draft | Working post, preserving the author's voice | content |
| meta | Navigation, workflow or instance-level guidance | meta, wiki, tool, mcp or workflow |
| adr | One decision with context, alternatives and consequences | adr |

There is no generic draft or summary record type. Summary remains a taxonomy tag.
A directory is not an entity. IDs are stable UUIDs; titles and lowercase kebab-case
slugs may change. Ambiguous slugs/titles return candidates, never a guessed match.

## Revisions and sources

Text bodies are Markdown, not frontmatter-bearing files. Metadata, tags,
relationships, provenance and attachment references are structured fields in a
revision. Every revision has nonempty governed tags. Server-generated timestamps,
hashes and reverse provenance are not client-maintained fields.

Raw intake supplies canonical base64 original bytes, a checksum and provenance:
`source_kind`, `source_channel`, and `capture_boundary` (complete, excerpt or
attachment). The server computes and verifies the hash over original bytes, never
metadata. Corrections create another source revision. Text original bytes can
include CRLF, trailing newlines and bytes that are not present in the display body.

Source forms: user-note, chat, transcript, doc, article, asset-note, log.
Channels: telegram, web, file, manual, import. Web sources require `source_url`.
Optional filename, note and import batch describe provenance, not taxonomy.
Binary originals are attached only after size, signature and checksum validation.

Provenance references preserved raw revisions or external HTTP(S) URLs.
Processed-to-processed links use typed relations (related, supports, contradicts,
supersedes), not provenance. `processed_to` is computed from accepted references.
No arbitrary URL is downloaded automatically.

Preserve substantive short original input under “Original input” and an original
draft under “Original draft”, or link a preserved source. Never replace original
material with a generated summary. Strip agent-directed instructions only from
processed quotations, never from a raw original. Voice and optional writing-agent
configuration belong to the owner, not this distribution.

## Metadata and lifecycle

`confidence` is high, medium or low and describes evidential support, not model
confidence. `contested` marks unresolved disagreements; use contradiction relations
and dated evidence. Newer evidence does not automatically overrule stronger evidence.

Lifecycle values include draft, researching, incubating, ready, published, archived,
observed, analyzed, acted-on, proposed, accepted, deprecated and superseded. Lifecycle
labels never grant visibility or replace the explicit archival operation.
Publication is owner confirmation of an exact revision, not a metadata boolean.

## Taxonomy

Initial tags preserve the template's neutral vocabulary:

- Methods: pattern, architecture, methodology, workflow, tool, research, learning, thought.
- Domains: person, company, open-source, engineering, product, security, automation.
- Content: content, article, social-media, writing-style, seo, semantic-core.
- Provenance: wiki, source, provenance, readout, evidence, analysis, factcheck, mcp.
- Classification: idea, comparison, summary, meta, adr.

Use existing reusable semantic facets. Do not encode dates, batches, statuses,
one-off names or relationships as tags. New taxonomy entries require an explicit
authorized `tag` operation in `wiki_apply_change`; ordinary record editing cannot
silently create them. The server stores taxonomy usage from accepted revisions.

## Editorial guidance

Readouts describe dated evidence; concepts synthesize durable knowledge and retain
the evidence link. Hypotheses are not verified facts. Draft editing preserves
original voice unless the owner explicitly requests a change. Comparisons state
their dimensions and limitations. Queries retain the question and uncertainty.
ADR bodies preserve accepted reasoning; supersession links describe a new decision.

Search before creating duplicates and preserve substantive relationships unless
explicitly replacing them. Two useful links are a guideline, never a reason to
invent relationships in a small corpus. Templates under `templates/` are optional
editorial scaffolds and are never automatically ingested.
