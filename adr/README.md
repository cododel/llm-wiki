---
title: Architecture decision records
created: 2026-09-07
updated: 2026-09-07
type: meta
tags: [adr, meta, wiki]
---

# Architecture decision records

One file per decision, named `adr-YYYYMMDD-decision-slug.md`. Use `templates/adr.md`; no external ADR-writing skill is required.

Statuses: proposed, accepted, deprecated, superseded. Record confidence and reversibility separately. Include context, considered alternatives with rejection reasons, decision, invariants, and consequences/mitigations.

Do not rewrite an accepted decision's body to fit a later outcome. Create a successor and update supersession metadata/links. Reference related knowledge with wikilinks and register accepted records in [[index]]. Follow [[SCHEMA]].
