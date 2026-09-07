---
title: Wiki workflows
created: 2026-09-07
updated: 2026-09-07
type: meta
tags: [wiki, workflow]
---

# Wiki workflows

Follow [[AGENTS]] and [[SCHEMA]]. No workflow grants write permission by itself.

## Ingest

Confirm scope → preserve raw → inspect existing knowledge → create/update interpretation → discover meaningful links → update provenance/index/log → validate → review diff → commit/push only when authorized.

Short material can be preserved inline; longer material goes through [[raw/_README]]. Select a page template from `templates/` and replace all placeholders before saving it into a content layer.

## Retrieve

Read the catalog where useful → search with MCP or CLI → inspect sources/readouts and relevant pages → answer with citations. Saving the answer is a separate write operation, not the default result of a query.

## Tags

Inspect counts → inspect pages using a candidate tag → request per-file suggestions → choose existing semantic tags or explicitly expand the schema → validate. Commands: `bun run tools/wiki_tags.ts counts`, `show --tag source`, `suggest --file <path>`, and `validate --strict`.

## Draft

Preserve original phrasing → separate goal and editorial decisions → edit only within the requested scope → keep original and edited versions separate. See [[drafts/README]].

## Experiment

Observe → create a dated [[readouts/README|readout]] → analyze → verify → extract durable conclusions into concepts if warranted. State what was actually tested and what remains uncertain.

## Maintain

Run health/lint/tag checks → review reported defects → apply authorized repairs → recheck → append [[log]] → review the diff. Never mask source drift by automatically replacing checksums.

## Import

Stage under `raw/<import-name>/` → classify keepers/noise/sensitive content → preserve referenced sources and provenance → create/update processed knowledge → remove rejected staging material within scope → document the import. Never publish credentials or erase referenced evidence as cleanup.

## Publish

Review the entire page and its metadata/references → set `visibility: public` explicitly → audit public exposure → verify access with the public MCP scope. `status: published` alone does not publish through MCP.

## Optional factcheck

Configure the separate Hermes profile/skill, review its network/model access, and explicitly run the optional orchestrator. No schedule or autocommit is installed by this template. See `tools/factcheck/README.md`.
