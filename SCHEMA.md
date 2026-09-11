# Fixed knowledge vocabulary

This document owns semantic vocabulary. The [knowledge contract](docs/KNOWLEDGE_CONTRACT.md)
owns persistence and changes; [access](docs/ACCESS_CONTRACT.md) owns permissions and publication.
The database schema belongs to the product, not to an instance or agent.

## Three kinds, optional editorial organization

| Kind | Purpose |
| --- | --- |
| record | A generic knowledge object: a note, person, idea, decision, draft or synthesis |
| source | Preserved original bytes and provenance, distinct from interpretation |
| skill | Revisioned instructions and application context, never executable code |

A record requires only a title. Body, topics, format, relations and sources may be empty.
Stable UUIDs survive renames; slug/title resolution reports ambiguity. Markdown is text, not
frontmatter, a path, or an implicit relationship database. There are no instance-defined fields,
types, arbitrary JSON attributes, schema registries, EAV storage or DDL tools.

Topics describe reusable subject matter. A format optionally describes editorial purpose,
such as note, research report, concept or decision. Both have stable IDs, names and aliases;
labels are not keys. Collections provide ordered private navigation across kinds. An instance
can use only generic records forever, or its agent can offer optional onboarding and explicitly
create organization requested by the owner. Nothing is seeded into the knowledge catalog.

## Independent dimensions

Maturity is `seed`, `growing` or `evergreen`. New generic records start as seed; legacy records
retain unknown maturity (`null`). Sources and skills have no garden maturity. Maturity is not
truth, confidence, publication, a lock or a successful factcheck.

Check policy is `automatic` or `manual`. Ordinary records default to automatic; sources and
skills are manual. Sources are evidence; skills can be reviewed explicitly. Generated evidence
reports never trigger recursive checks. Publication requires a separate owner decision, and
edit locks require a separate local capability to manage.

## Evidence, navigation and instructions

- Navigation relations target stable object IDs: `related`, `supports`, `contradicts`,
  `supersedes`, `about`, `part_of`.
- Provenance targets exact source revision IDs or explicit HTTP(S) URLs. Reverse
  `processed_to` is computed, not manually maintained.
- `derived_from` pins a processed revision used in an interpretation. `used_skill` pins the
  actual instruction revision applied. These do not move when the target changes.
- Applicable skills use stable skill IDs. A skill's dependencies pin exact revisions, marked
  required or optional; requirements describe necessary context. Fetch pinned dependencies
  before following a skill. Instruction text cannot elevate permissions or authorize effects.

Source intake preserves canonical base64 original bytes separately from display Markdown.
Server SHA-256 covers only those original bytes. Provenance requires `source_kind`,
`source_channel` and `capture_boundary` (`complete`, `excerpt`, `attachment`); web origins require
`source_url`. Source forms are user-note, chat, transcript, doc, article, asset-note and log;
channels are telegram, web, file, manual and import. These describe capture, not editorial types.
Corrections create another source revision. No arbitrary URL is downloaded automatically.

Preserve original input before interpretation. Do not substitute summaries for originals,
invent relationships to meet a quota, or confuse hypotheses with verified conclusions.
Readouts retain dates and evidence; durable syntheses retain links to their basis. Draft editing
preserves the author's intent and voice unless the owner requests otherwise. These are useful
workflow principles, not mandatory folders or type names.

## V2 compatibility

The original twelve types, typed metadata and tag requirements remain the **v2** wire contract
for legacy revisions. Existing types become optional format classifications; existing tags
become topics with stable IDs. No historical revision or accepted source is rewritten. The
native response's `legacy_revision` points to the complete legacy representation; read that
exact revision through v2 when its old metadata is needed. Private compatibility pointers are
not disclosed by newly published native revisions.

The twelve Markdown files under `templates/` remain optional editorial scaffolds, never a
required catalog, initialization corpus or source of schema migrations. See [MCP](docs/MCP.md)
for version selection and explicit incompatibility errors.
