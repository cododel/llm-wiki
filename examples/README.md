# Synthetic service example

Examples are documentation, not instance seed data. Nothing here is loaded automatically.

An agent preserving a research note can:

1. Submit a raw-source operation with the exact UTF-8 bytes of
   `Keeping the original allows later re-evaluation.`, canonical base64 and its SHA-256.
   Use source_kind `user-note`, source_channel `manual`, capture_boundary `complete`, tag `source`.
2. Use the returned immutable source revision in a readout's `sources: [{revision: ...}]`.
   The readout separates the observation date, evidence and interpretation; tag it `readout`.
3. Create a concept tagged `provenance`, cite the same raw revision and relate it to the readout
   using stable record IDs. Its body explains why preserved inputs support later re-evaluation.
4. Query `wiki_get_sources` on the raw record: the service derives both processed targets.
5. Request publication of the concept's exact revision only. The owner reviews and confirms in
   the browser. The raw source and readout remain private; public source/relationship output
   does not disclose them.

See [MCP](../docs/MCP.md) for typed operations and [templates](../templates/README.md) for bodies.
The integration tests use independently generated neutral records and never import this example.
