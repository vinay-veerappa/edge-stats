/*
  The store: one DuckDB file per data directory plus hive-partitioned
  parquet for raw bars (symbol / timeframe / year). Everything lives on the
  user's disk; `edgestats export` can hand any of it back out because it
  was never anywhere else.

  Layout under <dataDir>/:
    edge-stats.duckdb   sessions, features, watermarks, events, meta, alerts
    bars/               parquet partitions: symbol=X/tf=1m/year=2024/*.parquet
    calendar/           holiday + half-day calendars this store derives with
    events/             macro event dates (FOMC, CPI, NFP, OPEX, …)
    presets/            the preset catalog this store serves
    tmp/                scratch files for ingest (safe to delete)
*/
import { mkdirSync, existsSync, readdirSync, statSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { sqlNum, sqlPath, sqlStr } from "../util/sql";
import { asInt, asNum, asStr } from "../util/values";
import { ENGINE_VERSION } from "../version";

export interface BarRow {
  symbol: string;
  tf: string;
  /** UTC epoch milliseconds of the bar's open. */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Underlying futures contract, when applicable (roll detection reads this). */
  contract?: string | null;
}

/**
 * A symbol whose bars live outside the data directory and are read in place:
 * `<root>/<name>/<YYYY>.parquet` with `ts_open` (timestamp, UTC, open-stamped),
 * `open high low close`, an integer `volume` and an optional `contract`.
 * The store only ever reads these files.
 */
export interface ExternalBarSource {
  /** The symbol as configured (what queries and `bars.symbol` call it). */
  symbol: string;
  tf: string;
  /** Directory holding one sub-directory per root, e.g. `<store>/bars/1m`. */
  root: string;
  /** The root's sub-directory, e.g. `NQ`. */
  name: string;
}

export interface StoreOptions {
  /** Symbols read in place; they are never copied, ingested into, or dropped. */
  external?: ExternalBarSource[];
  /** Optional SQLite database for economic events (dev.db). */
  economicDb?: string;
}

export interface IngestResult {
  inserted: number;
  skipped: number;
  minTs: number | null;
  maxTs: number | null;
}

function hasParquet(dir: string): boolean {
  if (!existsSync(dir)) return false;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) stack.push(full);
      else if (name.endsWith(".parquet")) return true;
    }
  }
  return false;
}

/** Our bar columns as edge-stats' bar row. Both sides are open-stamped, so `ts` is a plain conversion. */
const EXTERNAL_PROJECTION = `epoch_ms(ts_open) AS ts, open, high, low, close,
  CAST(volume AS DOUBLE) AS volume, CAST(contract AS VARCHAR) AS contract`;

export class Store {
  private readonly externals: Map<string, ExternalBarSource>;
  private readonly economicDb?: string;

  private constructor(
    readonly dataDir: string,
    private readonly instance: DuckDBInstance,
    private readonly conn: DuckDBConnection,
    externals: ExternalBarSource[],
    economicDb?: string,
  ) {
    this.externals = new Map(externals.map((e) => [e.symbol, e]));
    this.economicDb = economicDb;
  }

  static async open(dataDir: string, opts: StoreOptions = {}): Promise<Store> {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(dataDir, "bars"), { recursive: true });
    mkdirSync(join(dataDir, "tmp"), { recursive: true });
    const instance = await DuckDBInstance.create(join(dataDir, "edge-stats.duckdb"));
    const conn = await instance.connect();
    const store = new Store(dataDir, instance, conn, opts.external ?? [], opts.economicDb);
    try {
      await store.ensureSchema();
      await store.refreshBarsView();
      await store.refreshEventsView();
    } catch (err) {
      // a refused open (e.g. a missing external directory) must not keep the db file locked
      await store.close();
      throw err;
    }
    return store;
  }

  get barsDir(): string {
    return join(this.dataDir, "bars");
  }

  get tmpDir(): string {
    return join(this.dataDir, "tmp");
  }

  private refuseExternal(symbol: string, action: string): void {
    if (this.externals.has(symbol)) {
      throw new Error(
        `refusing to ${action} '${symbol}': its bars are external and read in place, never written or deleted by edge-stats`,
      );
    }
  }

  /** True when this symbol's bars are read in place from an external store. */
  isExternal(symbol: string): boolean {
    return this.externals.has(symbol);
  }

  /**
   * SQL source for (symbol, tf) restricted to the given years, with the
   * columns `ts, open, high, low, close, volume`, or null when no partition
   * exists. Reading through this instead of the `bars` view is how a
   * per-session read stays independent of the size of the history.
   *
   * `window` ([fromMs, toMs) of bar opens) is only a pruning hint: an external
   * source filters on the raw `ts_open` column, which DuckDB can prune row
   * groups on, whereas a filter on the projected `epoch_ms(ts_open)` it cannot.
   * Callers still apply their own `ts` predicate.
   */
  barSource(
    symbol: string,
    tf: string,
    years: number[],
    window?: { fromMs: number; toMs: number },
  ): string | null {
    const external = this.externals.get(symbol);
    if (external) {
      const files: string[] = [];
      for (const year of new Set(years)) {
        const file = join(external.root, external.name, `${year}.parquet`);
        if (existsSync(file)) files.push(sqlPath(file));
      }
      if (files.length === 0) return null;
      // make_timestamptz takes absolute microseconds, so the literal does not
      // depend on the connection's TimeZone setting (a plain epoch_ms cast would).
      const prune = window
        ? ` WHERE ts_open >= make_timestamptz(${sqlNum(window.fromMs * 1000)}) AND ts_open < make_timestamptz(${sqlNum(window.toMs * 1000)})`
        : "";
      return `(SELECT ${EXTERNAL_PROJECTION} FROM read_parquet([${files.join(", ")}])${prune})`;
    }
    const globs: string[] = [];
    for (const year of new Set(years)) {
      const dir = join(this.barsDir, `symbol=${symbol}`, `tf=${tf}`, `year=${year}`);
      if (existsSync(dir)) globs.push(join(dir, "*.parquet"));
    }
    if (globs.length === 0) return null;
    return `read_parquet([${globs.map((g) => sqlPath(g)).join(", ")}], union_by_name = true)`;
  }

  async run(sql: string): Promise<void> {
    await this.conn.run(sql);
  }

  async all(sql: string): Promise<Record<string, unknown>[]> {
    const reader = await this.conn.runAndReadAll(sql);
    return reader.getRowObjects() as Record<string, unknown>[];
  }

  async one(sql: string): Promise<Record<string, unknown> | null> {
    const rows = await this.all(sql);
    return rows[0] ?? null;
  }

  private async ensureSchema(): Promise<void> {
    await this.run(`
      CREATE TABLE IF NOT EXISTS watermarks (
        symbol VARCHAR, tf VARCHAR, adapter VARCHAR,
        last_ts BIGINT, updated_at TIMESTAMP DEFAULT now(),
        PRIMARY KEY (symbol, tf, adapter)
      );
      CREATE TABLE IF NOT EXISTS meta (
        key VARCHAR PRIMARY KEY, value VARCHAR
      );
      CREATE TABLE IF NOT EXISTS alerts (
        id VARCHAR PRIMARY KEY, fired_at TIMESTAMP, symbol VARCHAR,
        query VARCHAR, snapshot JSON
      );
    `);
    await this.setMeta("engine_version", ENGINE_VERSION);
  }

  async refreshBarsView(): Promise<void> {
    const branches: string[] = [];
    if (hasParquet(this.barsDir)) {
      // Native bars; an external symbol's bars are never read from here.
      const external = [...this.externals.keys()];
      const skip =
        external.length > 0
          ? `WHERE symbol NOT IN (${external.map((x) => sqlStr(x)).join(", ")})`
          : "";
      branches.push(`
        SELECT symbol, tf, ts, open, high, low, close, volume, contract
        FROM read_parquet(${sqlPath(this.barsDir + "/**/*.parquet")},
                          hive_partitioning = true, union_by_name = true)
        ${skip}`);
    }
    for (const e of this.externals.values()) {
      const dir = join(e.root, e.name);
      if (!hasParquet(dir)) {
        throw new Error(
          `external bars for '${e.symbol}': no parquet files under ${dir} (check external.root / external.name in the config)`,
        );
      }
      branches.push(`
        SELECT ${sqlStr(e.symbol)} AS symbol, ${sqlStr(e.tf)} AS tf, ${EXTERNAL_PROJECTION}
        FROM read_parquet(${sqlPath(join(dir, "*.parquet"))})`);
    }
    if (branches.length > 0) {
      await this.run(`CREATE OR REPLACE VIEW bars AS ${branches.join(" UNION ALL ")}`);
    } else {
      await this.run(`
        CREATE OR REPLACE VIEW bars AS
        SELECT CAST(NULL AS VARCHAR) AS symbol, CAST(NULL AS VARCHAR) AS tf,
               CAST(NULL AS BIGINT) AS ts, CAST(NULL AS DOUBLE) AS open,
               CAST(NULL AS DOUBLE) AS high, CAST(NULL AS DOUBLE) AS low,
               CAST(NULL AS DOUBLE) AS close, CAST(NULL AS DOUBLE) AS volume,
               CAST(NULL AS VARCHAR) AS contract
        WHERE FALSE
      `);
    }
  }

  async getWatermark(symbol: string, tf: string, adapter: string): Promise<number | null> {
    const row = await this.one(`
      SELECT last_ts FROM watermarks
      WHERE symbol = ${sqlStr(symbol)} AND tf = ${sqlStr(tf)} AND adapter = ${sqlStr(adapter)}
    `);
    return row ? asNum(row.last_ts) : null;
  }

  async setWatermark(symbol: string, tf: string, adapter: string, lastTs: number): Promise<void> {
    await this.run(`
      INSERT OR REPLACE INTO watermarks (symbol, tf, adapter, last_ts, updated_at)
      VALUES (${sqlStr(symbol)}, ${sqlStr(tf)}, ${sqlStr(adapter)}, ${sqlNum(lastTs)}, now())
    `);
  }

  async clearWatermark(symbol: string, tf: string, adapter: string): Promise<void> {
    await this.run(`
      DELETE FROM watermarks
      WHERE symbol = ${sqlStr(symbol)} AND tf = ${sqlStr(tf)} AND adapter = ${sqlStr(adapter)}
    `);
  }

  /**
   * Append bars to the parquet partitions. Rows at or below `afterTs` are
   * dropped (idempotent incremental sync); the caller owns watermarking.
   */
  async ingestBars(rows: BarRow[], afterTs: number | null): Promise<IngestResult> {
    for (const r of rows) this.refuseExternal(r.symbol, "ingest bars into");
    const fresh = (afterTs === null ? rows : rows.filter((r) => r.ts > afterTs))
      .slice()
      .sort((a, b) => a.ts - b.ts)
      .filter((r, i, arr) => i === 0 || r.ts !== arr[i - 1]?.ts || r.symbol !== arr[i - 1]?.symbol);
    const skipped = rows.length - fresh.length;
    if (fresh.length === 0) return { inserted: 0, skipped, minTs: null, maxTs: null };

    const csvPath = join(this.tmpDir, `ingest-${randomUUID()}.csv`);
    const lines = ["symbol,tf,ts,open,high,low,close,volume,contract"];
    for (const r of fresh) {
      const contract = r.contract ?? "";
      lines.push(
        `${r.symbol},${r.tf},${r.ts},${r.open},${r.high},${r.low},${r.close},${r.volume},${contract}`,
      );
    }
    writeFileSync(csvPath, lines.join("\n"));
    try {
      await this.run(`
        COPY (
          SELECT symbol, tf, ts, open, high, low, close, volume,
                 CASE WHEN contract = '' THEN NULL ELSE contract END AS contract,
                 CAST(strftime(to_timestamp(ts / 1000.0), '%Y') AS INTEGER) AS year
          FROM read_csv(${sqlPath(csvPath)}, header = true, columns = {
            'symbol': 'VARCHAR', 'tf': 'VARCHAR', 'ts': 'BIGINT',
            'open': 'DOUBLE', 'high': 'DOUBLE', 'low': 'DOUBLE',
            'close': 'DOUBLE', 'volume': 'DOUBLE', 'contract': 'VARCHAR'
          })
        ) TO ${sqlPath(this.barsDir)}
        (FORMAT PARQUET, PARTITION_BY (symbol, tf, year), APPEND)
      `);
    } finally {
      rmSync(csvPath, { force: true });
    }
    await this.refreshBarsView();
    const first = fresh[0];
    const last = fresh[fresh.length - 1];
    return {
      inserted: fresh.length,
      skipped,
      minTs: first ? first.ts : null,
      maxTs: last ? last.ts : null,
    };
  }

  /** Drop all bars for a symbol (full re-sync path). */
  async dropBars(symbol: string, tf: string): Promise<void> {
    this.refuseExternal(symbol, "drop bars of");
    const symbolDir = join(this.barsDir, `symbol=${symbol}`, `tf=${tf}`);
    rmSync(symbolDir, { recursive: true, force: true });
    await this.refreshBarsView();
  }

  async refreshEventsView(): Promise<void> {
    // Check if legacy 'events' base table exists and migrate to events_static if so
    const tableCheck = await this.one(`
      SELECT count(*) as c FROM information_schema.tables 
      WHERE table_name = 'events' AND table_type = 'BASE TABLE'
    `);
    if (tableCheck && asInt(tableCheck.c) > 0) {
      await this.run(`
        CREATE TABLE IF NOT EXISTS events_static AS SELECT * FROM events;
        DROP TABLE events;
      `);
    } else {
      await this.run(`
        CREATE TABLE IF NOT EXISTS events_static (
          date DATE, event VARCHAR, detail VARCHAR
        );
      `);
    }

    let hasPrisma = false;
    if (this.economicDb && existsSync(this.economicDb)) {
      try {
        await this.run(`INSTALL sqlite; LOAD sqlite;`);
        await this.run(`ATTACH ${sqlPath(this.economicDb)} AS prisma (TYPE SQLITE, READ_ONLY);`);
        hasPrisma = true;
      } catch {
        const check = await this.one(`SELECT count(*) as c FROM prisma.EconomicEvent`).catch(() => null);
        if (check) hasPrisma = true;
      }
    }

    if (hasPrisma) {
      const sql = `
        CREATE OR REPLACE VIEW events AS
        WITH base AS (
          SELECT 
            CAST(timezone('America/New_York', to_timestamp(epoch(datetime) / 1000)) AS DATE) as date,
            strftime(timezone('America/New_York', to_timestamp(epoch(datetime) / 1000)), '%H:%M') as time_et,
            name,
            impact
          FROM prisma.EconomicEvent
          WHERE country IN ('USD', 'US', '')
        ),
        named_events AS (
          SELECT date, 'CPI' as event, name as detail FROM base 
          WHERE (name LIKE '%CPI%' OR name LIKE '%Consumer Price Index%') AND impact IN ('HIGH', 'MEDIUM')
          UNION ALL
          SELECT date, 'NFP' as event, name as detail FROM base 
          WHERE (name LIKE '%Non%Farm%Payrolls%' OR name LIKE '%Nonfarm Payrolls%' OR name = 'Unemployment Rate') AND impact IN ('HIGH', 'MEDIUM')
          UNION ALL
          SELECT date, 'FOMC' as event, name as detail FROM base 
          WHERE (name LIKE '%FOMC%' OR name LIKE '%Fed Interest Rate%' OR name LIKE '%Federal Reserve%') AND impact IN ('HIGH', 'MEDIUM')
          UNION ALL
          SELECT date, 'FED_MINUTES' as event, name as detail FROM base 
          WHERE name LIKE '%FOMC Minutes%' OR name LIKE '%Fed Minutes%'
          UNION ALL
          SELECT date, 'ISM' as event, name as detail FROM base 
          WHERE name LIKE '%ISM%' AND impact IN ('HIGH', 'MEDIUM')
          UNION ALL
          SELECT date, 'CONSUMER_CONFIDENCE' as event, name as detail FROM base 
          WHERE name LIKE '%Consumer Confidence%' AND impact IN ('HIGH', 'MEDIUM')
          UNION ALL
          SELECT date, 'CONSUMER_SENTIMENT' as event, name as detail FROM base 
          WHERE name LIKE '%Consumer Sentiment%' AND impact IN ('HIGH', 'MEDIUM')
          UNION ALL
          SELECT date, 'JOLTS' as event, name as detail FROM base 
          WHERE name LIKE '%JOLTS%' AND impact IN ('HIGH', 'MEDIUM')
          UNION ALL
          SELECT date, 'RETAIL_SALES' as event, name as detail FROM base 
          WHERE name LIKE '%Retail Sales%' AND impact IN ('HIGH', 'MEDIUM')
          UNION ALL
          SELECT date, 'PPI' as event, name as detail FROM base 
          WHERE (name LIKE '%PPI%' OR name LIKE '%Producer Price%') AND impact IN ('HIGH', 'MEDIUM')
          UNION ALL
          SELECT date, 'JOBLESS_CLAIMS' as event, name as detail FROM base 
          WHERE (name LIKE '%Jobless Claims%' OR name LIKE '%Initial Claims%') AND impact IN ('HIGH', 'MEDIUM')
          UNION ALL
          SELECT date, 'GDP' as event, name as detail FROM base 
          WHERE name LIKE '%GDP%' AND impact IN ('HIGH', 'MEDIUM')
          UNION ALL
          SELECT date, 'FLASH_PMI' as event, name as detail FROM base 
          WHERE name LIKE '%Flash%PMI%' OR name LIKE '%Manufacturing PMI%' OR name LIKE '%Services PMI%'
          UNION ALL
          SELECT date, 'CHICAGO_PMI' as event, name as detail FROM base 
          WHERE name LIKE '%Chicago PMI%'
        ),
        time_buckets AS (
          SELECT date, 'NEWS_0830' as event, name as detail FROM base 
          WHERE time_et = '08:30' AND impact IN ('HIGH', 'MEDIUM')
          UNION ALL
          SELECT date, 'NEWS_0945' as event, name as detail FROM base 
          WHERE time_et = '09:45' AND impact IN ('HIGH', 'MEDIUM')
          UNION ALL
          SELECT date, 'NEWS_1000' as event, name as detail FROM base 
          WHERE time_et = '10:00' AND impact IN ('HIGH', 'MEDIUM')
          UNION ALL
          SELECT date, 'NEWS_1400' as event, name as detail FROM base 
          WHERE time_et = '14:00' AND impact IN ('HIGH', 'MEDIUM')
          UNION ALL
          SELECT date, 'HIGH_IMPACT' as event, name as detail FROM base 
          WHERE impact = 'HIGH'
        )
        SELECT DISTINCT date, event, detail FROM (
          SELECT * FROM events_static
          UNION ALL
          SELECT * FROM named_events
          UNION ALL
          SELECT * FROM time_buckets
        );
      `;
      await this.run(sql);
    } else {
      await this.run(`CREATE OR REPLACE VIEW events AS SELECT * FROM events_static;`);
    }
  }

  async replaceEvents(entries: { date: string; event: string; detail?: string }[]): Promise<void> {
    await this.run("DELETE FROM events_static");
    for (let i = 0; i < entries.length; i += 500) {
      const chunk = entries.slice(i, i + 500);
      if (chunk.length === 0) break;
      const values = chunk
        .map(
          (e) =>
            `(DATE ${sqlStr(e.date)}, ${sqlStr(e.event)}, ${e.detail ? sqlStr(e.detail) : "NULL"})`,
        )
        .join(", ");
      await this.run(`INSERT INTO events_static (date, event, detail) VALUES ${values}`);
    }
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.run(
      `INSERT OR REPLACE INTO meta (key, value) VALUES (${sqlStr(key)}, ${sqlStr(value)})`,
    );
  }

  async getMeta(key: string): Promise<string | null> {
    const row = await this.one(`SELECT value FROM meta WHERE key = ${sqlStr(key)}`);
    return row ? asStr(row.value) : null;
  }

  /** Deterministic receipt: same store contents ⇒ same fingerprint. */
  async fingerprint(): Promise<string> {
    const bars = await this.one("SELECT count(*) AS c, coalesce(max(ts), 0) AS m FROM bars");
    let features = { c: 0, m: "" };
    try {
      const row = await this.one(
        "SELECT count(*) AS c, coalesce(CAST(max(trade_date) AS VARCHAR), '') AS m FROM session_features",
      );
      if (row) features = { c: asInt(row.c) ?? 0, m: asStr(row.m) ?? "" };
    } catch {
      // features not derived yet
    }
    const calendarVersion = (await this.getMeta("calendar_version")) ?? "";
    const h = createHash("sha256");
    h.update(String(asInt(bars?.c) ?? 0))
      .update(":")
      .update(String(asNum(bars?.m) ?? 0))
      .update(":")
      .update(String(features.c))
      .update(":")
      .update(features.m)
      .update(":")
      .update(calendarVersion)
      .update(":")
      .update(ENGINE_VERSION);
    return h.digest("hex").slice(0, 12);
  }

  async close(): Promise<void> {
    this.conn.closeSync();
    this.instance.closeSync();
  }
}
