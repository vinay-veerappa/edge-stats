/*
  Single-pass daily derivation for Daily Profiler (daily_context),
  5m Composite Price Paths (daily_paths_5m), and Candle Science v17.5 (cs_candles).

  Reuses the hoisted `_sym_bars` temp table (zero extra 1m Parquet scans) and
  delegates all causal classification to `crates/spine_wasm` (ADR-039).
*/
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { SymbolConfig } from "../config";
import type { Store } from "../store/store";
import { sqlPath, sqlStr } from "../util/sql";
import { asNum, asStr } from "../util/values";
import {
  CS_CANDLES_COLUMNS,
  DAILY_PATHS_5M_COLUMNS,
  dailyContextColumns,
  ensureDailyTables,
} from "./dailySchema";
import {
  LEVEL_KEYS,
  runCandleScienceBatch,
  runDailyProfilerBatch,
  type SpineCsCandleRow,
  type SpineDailyContextRow,
  type SpineDailyPath5mRow,
} from "./spineAdapter";

export interface DeriveDailyOptions {
  full?: boolean;
  /** Skip loading `_sym_bars` when the caller (`deriveFeatures`) already created it. */
  symBarsReady?: boolean;
  log?: (msg: string) => void;
}

export interface DeriveDailySummary {
  symbol: string;
  days: number;
  paths: number;
  csCandles: number;
}

function parseTfMinutes(tf: string): number {
  const m = /^(\d+)([mhd])$/.exec(tf);
  if (!m) return 1;
  const n = Number(m[1]);
  if (m[2] === "m") return n;
  if (m[2] === "h") return n * 60;
  return n * 1440;
}

/** Resolve `data/market/bars/1d/<ROOT>.parquet` sibling to an external 1m parquet root, if present. */
function resolveExternalDailyParquet(symbol: SymbolConfig, store: Store): string | null {
  if (symbol.external) {
    const baseDir = dirname(store.dataDir);
    const extRoot = resolve(baseDir, symbol.external.root);
    const candidate = resolve(dirname(extRoot), "1d", `${symbol.external.name}.parquet`);
    if (existsSync(candidate)) return candidate;
  }
  const opts = symbol.adapterOptions as Record<string, unknown> | undefined;
  const rawPath = typeof opts?.path === "string" ? opts.path : null;
  if (!rawPath) return null;
  const root = basename(rawPath);
  const parent = dirname(rawPath);
  const candidate = resolve(dirname(parent), "1d", `${root}.parquet`);
  return existsSync(candidate) ? candidate : null;
}

async function bulkInsertNdjson(
  store: Store,
  table: string,
  cols: { name: string; type: string }[],
  rows: Record<string, unknown>[],
  deleteSql: string,
): Promise<void> {
  await store.run(deleteSql);
  if (rows.length === 0) return;
  const ndjsonPath = join(store.tmpDir, `${table}-${randomUUID()}.ndjson`);
  const lines = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (const c of cols) obj[c.name] = row[c.name] ?? null;
    return JSON.stringify(obj);
  });
  writeFileSync(ndjsonPath, lines.join("\n"));
  try {
    const columnSpec = cols.map((c) => `'${c.name}': '${c.type}'`).join(", ");
    await store.run(`
      INSERT INTO ${table} BY NAME
      SELECT * FROM read_json(${sqlPath(ndjsonPath)}, format = 'newline_delimited',
                              columns = {${columnSpec}})
    `);
  } finally {
    try {
      unlinkSync(ndjsonPath);
    } catch {
      // best effort
    }
  }
}

function flattenDailyContextRow(symbol: string, d: SpineDailyContextRow): Record<string, unknown> {
  const row: Record<string, unknown> = {
    symbol,
    trade_date: d.trade_date,
    prev_trade_date: d.prev_trade_date,
    dow: d.dow,
    month: d.month,
    year: d.year,
    week_of_month: d.week_of_month,
    complete: d.complete,
    is_roll_day: d.is_roll_day,
    roll_adjacent: d.roll_adjacent,
    daily_open: d.daily_open,
    daily_high: d.daily_high,
    daily_low: d.daily_low,
    daily_close: d.daily_close,
    prev_close: d.prev_close,
    daily_high_bps: d.daily_high_bps,
    daily_low_bps: d.daily_low_bps,
    daily_range_bps: d.daily_range_bps,
    hod_min: d.hod_min,
    lod_min: d.lod_min,
    hod_session: d.hod_session,
    lod_session: d.lod_session,
    prev_asia_status: d.prev_asia_status,
    prev_asia_broken: d.prev_asia_broken,
    prev_london_status: d.prev_london_status,
    prev_london_broken: d.prev_london_broken,
    prev_ny1_status: d.prev_ny1_status,
    prev_ny1_broken: d.prev_ny1_broken,
    prev_ny2_status: d.prev_ny2_status,
    prev_ny2_broken: d.prev_ny2_broken,
    p12_high: d.p12_high,
    p12_low: d.p12_low,
    p12_mid: d.p12_mid,
    p12_scenario: d.p12_scenario,
    ny_p12_high: d.ny_p12_high,
    ny_p12_low: d.ny_p12_low,
    ny_p12_mid: d.ny_p12_mid,
    asia_london_aligned: d.asia_london_aligned,
    asia_london_pattern: d.asia_london_pattern,
    broken_broken: d.broken_broken,
    aln_pattern: d.aln_pattern,
    aln_bias: d.aln_bias,
    aln_chop: d.aln_chop,
    rth_gap: d.rth_gap,
  };

  const sessMap = {
    asia: d.asia,
    london: d.london,
    ny1: d.ny1,
    ny2: d.ny2,
  } as const;
  for (const [k, s] of Object.entries(sessMap)) {
    row[`${k}_box_open`] = s.box_open;
    row[`${k}_box_high`] = s.box_high;
    row[`${k}_box_low`] = s.box_low;
    row[`${k}_box_mid`] = s.box_mid;
    row[`${k}_box_range_bps`] = s.box_range_bps;
    row[`${k}_status`] = s.status;
    row[`${k}_dir`] = s.dir;
    row[`${k}_false_break`] = s.false_break;
    row[`${k}_status_at_min`] = s.status_at_min;
    row[`${k}_broken`] = s.broken;
    row[`${k}_broken_at_min`] = s.broken_at_min;
    row[`${k}_eval_high_bps`] = s.eval_high_bps;
    row[`${k}_eval_low_bps`] = s.eval_low_bps;
  }

  for (let i = 0; i < LEVEL_KEYS.length; i++) {
    const lv = LEVEL_KEYS[i]!;
    const t = d.touches[i];
    row[`touch_${lv}`] = t?.touched ?? false;
    row[`touch_${lv}_min`] = t?.first_min ?? null;
    row[`touch_${lv}_mask`] = t?.mask ?? 0;
  }
  return row;
}

function flattenPathRow(symbol: string, p: SpineDailyPath5mRow): Record<string, unknown> {
  return {
    symbol,
    trade_date: p.trade_date,
    bucket_idx: p.bucket_idx,
    high_bps_prev_close: p.high_bps_prev_close,
    low_bps_prev_close: p.low_bps_prev_close,
    close_bps_prev_close: p.close_bps_prev_close,
    high_bps_daily_open: p.high_bps_daily_open,
    low_bps_daily_open: p.low_bps_daily_open,
    close_bps_daily_open: p.close_bps_daily_open,
  };
}

function flattenCsRow(symbol: string, tf: string, c: SpineCsCandleRow): Record<string, unknown> {
  return {
    symbol,
    tf,
    bar_ts: c.bar_ts_s * 1000,
    trade_date: c.trade_date,
    dow: c.dow,
    month: c.month,
    year: c.year,
    complete: c.complete,
    roll_safe: c.roll_safe,
    c1_o: c.c1_o,
    c1_h: c.c1_h,
    c1_l: c.c1_l,
    c1_c: c.c1_c,
    c2_o: c.c2_o,
    c2_h: c.c2_h,
    c2_l: c.c2_l,
    c2_c: c.c2_c,
    c3_o: c.c3_o,
    c3_h: c.c3_h,
    c3_l: c.c3_l,
    c3_c: c.c3_c,
    sig_mask: c.sig_mask,
    c1_dir: c.c1_dir,
    c2_dir: c.c2_dir,
    c2_rel: c.c2_rel,
    c3o_zone: c.c3o_zone,
    c3_bull: c.c3_bull,
    c3h_gt_c2h: c.c3h_gt_c2h,
    c3l_lt_c2l: c.c3l_lt_c2l,
    c3c_gt_c2h: c.c3c_gt_c2h,
    c3c_gt_c2o: c.c3c_gt_c2o,
    c3c_gt_c2c: c.c3c_gt_c2c,
    c3c_gt_c2l: c.c3c_gt_c2l,
    c3h_lte_c2h: c.c3h_lte_c2h,
    c3l_gte_c2l: c.c3l_gte_c2l,
    dist_c3h_c2h_bps: c.dist_c3h_c2h_bps,
    dist_c3l_c2l_bps: c.dist_c3l_c2l_bps,
    dist_c3h_c2c_bps: c.dist_c3h_c2c_bps,
    dist_c3l_c2c_bps: c.dist_c3l_c2c_bps,
    dist_c3h_c2o_bps: c.dist_c3h_c2o_bps,
    dist_c3l_c2o_bps: c.dist_c3l_c2o_bps,
    dist_c3h_c2l_bps: c.dist_c3h_c2l_bps,
    dist_c3l_c2h_bps: c.dist_c3l_c2h_bps,
    mfe_long_c3o_bps: c.mfe_long_c3o_bps,
    mfe_short_c3o_bps: c.mfe_short_c3o_bps,
  };
}

function isoDateToDays(iso: string): number {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Math.floor(ms / 86_400_000);
}

/** Current Globex trading date in America/New_York (rolls at 18:00 ET). */
export function currentGlobexTradeDateIso(nowMs = Date.now()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
  const y = Number(parts.year);
  const mo = Number(parts.month);
  const d = Number(parts.day);
  const h = Number(parts.hour);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (h >= 18) dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

/**
 * Derive `daily_context`, `daily_paths_5m`, and `cs_candles` (`1d`, `4h`, `1h`, `15m`)
 * for one symbol using `crates/spine_wasm`.
 */
export async function deriveDailyForSymbol(
  store: Store,
  symbol: SymbolConfig,
  opts: DeriveDailyOptions = {},
): Promise<DeriveDailySummary> {
  const log = opts.log ?? (() => {});
  await ensureDailyTables(store);

  const sym = sqlStr(symbol.symbol);
  const tfMin = parseTfMinutes(symbol.tf);
  let ownsSymBars = false;

  if (!opts.symBarsReady) {
    const symSrc = store.symbolBars(symbol.symbol, symbol.tf);
    if (!symSrc) {
      return { symbol: symbol.symbol, days: 0, paths: 0, csCandles: 0 };
    }
    await store.run(`
      CREATE OR REPLACE TEMP TABLE _sym_bars AS
      SELECT ts, open, high, low, close, volume, contract
      FROM ${symSrc}
      ORDER BY ts
    `);
    ownsSymBars = true;
  }

  try {
    // Incremental watermark check: keep 35d lookback window for prev_trade_date, ny2_broken, and rolls.
    let minTsFilter = "";
    let cutoffDate: string | null = null;
    if (!opts.full) {
      const wm = await store.one(
        `SELECT CAST(max(trade_date) - INTERVAL 30 DAYS AS VARCHAR) AS cut,
                epoch_ms(max(trade_date) - INTERVAL 35 DAYS) AS read_from_ms
         FROM daily_context WHERE symbol = ${sym}`,
      );
      const cut = asStr(wm?.cut);
      const readFromMs = asNum(wm?.read_from_ms);
      if (cut && readFromMs !== null) {
        cutoffDate = cut;
        minTsFilter = `WHERE ts >= ${Math.floor(readFromMs)}`;
      }
    }

    // 1. Daily Profiler + 5m Paths (only when source TF divides 30m, e.g. 1m/5m/15m/30m;
    //    for coarser fixtures like 1h, still build daily summary + Candle Science gracefully)
    let daysOut: SpineDailyContextRow[] = [];
    let pathsOut: SpineDailyPath5mRow[] = [];

    if (tfMin === 1) {
      const barRows = await store.all(`
        SELECT ts, open, high, low, close, volume, contract
        FROM _sym_bars
        ${minTsFilter}
        ORDER BY ts
      `);
      const n = barRows.length;
      if (n > 0) {
        const tsOpenS = new Float64Array(n);
        const open = new Float64Array(n);
        const high = new Float64Array(n);
        const low = new Float64Array(n);
        const close = new Float64Array(n);
        const volume = new Float64Array(n);
        const isRoll = new Uint8Array(n);

        let prevContract: string | null = null;
        for (let i = 0; i < n; i++) {
          const r = barRows[i]!;
          tsOpenS[i] = Math.floor((asNum(r.ts) ?? 0) / 1000);
          open[i] = asNum(r.open) ?? 0;
          high[i] = asNum(r.high) ?? 0;
          low[i] = asNum(r.low) ?? 0;
          close[i] = asNum(r.close) ?? 0;
          volume[i] = asNum(r.volume) ?? 0;
          const c = asStr(r.contract);
          if (c && prevContract && c !== prevContract) {
            isRoll[i] = 1;
          }
          if (c) prevContract = c;
        }

        const batch = runDailyProfilerBatch(tsOpenS, open, high, low, close, volume, isRoll);
        daysOut = cutoffDate ? batch.days.filter((d) => d.trade_date >= cutoffDate!) : batch.days;
        pathsOut = cutoffDate
          ? batch.paths.filter((p) => p.trade_date >= cutoffDate!)
          : batch.paths;

        await bulkInsertNdjson(
          store,
          "daily_context",
          dailyContextColumns(),
          daysOut.map((d) => flattenDailyContextRow(symbol.symbol, d)),
          cutoffDate
            ? `DELETE FROM daily_context WHERE symbol = ${sym} AND trade_date >= DATE ${sqlStr(cutoffDate)}`
            : `DELETE FROM daily_context WHERE symbol = ${sym}`,
        );
        await bulkInsertNdjson(
          store,
          "daily_paths_5m",
          DAILY_PATHS_5M_COLUMNS,
          pathsOut.map((p) => flattenPathRow(symbol.symbol, p)),
          cutoffDate
            ? `DELETE FROM daily_paths_5m WHERE symbol = ${sym} AND trade_date >= DATE ${sqlStr(cutoffDate)}`
            : `DELETE FROM daily_paths_5m WHERE symbol = ${sym}`,
        );
      }
    }

    // 2. Candle Science v17.5 (`1d` primary from bars/1d/<ROOT>.parquet or daily_context fallback,
    //    plus MTF `4h`, `1h`, `15m` when source TF is fine enough)
    let totalCs = 0;
    const rollDateRows = await store.all(
      `SELECT CAST(trade_date AS VARCHAR) AS td FROM daily_context WHERE symbol = ${sym} AND is_roll_day = TRUE`,
    );
    const rollDates = new Set(rollDateRows.map((r) => asStr(r.td) ?? ""));

    // 2a. `1d` Candle Science
    const dailyParquet = resolveExternalDailyParquet(symbol, store);
    let dailyBars: {
      bar_ts_s: number;
      trade_date_days: number;
      open: number;
      high: number;
      low: number;
      close: number;
      is_roll: boolean;
    }[] = [];

    if (dailyParquet) {
      const rows = await store.all(`
        SELECT CAST(epoch(trading_date) AS BIGINT) AS ts_s,
               CAST(trading_date AS VARCHAR) AS td,
               open, high, low, close, contract
        FROM read_parquet(${sqlPath(dailyParquet)})
        ORDER BY trading_date
      `);
      let prevC: string | null = null;
      for (const r of rows) {
        const td = asStr(r.td);
        if (!td) continue;
        const c = asStr(r.contract);
        const rolled = rollDates.has(td) || Boolean(c && prevC && c !== prevC);
        if (c) prevC = c;
        dailyBars.push({
          bar_ts_s: asNum(r.ts_s) ?? 0,
          trade_date_days: isoDateToDays(td),
          open: asNum(r.open) ?? 0,
          high: asNum(r.high) ?? 0,
          low: asNum(r.low) ?? 0,
          close: asNum(r.close) ?? 0,
          is_roll: rolled,
        });
      }
    } else if (daysOut.length >= 3) {
      const allDays = await store.all(`
        SELECT CAST(trade_date AS VARCHAR) AS td,
               daily_open AS open, daily_high AS high, daily_low AS low, daily_close AS close,
               is_roll_day
        FROM daily_context
        WHERE symbol = ${sym} AND complete = TRUE
        ORDER BY trade_date
      `);
      for (const r of allDays) {
        const td = asStr(r.td);
        if (!td) continue;
        const days = isoDateToDays(td);
        dailyBars.push({
          bar_ts_s: days * 86_400,
          trade_date_days: days,
          open: asNum(r.open) ?? 0,
          high: asNum(r.high) ?? 0,
          low: asNum(r.low) ?? 0,
          close: asNum(r.close) ?? 0,
          is_roll: Boolean(r.is_roll_day),
        });
      }
    } else {
      // Fallback for non-1m fixtures (e.g. 1h CSV test fixtures): aggregate _sym_bars by UTC day
      const agg = await store.all(`
        SELECT CAST(strftime(to_timestamp(ts / 1000), '%Y-%m-%d') AS VARCHAR) AS td,
               min(ts) / 1000 AS ts_s,
               arg_min(open, ts) AS open,
               max(high) AS high,
               min(low) AS low,
               arg_max(close, ts) AS close,
               count(DISTINCT contract) > 1 AS multi_c
        FROM _sym_bars
        GROUP BY 1
        ORDER BY 1
      `);
      for (const r of agg) {
        const td = asStr(r.td);
        if (!td) continue;
        dailyBars.push({
          bar_ts_s: Math.floor(asNum(r.ts_s) ?? 0),
          trade_date_days: isoDateToDays(td),
          open: asNum(r.open) ?? 0,
          high: asNum(r.high) ?? 0,
          low: asNum(r.low) ?? 0,
          close: asNum(r.close) ?? 0,
          is_roll: Boolean(r.multi_c),
        });
      }
    }

    if (dailyBars.length >= 3) {
      const m = dailyBars.length;
      const barTsS = new Float64Array(m);
      const tdDays = new Int32Array(m);
      const o = new Float64Array(m);
      const h = new Float64Array(m);
      const l = new Float64Array(m);
      const c = new Float64Array(m);
      const roll = new Uint8Array(m);
      for (let i = 0; i < m; i++) {
        const b = dailyBars[i]!;
        barTsS[i] = b.bar_ts_s;
        tdDays[i] = b.trade_date_days;
        o[i] = b.open;
        h[i] = b.high;
        l[i] = b.low;
        c[i] = b.close;
        roll[i] = b.is_roll ? 1 : 0;
      }
      const cs1d = runCandleScienceBatch(barTsS, tdDays, o, h, l, c, roll);
      const todayGlobex = currentGlobexTradeDateIso();
      for (const row of cs1d) {
        if (row.trade_date >= todayGlobex) {
          row.complete = false;
        }
      }
      await bulkInsertNdjson(
        store,
        "cs_candles",
        CS_CANDLES_COLUMNS,
        cs1d.map((row) => flattenCsRow(symbol.symbol, "1d", row)),
        `DELETE FROM cs_candles WHERE symbol = ${sym} AND tf = '1d'`,
      );
      totalCs += cs1d.length;
    }

    // 2b. MTF Candle Science (`4h`, `1h`, `15m`) when 1m source bars are available
    if (tfMin === 1) {
      const nowMs = Date.now();
      const mtfSpecs: { tf: string; interval: string; intervalMs: number }[] = [
        { tf: "4h", interval: "4 hours", intervalMs: 4 * 3600_000 },
        { tf: "1h", interval: "1 hour", intervalMs: 3600_000 },
        { tf: "15m", interval: "15 minutes", intervalMs: 15 * 60_000 },
      ];
      for (const spec of mtfSpecs) {
        const agg = await store.all(`
          SELECT CAST(epoch(time_bucket(INTERVAL '${spec.interval}', to_timestamp(ts / 1000))) AS BIGINT) AS ts_s,
                 CAST(strftime(time_bucket(INTERVAL '${spec.interval}', to_timestamp(ts / 1000)) + INTERVAL 6 HOURS, '%Y-%m-%d') AS VARCHAR) AS td,
                 max(ts) AS last_ts_ms,
                 arg_min(open, ts) AS open,
                 max(high) AS high,
                 min(low) AS low,
                 arg_max(close, ts) AS close,
                 count(DISTINCT contract) > 1 AS multi_c
          FROM _sym_bars
          GROUP BY 1, 2
          ORDER BY 1
        `);
        if (agg.length < 3) continue;
        const m = agg.length;
        const barTsS = new Float64Array(m);
        const tdDays = new Int32Array(m);
        const o = new Float64Array(m);
        const h = new Float64Array(m);
        const l = new Float64Array(m);
        const c = new Float64Array(m);
        const roll = new Uint8Array(m);
        const completeFlags: boolean[] = new Array(m);
        for (let i = 0; i < m; i++) {
          const r = agg[i]!;
          const td = asStr(r.td) ?? "1970-01-01";
          const tsS = asNum(r.ts_s) ?? 0;
          const lastTsMs = asNum(r.last_ts_ms) ?? 0;
          const bucketEndMs = tsS * 1000 + spec.intervalMs;
          // Final bucket is complete only if the bucket interval has fully elapsed and closed
          completeFlags[i] =
            i + 1 < m || (bucketEndMs <= nowMs && lastTsMs >= bucketEndMs - 60_000);
          barTsS[i] = tsS;
          tdDays[i] = isoDateToDays(td);
          o[i] = asNum(r.open) ?? 0;
          h[i] = asNum(r.high) ?? 0;
          l[i] = asNum(r.low) ?? 0;
          c[i] = asNum(r.close) ?? 0;
          roll[i] = Boolean(r.multi_c) || rollDates.has(td) ? 1 : 0;
        }
        const csMtf = runCandleScienceBatch(barTsS, tdDays, o, h, l, c, roll);
        for (let i = 0; i < csMtf.length; i++) {
          csMtf[i]!.complete = completeFlags[i + 2] ?? true;
        }
        await bulkInsertNdjson(
          store,
          "cs_candles",
          CS_CANDLES_COLUMNS,
          csMtf.map((row) => flattenCsRow(symbol.symbol, spec.tf, row)),
          `DELETE FROM cs_candles WHERE symbol = ${sym} AND tf = ${sqlStr(spec.tf)}`,
        );
        totalCs += csMtf.length;
      }
    }

    log(
      `derived daily_context=${daysOut.length} days, paths=${pathsOut.length}, cs_candles=${totalCs} for ${symbol.symbol}`,
    );
    return {
      symbol: symbol.symbol,
      days: daysOut.length,
      paths: pathsOut.length,
      csCandles: totalCs,
    };
  } finally {
    if (ownsSymBars) {
      await store.run("DROP TABLE IF EXISTS _sym_bars");
    }
  }
}
