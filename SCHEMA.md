# Wiki Schema

## Domain

Set this section to the owner's knowledge domain. The template has no assumed personal profile, projects, editorial voice, or vendor-specific agent setup. Retain knowledge useful beyond a single transient task.

## Conventions

- Content filenames are lowercase kebab-case slugs using `a-z`, `0-9`, and hyphens. Human-readable names belong in `title`. Structural files (`README.md`, `AGENTS.md`, `SCHEMA.md`, `raw/_README.md`) are explicit exceptions.
- Dated evidence and date-specific drafts use `YYYY-MM-DD-slug.md`. ADRs use `adr-YYYYMMDD-decision-slug.md`.
- Every content page starts with YAML frontmatter and non-empty governed tags. Root contracts/catalog/log and tooling documentation are not content pages.
- Link targets are extensionless note paths or unique filename stems. Directories do not implicitly resolve to README notes. Use `[[ideas/example/README]]` and `[[./detail]]` as appropriate.
- Preserve existing wikilinks unless explicitly replacing, renaming, or archiving the target. Aim for two substantive outbound links on ordinary knowledge pages; do not invent links in an empty vault.
- Bump `updated` on material page changes. Add curated knowledge pages to `index.md` and append authorized changes to `log.md`.
- On syntheses of three or more sources, use paragraph-level provenance markers such as `^[raw/articles/source-file.md]` where a specific claim depends on one source. Single-source pages can rely on frontmatter provenance.
- `templates/`, `examples/`, `docs/`, `tools/`, and `.github/` are packaging/tooling, not knowledge. They are excluded from content indexing, publication, and content lint. A demo vault under `examples/` can be checked separately by setting `WIKI_DIR` to that directory.

## Frontmatter

```yaml
---
title: Page title
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: concept
tags: [pattern]
sources: []
raw_sources: []
confidence: medium
# Optional, when unresolved contradictions exist:
# contested: true
# contradictions: [concepts/other-page]
# Source preservation on processed user material:
# source_preservation: full | excerpt | none
# Lifecycle for ideas, notes, and drafts:
# status: draft | researching | incubating | ready | published | archived
# Only explicit publication grants public MCP access:
visibility: private
---
```

Types: `raw-source`, `readout`, `entity`, `concept`, `comparison`, `query`, `summary`, `idea`, `note`, `draft`, `article-draft`, `post-draft`, `meta`, `adr`.

`sources` contains only raw-source paths or external URLs. Processed wiki pages belong in body wikilinks, not in `sources`. `raw_sources` records raw/non-wiki provenance; use portable repository-relative references/descriptions, never `/root/...`, `~/...`, drive-letter paths, or other machine-local references. Absolute filesystem destinations are also invalid in processed Markdown links; use plain code/prose for a local checkout reference or preserve its evidence under `raw/`.

`confidence` is `high`, `medium`, or `low`. It expresses support for claims, not model confidence. Set `contested: true` and `contradictions` when conclusions genuinely conflict. Retain dated evidence for both positions; newer does not automatically mean more reliable.

### Lifecycle

Ideas, notes, and drafts: `draft`, `researching`, `incubating`, `ready`, `published`, `archived`.
Readouts may use `observed`, `analyzed`, `acted-on`, `superseded`.
ADRs use `proposed`, `accepted`, `deprecated`, `superseded`.
Statuses describe lifecycle, never MCP authorization.

## Public visibility

The public MCP scope denies pages unless their frontmatter explicitly and unambiguously contains `visibility: public`. Folder membership and `status: published` never publish a page automatically. `visibility: private`, missing values, malformed metadata, and uncertainty remain private.

The admin scope serves permitted Markdown pages regardless of publication metadata, but remains read-only. The operational blocklist applies to both scopes: Git/editor/agent state, archives, dependencies, tooling, templates, examples, deployment docs, runtime files, and non-Markdown files are not served. Authorization resolves real paths and rejects traversal and symlink escapes.

Use `bun run tools/mcp-wiki-server/audit-visibility.ts --list` to inspect the public surface. Redaction is only defense in depth. Review references and metadata as well as prose before publishing. Remote admin HTTP requires the documented OAuth setup; local stdio trusts the invoking local process.

## Raw sources

`raw/_README.md` is metadata documentation, not a raw source. All other raw-source Markdown uses:

```yaml
---
title: Source title
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: raw-source
source_kind: user-note
source_channel: manual
ingested: YYYY-MM-DD
sha256: BODY_SHA256
tags: [source]
processed_to: []
# source_url: https://example.com/article
# source_filename: original-file.txt
# source_note: Human-readable origin note
# import_batch: import-name
---
Original source body.
```

`source_kind`: `user-note` (owner's original note), `chat`, `transcript`, `doc`, `article`, `asset-note`, or `log`.
`source_channel`: `telegram`, `web`, `file`, `manual`, or `import`.
These describe form and origin, not semantic topics; do not duplicate them as tags unless the page is actually about that channel/domain.

`source_url` is required for `web`; optional for `telegram`, `file`, and `import` when a durable URI exists; normally absent for `manual`. Use `source_filename`, `source_note`, and `import_batch` when appropriate. Do not add an ambiguous free-form `source` field.

`processed_to` is mandatory: an explicit list of extensionless, vault-relative processed targets outside `raw/`, without `[[brackets]]`. Use exact README note paths for directory entry pages. Empty means preserved but not processed.

`sha256` covers the exact UTF-8 body after the closing frontmatter delimiter, including its trailing newline if present. It does not cover mutable metadata. Preserve original body bytes. Re-ingest can detect unchanged payloads and drift; do not silently rewrite raw bodies or replace mismatching hashes. Corrections are new source revisions with an explicit log entry.

## Source preservation and instruction stripping

Writing requires the authorization described in `AGENTS.md`. Once authorized, preserve original input before synthesis.

Short material can remain inline in a processed page under `## Original input` / `## Исходник`, or `## Original draft` / `## Исходный набросок` for drafts. Long/context-heavy material belongs under `raw/`, with source metadata. Binary assets belong under `raw/assets/<topic>/`, with useful transcription in an `asset-note` wrapper.

Remove agent-directed phrases from processed quotations, not from preserved raw sources. Keep original and edited draft versions separate. Preserve the author's phrasing; do not polish or add facts unless the requested editing scope allows it.

## Tag Taxonomy

### Knowledge and Methods
- pattern, architecture, methodology, workflow, tool, research, learning, thought

### Entities and Domains
- person, company, open-source, engineering, product, security, automation

### Content
- content, article, social-media, writing-style, seo, semantic-core

### Operations and Provenance
- wiki, source, provenance, readout, evidence, analysis, factcheck, mcp

### Classification
- idea, comparison, summary, meta, adr

## Tag governance

Every tag must appear in the taxonomy. Inspect counts and existing usage before adding one. New tags must represent reusable semantic clusters and be added to this schema before use, with the rationale logged. Expand the domain taxonomy deliberately, not by blindly inheriting a previous owner's interests.

Do not create tags for dates, years, batch IDs, commit SHAs, statuses, workflow states, raw forms/channels, one-off names, or relationships already expressed by frontmatter and wikilinks. Avoid vague labels such as `misc`, `important`, or `random`.

Required discovery tags:

| Type | Tag |
|---|---|
| `raw-source` | `source` |
| `readout` | `readout` |
| `idea` | `idea` |
| `note` | `thought` or `learning` |
| `post-draft`, `article-draft` | `content` |
| `comparison` | `comparison` |
| `query` | `summary` |
| `adr` | `adr` |
| `meta` | `meta` or an appropriate wiki/tooling tag |
| `concept` | A relevant semantic tag such as `pattern`, `workflow`, or `architecture` |

`type` defines the layer, `status` its lifecycle, source fields its provenance, wikilinks its specific relationships, and tags its reusable semantic facets.

## Page thresholds and navigation

Create a page when a concept/entity appears in two or more sources or is central to a single source. Update an existing page when the topic is already covered. Do not create pages for passing mentions or minor details outside the domain.

Consider splitting near 200 lines, not at an arbitrary hard boundary. For three or more distinct facets, use a directory with README overview and focused subpages. The index must point explicitly to the README note. Include substantial independent subpages when useful.

```text
ideas/example/
  README.md      overview, short summary, navigation
  product.md     problem, scope, behavior
  tech.md        implementation and constraints
  market.md      evidence about demand
  business.md    economics and assumptions
  risks.md       hypotheses and unknowns
  next-steps.md  bounded next actions
```

Archive fully superseded pages under `_archive/`, update incoming references, and remove them from the active index. Do not use archives for bulk-import staging. Stage imports under `raw/<import-name>/`; keep referenced evidence, clean up rejected material within authorization, and document the outcome.

Raw sources, root metadata, structural README pages, and generated factcheck evidence are exempt from ordinary index/minimum-link requirements. Curated readouts may be indexed when useful; generated batch/summary readouts should not be manually indexed. Generated evidence is still checked for parseable frontmatter, provenance, and resolvable wikilinks.

## Page formats

### Ideas

Start with a short, non-invented statement of the idea. Preserve the original input. Include the problem, potential variants, links, next steps/open questions, and lifecycle status. Multi-file idea READMEs need a navigation table explaining when to read each subpage.

### Notes

Record the source or bookmark, why it matters, observed takeaways, related knowledge, and an optional priority or action date. Keep deferred research distinct from verified conclusions.

### Drafts

Use `drafts/` for material being developed for publication, not canonical concepts. `drafts/posts/` preserves original voice with no mandatory external writing skill. Optional voice/skill choices belong to the owning instance, not this template.

`drafts/articles/` supports source-backed article planning. Keep the proposed semantic core explicitly hypothetical until verified. A true semantic core requires evidence; do not promote guessed keywords silently.

```yaml
category: article
seo:
  target_intent: informational
  potential_semantic_core: []
  true_semantic_core: []
  source_status: none
```

Article sections: short version; reader/intent/angle; potential semantic core; sources to verify; verified semantic core; outline; draft; open questions. Post sections: original draft; goal/type; angle/tone; current version; edits/decisions. Keep original and edited versions separate.

### Entities and concepts

Entities describe what a notable thing is, relevant facts/dates, relationships, and sources. Concepts define a durable idea, current understanding, debates, and related concepts. Avoid untracked ephemeral counters and prices unless they matter to the question being investigated.

### Comparisons and queries

Comparisons state alternatives, evaluation dimensions, evidence, limitations, and the resulting synthesis. Queries preserve valuable researched answers with the question, evidence, bounded conclusion, and remaining uncertainty. A useful answer is saved only with write authorization.

### Readouts

Dated evidence: context, observations, analysis, related knowledge, decision/next action, and verification. Do not present an experiment as timeless knowledge. Extract durable results into concepts and retain the evidence link. Generated factcheck readouts use extensionless wikilinks even in headings and tables; bare processed-page paths and processed pages in `sources` are invalid.

### ADRs

One record per decision. Include context, options with rejection reasons, decision, invariants, consequences/mitigations, confidence, and reversibility. Preserve accepted decision bodies; describe a changed decision in a successor and update supersession metadata/links. See `adr/README.md` and `templates/adr.md`.

## Contradictions and updates

Compare dates and evidence quality. Note genuinely incompatible positions with dated sources; do not treat every refinement as a contradiction. Set `contested` and `contradictions` when unresolved, and flag the issue for review. Preserve old evidence, provenance, and useful links while updating the interpretation.
