---
name: query-bench
description: Benchmark SPARQL query performance of Comunica engine configs — A/B tests, ablations, profiling, comparing configs, checking if a change made queries faster or slower, or measuring caching effects. Spawns a local Comunica endpoint per config and reports first/last arrival, total time, results, HTTP requests and result hashes.
---

# Query benchmarking with query-bench

Use the bundled script instead of ad-hoc timing loops, so every comparison follows the same method:

```bash
${CLAUDE_SKILL_DIR}/scripts/bench --engine <engine>/bin/http.js --configs <a.json> <b.json> --queries <file#idx|file|dir|"SPARQL"> [options]
```

`${CLAUDE_SKILL_DIR}/scripts/bench --help` lists every option. The first run may install the script's npm
dependencies.

## Before running

1. **Data sources are not started by the script.** Check that the sources the queries need are up (e.g.
   `curl -sI <a seed URL>`). If they are not, start them or ask the user how; do not benchmark against a down source.
2. **Engine:** `--engine <engine>/bin/http.js`, or the `BENCH_ENGINE` environment variable. Use the engine the user is
   working on. If the engine is TypeScript, make sure it is built (`yarn build` / `tsc`), or you measure stale code.
3. **Configs** must be resolvable by that engine's componentsjs setup. Configs written for another Comunica major
   version (e.g. for a Docker image) fail at startup with "Detected remote context lookup"; use configs from the
   engine's own config package instead.
4. **Context:** by default the endpoint gets `{"sources":[],"lenient":true}`: no fixed sources, as link traversal starts
   from the IRIs in the query, and lenient so failed dereferences do not abort the query. For engines that need
   fixed sources, or to benchmark without lenient mode, pass `--context <file or JSON>`.
5. **Queries:** a file (queries separated by blank lines), a directory, `file#idx` for one query of a file, or an
   inline SPARQL string. Prefer `file#idx` for quick checks; full query files multiply the runtime.

## Choosing parameters

- `--fresh-endpoint true` (default): a new endpoint per measured execution with cache invalidation. Use this for
  A/B tests and ablations. `--fresh-endpoint false` keeps one endpoint per config across all queries, without cache
  invalidation. Use it only when caching itself is evaluated.
- `--warmup` (default 1): unmeasured runs of the same query right before measuring it.
- `--reps` (default 5): use at least 5 when claiming a difference; 2–3 is fine for a smoke test.
- `--timeout` in seconds (default 300). Lower it for quick checks of link-traversal configs, which often run until
  the timeout.
- `--engine-args="..."` for extra endpoint flags, e.g. `--annotateSources graph`.
- `--node-args="--cpu-prof --cpu-prof-dir=<dir>"` to profile the endpoint.
- Use a different `--port` (default 3001) if something else is listening there.

## Running

Each fresh endpoint takes roughly 10–20 s to start, and the total runtime is about
`queries × configs × reps × (startup + (warmup + 1) × query time)`. Estimate it before starting. Run anything longer than
a minute or two in the background and wait for the completion notification instead of polling. Progress lines go to
stderr; the summary table goes to stdout.

## Reporting

Output goes to `./output/bench/<timestamp>/` unless `--out` is given:

- `summary.txt`: the table, with median/geomean/mean per metric. `T`/`E` count timeouts/errors, which are excluded from
  the metrics. `!` means result hashes differ across reps or configs for that query.
- `summary.json`: the same plus the options and the engine's git revision.
- `raw.jsonl`: one line per execution, warmups included, with any extra endpoint metadata.
- `logs/`: endpoint logs, one per endpoint start. Check these when a run fails or times out.

When reporting to the user:

- Show the summary table and give the path to the output directory.
- Point out any timeouts, errors and hash mismatches. A hash mismatch between configs means they return different
  results, which matters more than any speedup.
- Do not call a difference real when it is within the run-to-run spread or rests on 1–2 reps; say so and suggest more
  reps.
- With `--fresh-endpoint false`, `httpRequests` is a per-execution count derived from the endpoint's cumulative
  counter; the raw value is `httpRequestsCumulative`.
