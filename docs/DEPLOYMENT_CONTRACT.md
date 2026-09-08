# Deployment and initialization contract

Status: accepted target; not a statement of current runtime capability.

The distribution includes a complete Docker Compose service arrangement with external OAuth and persistent instance storage. The wiki backend is not directly published as an unauthenticated alternative to the authorized endpoint. An optional public surface follows the access contract.

## Instance lifecycle

- Code and packaged templates are separate from mutable instance data.
- Initialize an empty instance volume from the neutral template once. Initialization must distinguish an interrupted first setup from an existing instance and must not overwrite user data.
- Restarting or replacing service containers preserves knowledge and operational state needed for recovery. Updating an image does not reapply the initial template over existing content.
- Repository service ADRs/contracts, synthetic demos, source-vault history, credentials, and runtime state are not initial instance knowledge.
- Keep auth secrets/state outside knowledge content. Search caches remain disposable; source data, assignments, accepted results, and undelivered events require persistence.
- The initial content vocabulary reuses the existing template. A broad redesign of data organization is outside this decision. Database engine and physical schema are not selected by this contract.

## Acceptance anchors

Demonstrate first initialization, interrupted initialization recovery, repeat startup without data replacement, container recreation with retained work/results, private backend isolation, and absence of secrets/development documentation in instance knowledge.

Decision provenance: [Compose storage](adr/adr-20260908-compose-instance-storage.md).
Related: [access](ACCESS_CONTRACT.md), [knowledge](KNOWLEDGE_CONTRACT.md), [factchecking](FACTCHECK_CONTRACT.md).

