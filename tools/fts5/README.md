# Wiki FTS5 search

Bun/SQLite FTS5 lexical search adapted from the source wiki implementation, which credits ObsidianDataWeave's `memory_index.py`. No embeddings, remote models, or npm dependencies are required.

```sh
bun run tools/fts5/wiki-search.ts build
bun run tools/fts5/wiki-search.ts update
bun run tools/fts5/wiki-search.ts status
bun run tools/fts5/wiki-search.ts search "agent memory" --limit 8 --json
bun run tools/fts5/wiki-search.ts search "memory" --folder concepts --tag pattern
bun run tools/fts5/wiki-search.ts search "agent memory" --mode strict
bun run tools/fts5/wiki-search.ts search 'title:"memory" OR body:"source"' --raw
```

`WIKI_DIR` selects the content vault; it defaults to the tool checkout root, not the current working directory. `WIKI_FTS_DB` optionally places the derived index outside the vault. An explicit library `wikiDir` also determines the default DB location. The DB is disposable and not a publication-safe export: it contains indexed private material. Keep it private.

## Search behavior

`auto`: remove common RU/EN glue words, attempt all meaningful keywords, then broaden if nothing matches. `strict`: require all terms. `broad`: match any term. `raw`: trusted FTS5 syntax, with the requested tag filter still applied. `--prefix` applies a prefix match to the final query term.

BM25 weights: title 10, tags 6, headings 4, type 3, wikilinks 3, body 1. Results include path, title, type, tags, score, and highlighted snippet. Scores are corpus-dependent, not probabilities. Folder/type/tag filters and result limits apply.

Wikilinks contribute their full target, stem, and hyphen-separated words. A small RU/EN alias table handles selected transliterations and memory/agent word forms; it is not semantic search. Exact regex or vocabulary mismatch still calls for grep or `wiki_regex_search`.

## Index lifecycle

Build replaces the derived schema; update compares file mtime/size and removes deleted records. SQLite uses WAL and a busy timeout. Root contracts and live content are indexed; index/log files, archived pages, generated factcheck batches, editor/agent state, dependencies, tooling, templates, examples, and packaging documentation are excluded. Factcheck summaries remain searchable.

The CLI has unrestricted local vault access. Remote visibility enforcement belongs to MCP's `access.ts`, not to this local index. Do not serve the SQLite file directly.

```sh
bun test tools/fts5/wiki-search.test.ts
```
