#!/usr/bin/env node
/**
 * Quick A/B / ablation benchmark of Comunica engine configs.
 *
 * For every config, a Comunica SPARQL endpoint is spawned locally, queries are executed against it using
 * sparql-benchmark-runner, and the raw per-execution results are summarized (median / geomean / mean).
 * Data sources (e.g. the Solid server) are NOT started by this script; start them yourself beforehand.
 *
 * Usage:
 *   bench --engine <engine>/bin/http.js --queries <file|dir|file#idx|"SPARQL string">... --configs <config.json>... [options]
 *
 * Options:
 *   --queries         Query files (queries separated by blank lines), directories of such files,
 *                     `file#idx` to select a single query from a file, or inline SPARQL strings.
 *   --configs         Comunica config files, passed to the endpoint as COMUNICA_CONFIG.
 *   --reps            Measured executions per query (default 5).
 *   --warmup          Unmeasured executions of the same query right before it is measured (default 1).
 *   --timeout         Query timeout in seconds, enforced by the endpoint (default 300).
 *   --fresh-endpoint  true (default): a new endpoint per measured execution, started with --invalidateCache,
 *                     so neither cache nor JIT state leaks between measurements (warmups only warm the JIT).
 *                     false: one endpoint per config, kept alive over all queries and without cache
 *                     invalidation, for evaluating caching.
 *   --engine          Path to the engine's bin/http.js (default: $BENCH_ENGINE).
 *   --context         Context file or JSON string passed to the endpoint with -c (default: $BENCH_CONTEXT, or else
 *                     {"sources":[],"lenient":true}: no fixed sources, as link traversal starts from the query's IRIs).
 *   --port            Endpoint port (default 3001).
 *   --max-memory      --max-old-space-size of the endpoint in MB (default 8192).
 *   --engine-args     Extra endpoint arguments, e.g. --engine-args="--annotateSources graph".
 *   --node-args       Extra node arguments for the endpoint, e.g. --node-args="--cpu-prof --cpu-prof-dir=prof".
 *   --out             Output directory (default: ./output/bench/<timestamp>).
 *   --verbose         Echo endpoint logs to stderr.
 *
 * Output (in --out): raw.jsonl (one line per execution, warmups included), summary.json, summary.txt and
 * logs/ with the endpoint logs. The summary table is also printed to stdout.
 *
 * Notes:
 *   - Timed-out and failed executions are excluded from the metrics and counted separately (raw.jsonl keeps them).
 *   - With --fresh-endpoint false, the endpoint reports HTTP requests cumulatively over the worker's lifetime;
 *     httpRequests is the per-execution difference, httpRequestsCumulative the reported value.
 *   - Result hashes ignore blank node labels, as these differ between executions.
 *   - The endpoint always gets --idp void, which disables Solid authentication; other engines ignore it.
 */
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { SparqlBenchmarkRunner } from 'sparql-benchmark-runner';
import type { IResult } from 'sparql-benchmark-runner';

const STARTUP_TIMEOUT_MS = 180_000;
const DEFAULT_CONTEXT = '{"sources":[],"lenient":true}';
const SHUTDOWN_GRACE_MS = 5_000;
// Number of endpoint starts per config label, so every start gets its own log file
const endpointStarts = new Map<string, number>();
// Set on SIGINT/SIGTERM, makes the run stop at the next execution
let interrupted = false;
// Fields of a sparql-benchmark-runner result that are not endpoint metadata
const RESULT_FIELDS = new Set([ 'name', 'id', 'results', 'hash', 'time', 'timestamps', 'error', 'httpRequests' ]);

interface IOptions {
  queries: string[];
  configs: string[];
  reps: number;
  warmup: number;
  timeout: number;
  freshEndpoint: boolean;
  engine: string;
  context: string;
  port: number;
  maxMemory: number;
  engineArgs: string[];
  nodeArgs: string[];
  out: string;
  verbose: boolean;
}

interface IQuery {
  name: string;
  id: string;
  query: string;
}

interface IConfig {
  label: string;
  path: string;
}

interface IRunRecord {
  config: string;
  query: string;
  id: string;
  phase: 'warmup' | 'measure';
  rep: number;
  time: number;
  firstArrival?: number;
  lastArrival?: number;
  results: number;
  httpRequests?: number;
  httpRequestsCumulative?: number;
  hash: string;
  timedOut: boolean;
  error?: string;
  endpointStartupMs?: number;
  metadata?: Record<string, unknown>;
}

interface IStat {
  median: number;
  geomean: number;
  mean: number;
  n: number;
}

interface ISummaryRow {
  config: string;
  query: string;
  id: string;
  runs: number;
  ok: number;
  timeouts: number;
  errors: number;
  firstArrival?: IStat;
  lastArrival?: IStat;
  totalTime?: IStat;
  results?: IStat;
  httpRequests?: IStat;
  hashes: Record<string, number>;
  hashMismatch: boolean;
}

// --- Arguments ---

const FLAGS = new Set([
  'queries', 'configs', 'reps', 'warmup', 'timeout', 'fresh-endpoint', 'engine', 'context', 'port',
  'max-memory', 'engine-args', 'node-args', 'out', 'verbose', 'help',
]);

/**
 * Parses `--flag v1 v2 ...` and `--flag=value` into lists of values per flag.
 * Values starting with `--` (e.g. engine arguments) must be passed using the `=` form.
 */
function parseArgv(argv: string[]): Record<string, string[]> {
  const args: Record<string, string[]> = {};
  let key: string | undefined;
  for (const token of argv) {
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      key = token.slice(2, eq === -1 ? undefined : eq);
      if (!FLAGS.has(key)) {
        throw new Error(`Unknown option --${key}`);
      }
      args[key] ??= [];
      if (eq !== -1) {
        args[key].push(token.slice(eq + 1));
        key = undefined;
      }
    } else if (key) {
      args[key].push(token);
    } else {
      throw new Error(`Unexpected argument '${token}'`);
    }
  }
  return args;
}

function parseOptions(argv: string[]): IOptions {
  const args = parseArgv(argv);
  if (args.help) {
    const doc = readFileSync(import.meta.filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//u)![1];
    process.stdout.write(`${doc.replaceAll(/^ \* ?/gmu, '')}\n`);
    process.exit(0);
  }
  const single = (key: string): string | undefined => args[key]?.at(-1);
  const number = (key: string, fallback: number): number => {
    const value = single(key);
    if (value === undefined) {
      return fallback;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`--${key} expects a non-negative number, got '${value}'`);
    }
    return parsed;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    if (!args[key]) {
      return fallback;
    }
    const value = single(key);
    if (value === undefined || value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
    throw new Error(`--${key} expects true or false, got '${value}'`);
  };
  const words = (key: string): string[] => (args[key] ?? []).flatMap(value => value.split(/\s+/u)).filter(Boolean);

  if (!args.queries?.length) {
    throw new Error('Missing --queries');
  }
  if (!args.configs?.length) {
    throw new Error('Missing --configs');
  }
  const engine = single('engine') ?? process.env.BENCH_ENGINE;
  if (!engine) {
    throw new Error('Missing --engine (or the BENCH_ENGINE environment variable)');
  }
  const context = single('context') ?? process.env.BENCH_CONTEXT ?? DEFAULT_CONTEXT;
  const options: IOptions = {
    queries: args.queries,
    configs: args.configs,
    reps: number('reps', 5),
    warmup: number('warmup', 1),
    timeout: number('timeout', 300),
    freshEndpoint: bool('fresh-endpoint', true),
    engine: resolve(engine),
    // A context is either a file or an inline JSON string
    context: context.trimStart().startsWith('{') ? context : resolve(context),
    port: number('port', 3001),
    maxMemory: number('max-memory', 8192),
    engineArgs: words('engine-args'),
    nodeArgs: words('node-args'),
    out: resolve(single('out') ?? join('output/bench', new Date().toISOString().replaceAll(':', '-').slice(0, 19))),
    verbose: bool('verbose', false),
  };
  if (options.reps < 1 || options.timeout <= 0) {
    throw new Error('--reps must be at least 1 and --timeout must be positive');
  }
  const contextFile = options.context.trimStart().startsWith('{') ? undefined : options.context;
  for (const file of [ options.engine, contextFile, ...options.configs ]) {
    if (file && !existsSync(file)) {
      throw new Error(`File not found: ${file}`);
    }
  }
  return options;
}

// --- Inputs ---

function splitQueries(file: string): string[] {
  return readFileSync(file, 'utf8').split(/\r?\n\s*\r?\n/u).map(query => query.trim()).filter(Boolean);
}

function loadQueries(inputs: string[]): IQuery[] {
  const queries: IQuery[] = [];
  let inline = 0;
  for (const input of inputs) {
    const selector = /^(.*)#(\d+)$/u.exec(input);
    if (selector && existsSync(selector[1]) && statSync(selector[1]).isFile()) {
      const query = splitQueries(selector[1])[Number(selector[2])];
      if (!query) {
        throw new Error(`No query with index ${selector[2]} in ${selector[1]}`);
      }
      queries.push({ name: basename(selector[1], extname(selector[1])), id: selector[2], query });
    } else if (existsSync(input)) {
      const files = statSync(input).isDirectory() ?
        readdirSync(input).sort().map(file => join(input, file)).filter(file => statSync(file).isFile()) :
          [ input ];
      for (const file of files) {
        for (const [ id, query ] of splitQueries(file).entries()) {
          queries.push({ name: basename(file, extname(file)), id: id.toString(), query });
        }
      }
    } else if (/\s/u.test(input)) {
      queries.push({ name: `inline-${inline++}`, id: '0', query: input.trim() });
    } else {
      throw new Error(`Query file not found: ${input}`);
    }
  }
  return queries;
}

function loadConfigs(paths: string[]): IConfig[] {
  const labels = paths.map(path => basename(path, extname(path)));
  return paths.map((path, i) => ({
    // Fall back to the relative path when two configs share a file name
    label: labels.indexOf(labels[i]) === labels.lastIndexOf(labels[i]) ? labels[i] : relative(process.cwd(), resolve(path)),
    path: resolve(path),
  }));
}

// --- Endpoint ---

/**
 * A Comunica SPARQL endpoint running as a child process in its own process group (master + cluster workers).
 */
class Endpoint {
  public readonly url: string;
  private child?: ChildProcess;
  private exited?: Promise<void>;
  private httpRequestsBaseline?: number;
  private readonly options: IOptions;
  private readonly config: IConfig;

  public constructor(options: IOptions, config: IConfig) {
    this.options = options;
    this.config = config;
    this.url = `http://localhost:${options.port}/sparql`;
  }

  public get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null;
  }

  /**
   * Spawns the endpoint and waits until it answers.
   * @returns The startup duration in milliseconds.
   */
  public async start(): Promise<number> {
    await this.waitForPortFree();
    const logDir = join(this.options.out, 'logs');
    mkdirSync(logDir, { recursive: true });
    const start = endpointStarts.get(this.config.label) ?? 0;
    endpointStarts.set(this.config.label, start + 1);
    const logPath = join(logDir, `${this.config.label.replaceAll('/', '_')}.${start}.log`);
    const log = openSync(logPath, 'a');
    const args = [
      ...this.options.nodeArgs,
      `--max-old-space-size=${this.options.maxMemory}`,
      this.options.engine,
      '-p', this.options.port.toString(),
      '-t', this.options.timeout.toString(),
      '-w', '1',
      '--idp', 'void',
      '-c', this.options.context,
      ...this.options.freshEndpoint ? [ '--invalidateCache' ] : [],
      ...this.options.engineArgs,
    ];
    const startTime = performance.now();
    const child = spawn(process.execPath, args, {
      cwd: this.options.out,
      env: { ...process.env, COMUNICA_CONFIG: this.config.path, NODE_ENV: 'production' },
      detached: true,
      stdio: [ 'ignore', this.options.verbose ? 'inherit' : log, this.options.verbose ? 'inherit' : log ],
    });
    closeSync(log);
    this.child = child;
    this.exited = new Promise(resolve => child.once('exit', () => resolve()));
    this.httpRequestsBaseline = 0;

    while (!await this.available()) {
      if (!this.running) {
        throw new Error(`Endpoint for ${this.config.label} exited during startup, see ${logPath}`);
      }
      if (performance.now() - startTime > STARTUP_TIMEOUT_MS) {
        await this.stop();
        throw new Error(`Endpoint for ${this.config.label} not available after ${STARTUP_TIMEOUT_MS / 1000}s, see ${logPath}`);
      }
      await sleep(200);
    }
    return Math.round(performance.now() - startTime);
  }

  /**
   * Waits until the endpoint answers again, e.g. after the master respawned a timed-out worker.
   * @returns false if the endpoint process itself died.
   */
  public async waitUntilAvailable(): Promise<boolean> {
    while (!await this.available()) {
      if (!this.running) {
        return false;
      }
      await sleep(200);
    }
    return true;
  }

  /**
   * Without cache invalidation, the engine's HTTP request counter accumulates over all queries a worker executes,
   * so the per-execution count is the difference with the previous execution on this endpoint.
   * @returns undefined if the count of the previous execution is unknown.
   */
  public httpRequestsDelta(cumulative: number | undefined, timedOut: boolean): number | undefined {
    const baseline = this.httpRequestsBaseline;
    // A timeout makes the master replace the worker, whose counter starts from zero again
    this.httpRequestsBaseline = timedOut ? 0 : cumulative;
    if (cumulative === undefined || baseline === undefined) {
      return undefined;
    }
    return cumulative >= baseline ? cumulative - baseline : cumulative;
  }

  /**
   * Stops the endpoint: SIGINT lets the master disconnect its workers cleanly (so e.g. --cpu-prof profiles are
   * written), after which the whole process group is killed.
   */
  public async stop(): Promise<void> {
    const child = this.child;
    if (!child?.pid) {
      return;
    }
    if (this.running) {
      child.kill('SIGINT');
      await Promise.race([ this.exited, sleep(SHUTDOWN_GRACE_MS) ]);
    }
    for (const signal of [ 'SIGTERM', 'SIGKILL' ] as const) {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Process group already gone
        break;
      }
      await sleep(signal === 'SIGTERM' ? 500 : 0);
    }
    await this.exited;
    this.child = undefined;
  }

  private async available(): Promise<boolean> {
    try {
      const response = await fetch(this.url, { signal: AbortSignal.timeout(1_000) });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  private async waitForPortFree(): Promise<void> {
    for (let i = 0; await this.available(); i++) {
      if (i >= 50) {
        throw new Error(`Something is still listening on ${this.url}; stop it before benchmarking`);
      }
      await sleep(200);
    }
  }
}

// --- Execution ---

type Bindings = Parameters<SparqlBenchmarkRunner['bindingsToString']>[0];
const BLANK_NODE: Bindings[string] = { termType: 'BlankNode', value: 'b', equals: other => other?.termType === 'BlankNode' };

/**
 * Blank node labels differ between executions, so they are ignored when hashing results.
 */
class BenchmarkRunner extends SparqlBenchmarkRunner {
  public override bindingsToString(bindings: Bindings): string {
    return super.bindingsToString(Object.fromEntries(Object.entries(bindings)
      .map(([ key, term ]) => [ key, term.termType === 'BlankNode' ? BLANK_NODE : term ])));
  }
}

class Bench {
  public readonly records: IRunRecord[] = [];
  private readonly runner: BenchmarkRunner;
  private readonly rawPath: string;
  private readonly options: IOptions;
  private readonly totalExecutions: number;
  private executions = 0;

  public constructor(options: IOptions, totalExecutions: number) {
    this.options = options;
    this.totalExecutions = totalExecutions;
    this.runner = new BenchmarkRunner({
      endpoint: `http://localhost:${options.port}/sparql`,
      querySets: {},
      replication: options.reps,
      warmup: options.warmup,
      // The endpoint enforces the timeout; this client-side one is only a fallback
      timeout: (options.timeout + 30) * 1_000,
    });
    this.rawPath = join(options.out, 'raw.jsonl');
  }

  /**
   * Executes a query once, restarting the endpoint if it died, and records the result.
   */
  public async execute(
    endpoint: Endpoint,
    config: IConfig,
    query: IQuery,
    phase: IRunRecord['phase'],
    rep: number,
    endpointStartupMs?: number,
  ): Promise<void> {
    if (interrupted) {
      throw new Error('Interrupted');
    }
    if (!await endpoint.waitUntilAvailable()) {
      log(`Endpoint for ${config.label} died, restarting`);
      await endpoint.stop();
      endpointStartupMs = await endpoint.start();
    }
    const result: IResult = await this.runner.executeQuery(query.name, query.id, query.query);
    if (interrupted) {
      // The execution was cut short by stopping the endpoint, so it is not recorded
      throw new Error('Interrupted');
    }
    const timedOut = result.time >= this.options.timeout * 1_000;
    const reportedHttpRequests = typeof result.httpRequests === 'number' ? result.httpRequests : undefined;
    const metadata = Object.fromEntries(Object.entries(result).filter(([ key ]) => !RESULT_FIELDS.has(key)));
    const record: IRunRecord = {
      config: config.label,
      query: query.name,
      id: query.id,
      phase,
      rep,
      time: result.time,
      firstArrival: result.timestamps.at(0),
      lastArrival: result.timestamps.at(-1),
      results: result.results,
      httpRequests: this.options.freshEndpoint ?
        reportedHttpRequests :
        endpoint.httpRequestsDelta(reportedHttpRequests, timedOut),
      httpRequestsCumulative: this.options.freshEndpoint ? undefined : reportedHttpRequests,
      hash: result.hash,
      timedOut,
      error: result.error ? `${result.error.name}: ${result.error.message}` : undefined,
      endpointStartupMs,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
    this.records.push(record);
    appendFileSync(this.rawPath, `${JSON.stringify(record)}\n`);

    const progress = phase === 'measure' ? `[${++this.executions}/${this.totalExecutions}]` : '[warmup]';
    const status = record.error ?? (timedOut ? 'TIMEOUT' : `${record.results} results, ${record.httpRequests ?? '?'} requests`);
    log(`${progress} ${config.label} · ${query.name}#${query.id} · rep ${rep + 1} · ${record.time} ms · ${status}`);
  }

  /**
   * Warms up and measures a single query on an endpoint that is already running.
   */
  public async measure(endpoint: Endpoint, config: IConfig, query: IQuery, reps: number, startupMs?: number): Promise<void> {
    for (let i = 0; i < this.options.warmup; i++) {
      await this.execute(endpoint, config, query, 'warmup', i, i === 0 ? startupMs : undefined);
      startupMs = undefined;
    }
    for (let rep = 0; rep < reps; rep++) {
      await this.execute(endpoint, config, query, 'measure', rep, rep === 0 ? startupMs : undefined);
    }
  }
}

/**
 * Fresh endpoints: interleave configs per repetition, so drift over time (thermal, background load) affects all
 * configs equally. Each measured execution gets its own endpoint, preceded by its warmup executions.
 */
async function runFresh(bench: Bench, options: IOptions, configs: IConfig[], queries: IQuery[], current: { endpoint?: Endpoint }): Promise<void> {
  for (const query of queries) {
    for (let rep = 0; rep < options.reps; rep++) {
      for (const config of configs) {
        const endpoint = new Endpoint(options, config);
        current.endpoint = endpoint;
        const startupMs = await endpoint.start();
        for (let i = 0; i < options.warmup; i++) {
          await bench.execute(endpoint, config, query, 'warmup', i, i === 0 ? startupMs : undefined);
        }
        await bench.execute(endpoint, config, query, 'measure', rep, options.warmup === 0 ? startupMs : undefined);
        await endpoint.stop();
      }
    }
  }
}

/**
 * Persistent endpoints: one endpoint per config that lives across all queries, so caches carry over.
 */
async function runPersistent(bench: Bench, options: IOptions, configs: IConfig[], queries: IQuery[], current: { endpoint?: Endpoint }): Promise<void> {
  for (const config of configs) {
    const endpoint = new Endpoint(options, config);
    current.endpoint = endpoint;
    let startupMs: number | undefined = await endpoint.start();
    for (const query of queries) {
      await bench.measure(endpoint, config, query, options.reps, startupMs);
      startupMs = undefined;
    }
    await endpoint.stop();
  }
}

// --- Summary ---

function stat(values: number[]): IStat | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    // A zero (e.g. no results) makes the geometric mean zero
    geomean: sorted[0] <= 0 ? 0 : Math.exp(sorted.reduce((sum, value) => sum + Math.log(value), 0) / sorted.length),
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    n: sorted.length,
  };
}

function definedNumbers(values: (number | undefined)[]): number[] {
  return values.filter((value): value is number => value !== undefined);
}

function summarize(records: IRunRecord[], configs: IConfig[], queries: IQuery[]): ISummaryRow[] {
  const rows: ISummaryRow[] = [];
  for (const query of queries) {
    const queryRows: ISummaryRow[] = [];
    for (const config of configs) {
      const runs = records.filter(record => record.phase === 'measure' && record.config === config.label &&
        record.query === query.name && record.id === query.id);
      if (runs.length === 0) {
        continue;
      }
      // Failed executions are excluded from the metrics, and counted separately
      const ok = runs.filter(run => !run.error && !run.timedOut);
      const hashes: Record<string, number> = {};
      for (const run of ok) {
        hashes[run.hash] = (hashes[run.hash] ?? 0) + 1;
      }
      queryRows.push({
        config: config.label,
        query: query.name,
        id: query.id,
        runs: runs.length,
        ok: ok.length,
        timeouts: runs.filter(run => run.timedOut).length,
        errors: runs.filter(run => run.error && !run.timedOut).length,
        firstArrival: stat(definedNumbers(ok.map(run => run.firstArrival))),
        lastArrival: stat(definedNumbers(ok.map(run => run.lastArrival))),
        totalTime: stat(ok.map(run => run.time)),
        results: stat(ok.map(run => run.results)),
        httpRequests: stat(definedNumbers(ok.map(run => run.httpRequests))),
        hashes,
        hashMismatch: false,
      });
    }
    // Flag rows whose result hashes are not all equal to the ones of the other configs for this query
    const allHashes = new Set(queryRows.flatMap(row => Object.keys(row.hashes)));
    for (const row of queryRows) {
      row.hashMismatch = allHashes.size > 1 && Object.keys(row.hashes).length > 0;
    }
    rows.push(...queryRows);
  }
  return rows;
}

function formatStat(value?: IStat): string {
  if (!value) {
    return '-';
  }
  const format = (x: number): string => (Number.isInteger(x) || x >= 100 ? Math.round(x).toString() : x.toFixed(1));
  return `${format(value.median)}/${format(value.geomean)}/${format(value.mean)}`;
}

function formatTable(rows: ISummaryRow[]): string {
  const header = [ 'query', 'config', 'ok', 'first (ms)', 'last (ms)', 'total (ms)', 'results', 'http requests', 'hashes' ];
  const body = rows.map(row => [
    `${row.query}#${row.id}`,
    row.config,
    `${row.ok}/${row.runs}${row.timeouts ? ` T${row.timeouts}` : ''}${row.errors ? ` E${row.errors}` : ''}`,
    formatStat(row.firstArrival),
    formatStat(row.lastArrival),
    formatStat(row.totalTime),
    formatStat(row.results),
    formatStat(row.httpRequests),
    `${Object.entries(row.hashes).map(([ hash, count ]) => `${hash.slice(0, 8)}×${count}`).join(',') || '-'}${row.hashMismatch ? ' !' : ''}`,
  ]);
  const widths = header.map((cell, i) => Math.max(cell.length, ...body.map(line => line[i].length)));
  const line = (cells: string[]): string => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  return [
    'Metrics are median/geomean/mean over successful measured executions. T = timeouts, E = errors.',
    '"!" marks results whose hash differs across reps or configs for the same query.',
    '',
    line(header),
    line(widths.map(width => '-'.repeat(width))),
    ...body.map(line),
  ].join('\n');
}

function gitRevision(path: string): string | undefined {
  try {
    const cwd = dirname(path);
    const commit = execFileSync('git', [ 'rev-parse', '--short', 'HEAD' ], { cwd, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', [ 'status', '--porcelain' ], { cwd, encoding: 'utf8' }).trim().length > 0;
    return `${commit}${dirty ? '-dirty' : ''}`;
  } catch {
    return undefined;
  }
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

// --- Main ---

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const queries = loadQueries(options.queries);
  const configs = loadConfigs(options.configs);
  mkdirSync(options.out, { recursive: true });

  const bench = new Bench(options, queries.length * configs.length * options.reps);
  const current: { endpoint?: Endpoint } = {};
  const startedAt = new Date().toISOString();
  const meta = {
    startedAt,
    options,
    configs,
    queries: queries.map(({ name, id }) => `${name}#${id}`),
    engineRevision: gitRevision(options.engine),
    node: process.version,
  };
  log(`Benchmarking ${queries.length} queries × ${configs.length} configs × ${options.reps} reps ` +
    `(warmup ${options.warmup}, ${options.freshEndpoint ? 'fresh endpoint per execution' : 'persistent endpoint per config'}), ` +
    `output in ${options.out}`);

  const finish = (interrupted: boolean): void => {
    const rows = summarize(bench.records, configs, queries);
    const table = formatTable(rows);
    writeFileSync(join(options.out, 'summary.json'), JSON.stringify({
      ...meta,
      finishedAt: new Date().toISOString(),
      interrupted,
      results: rows,
    }, null, 2));
    writeFileSync(join(options.out, 'summary.txt'), `${table}\n`);
    process.stdout.write(`\n${table}\n\nRaw results: ${join(options.out, 'raw.jsonl')}\nSummary: ${join(options.out, 'summary.json')}\n`);
  };

  const interrupt = (): void => {
    if (!interrupted) {
      interrupted = true;
      log('Interrupted, stopping endpoint and writing partial summary');
      void current.endpoint?.stop();
    }
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);

  try {
    await (options.freshEndpoint ? runFresh : runPersistent)(bench, options, configs, queries, current);
  } catch (error: unknown) {
    if (!interrupted) {
      throw error;
    }
  } finally {
    await current.endpoint?.stop();
  }
  finish(interrupted);
  if (interrupted) {
    process.exit(130);
  }
}

main().catch((error: Error) => {
  log(error.message);
  process.exit(1);
});
