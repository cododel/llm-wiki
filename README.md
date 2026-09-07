# LLM Wiki

A portable Markdown knowledge-base template for human–agent collaboration.

The template contains wiki conventions, reusable page templates, validation tools,
lexical search, and a read-only MCP server. Personal knowledge and the source
vault's Git history are not included.

## Safety defaults

- Public MCP access requires explicit `visibility: public` on each page.
- Administrative access remains read-only; remote access requires OAuth.
- Factchecking is optional. No scheduled jobs or automatic commits are enabled.
- Runtime databases, credentials, and local settings do not belong in Git.

See `SCHEMA.md` for the content contract and `AGENTS.md` for agent workflows.
