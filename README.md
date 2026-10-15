# query-bench

A Claude Code plugin with one skill, `query-bench`, for quick A/B tests, ablations and profiling of
[Comunica](https://comunica.dev/) engine configs.

For every config, the skill's script starts a local Comunica SPARQL endpoint and runs the queries against it with
[sparql-benchmark-runner](https://github.com/comunica/sparql-benchmark-runner.js). It then summarizes first-arrival
time, last-arrival time, total time, result count and HTTP requests (median, geometric mean, mean), and compares
result hashes across repetitions and configs.

It is for quick checks during development. Use [jbr](https://github.com/rubensworks/jbr.js) for full experiments.

## Install

In Claude Code:

```
/plugin marketplace add <git URL or local path of this repository>
/plugin install query-bench@query-bench
```

To use it without the plugin system, symlink the skill into your user-level skills:

```bash
ln -s "$PWD/skills/query-bench" ~/.claude/skills/query-bench
```

Requires Node.js 22.18 or newer (built-in TypeScript support). Dependencies are installed automatically on first run.

## Running the script directly

```bash
skills/query-bench/scripts/bench \
  --engine path/to/engine/bin/http.js \
  --configs configA.json configB.json \
  --queries queries/q1.sparql "SELECT * WHERE { ... }" \
  --reps 5 --warmup 1 --timeout 300
```

Run `skills/query-bench/scripts/bench --help` for all options. Data sources (e.g. a Solid server) are not started by
the script; start them yourself first.
