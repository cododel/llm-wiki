# Adopt a standalone knowledge service

Status: accepted
Date: 2026-09-08
Decision authority: explicit operator agreement in the repository design conversation.

## Context

The project began as a Markdown/Obsidian-compatible wiki template. The operator now wants an independent service for notes and other knowledge entities, accessed by agents and deterministic tools.

## Alternatives and rationale

Retain direct Obsidian/filesystem editing as the primary interface; or make the service authoritative and let readers/adapters consume its contracts. The operator selected the latter because well-defined contracts permit future readers and adapters, and catalog retrieval need not require agent reasoning.

## Decision

Remove Obsidian as a product dependency and make the service interface the primary boundary for knowledge operations and catalog retrieval. Do not commit to an editor-specific storage representation.

## Consequences and invariants

Direct vault editing is no longer a required workflow. Readers and exports may need adapters. A relational primary store was discussed but no engine or schema was chosen.

## Reversibility and revisit conditions

Revisit if direct filesystem editing becomes a required product workflow; evaluate explicit import/export rather than silently introducing two authorities.

Current contract: [KNOWLEDGE_CONTRACT.md](../KNOWLEDGE_CONTRACT.md).
Related decisions: [decision index](README.md).

