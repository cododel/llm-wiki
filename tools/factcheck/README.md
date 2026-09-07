# Optional Hermes factcheck

`factcheck-trigger.ts` selects committed Markdown changes, divides them into bounded Hermes batches, persists resumable state, retries failed work, recovers stale running batches, creates a final readout, and validates generated provenance/wikilinks before completing.

It is optional. The template installs no Hermes profile, skill, wrapper, schedule, notification transport, or Git automation.

## Requirements

- A Git-backed wiki with committed pages to inspect.
- A working Hermes executable and a profile/skill capable of readonly wiki inspection, web verification, and writing the requested readout.
- GNU `timeout`; on macOS install coreutils and set `FACTCHECK_TIMEOUT_BIN=gtimeout`.
- Bun and the repository validation tools.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `WIKI_DIR` | tool checkout root | Selected wiki repository. |
| `HERMES_BIN` | `hermes` | Hermes executable or operator-controlled path. |
| `HERMES_PROFILE` | `factchecker` | Installed Hermes profile. |
| `HERMES_SKILL` | `wiki/factcheck-wiki` | Installed factcheck skill. |
| `FACTCHECK_TIMEOUT_BIN` | `timeout` | GNU timeout-compatible executable. |
| `FACTCHECK_BATCH_SIZE` | `5` | Files assigned to one batch. |
| `FACTCHECK_MAX_BATCHES_PER_RUN` | `1` | Batches processed by one invocation. |
| `FACTCHECK_TIMEOUT_SEC` | `720` | Per-agent timeout. |
| `FACTCHECK_TIMEOUT_KILL_AFTER_SEC` | `30` | Grace period before forced termination. |
| `FACTCHECK_MAX_RETRIES` | `2` | Maximum attempts per batch. |
| `FACTCHECK_RUNNING_STALE_MINUTES` | derived | Age after which an interrupted running batch is recoverable. |
| `FACTCHECK_FULL` | unset | `1` creates an explicit full baseline. |
| `FACTCHECK_PRINT_NOOP` | unset | `1` prints routine no-change results. |
| `FACTCHECK_AUTO_COMMIT` | unset | `1` stages and commits generated readouts only. |

State/log/stamp paths default to ignored files under `WIKI_DIR` and can be relocated with `FACTCHECK_STATE_FILE`, `FACTCHECK_LOG_FILE`, and `FACTCHECK_STAMP_FILE`.

## Operation

Run the baseline explicitly once:

```sh
FACTCHECK_FULL=1 bun run tools/factcheck/factcheck-trigger.ts
```

Later invocations compare the stored stamp with the current Git `HEAD`. An unfinished queue resumes even if `HEAD` moves; completed batch readouts are retained. The stamp advances only after all batches, summary generation, normalization, and the lint gate succeed.

By default the runner never invokes `git add` or `git commit`. With `FACTCHECK_AUTO_COMMIT=1`, it stages only the generated batch/summary readouts and creates `docs(factcheck): record readouts for <short-sha>`. Pre-staged operator changes remain staged and outside that commit. The runner never pushes.

External scheduling is an operator concern. A scheduler should invoke this command, preserve its exit status, and decide independently whether stdout warrants a notification.
