---
title: Raw sources
created: 2026-09-07
updated: 2026-09-07
type: meta
tags: [wiki, source, provenance]
---

# Raw sources

Preserve first, structure second, synthesize third. Follow [[AGENTS]] and [[SCHEMA]]. This README is not a raw source and does not require raw-source metadata.

`user-notes/`: original owner input. `chats/`: exchanges with context. `transcripts/`: voice/video/meeting text. `articles/`: web clippings. `docs/`: documents and specifications. `logs/`: operational evidence. `assets/`: binary evidence with Markdown wrappers where useful.

Use `templates/raw-source.md` for metadata. Every source needs a form, channel, ingestion date, body-only SHA-256, semantic tags including `source`, and a `processed_to` list. Web sources also need their URL. Link processed pages back to sources, and sources forward to extensionless processed targets.

Do not rewrite raw bodies during normalization. Treat mismatches as source drift; an intentional revision requires explicit approval and a log entry. Do not store credentials as raw knowledge.
