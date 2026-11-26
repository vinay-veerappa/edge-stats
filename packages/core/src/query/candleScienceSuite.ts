/*
  Candle Science v17.5 multi-outcome & MFE/MAE percentile suite.
  Computes C3 probabilities (Wilson CIs + stability splits) and all 8 breakout +
  2 contained C2C-normalized excursion distributions (P10, P25, P30, P50, P70, P75, P90, P95).
*/
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { EdgeStatsConfig, SymbolConfig } from "../config";
import { defaultSessionKey, findSymbol } from "../config";
import { ensureDailyTables } from "../features/dailySchema";
import { currentGlobexTradeDateIso } from "../features/deriveDaily";
import {
  CS_DIM_BIT,
  CS_DIM_NAMES,
  classifyCandleScienceLive,
  type CsDimName,
} from "../features/spineAdapter";
import {
  applyGuards,
  distributionFromQuantiles,
  stabilitySplit,
  wilson,
  type DistributionSummary,
  type GuardResult,
  type StabilitySplit,
} from "../stats/stats";
import type { Store } from "../store/store";
import { sqlDate, sqlPath, sqlStr } from "../util/sql";
import { asInt, asNum, asStr, round } from "../util/values";
import { compileConditionExpr } from "./compile";
import { compileCtxFor, DISCLAIMER } from "./execute";
import { parseConditionDsl } from "./parser";

export interface CandleScienceSuiteRequest {
  symbol: string;
  tf?: "1d" | "4h" | "1h" | "15m";
  /** Partial map of the 16 structural dimensions to constrain (undefined = unconstrained). */
  dims?: Partial<Record<CsDimName, boolean>>;
  /** Optional cross-conditioning DSL WHERE expression (e.g. "brokenBroken AND NOT eventDay('FOMC')"). */
  whereDsl?: string;
  since?: string;
  until?: string;
}

export interface CsOutcomeStat {
  key: string;
  label: string;
  falseLabel: string;
  n: number;
  k: number;
  estimate: number | null;
  ci95: [number, number] | null;
  falseK: number;
  falseEstimate: number | null;
  falseCi95: [number, number] | null;
  lowSample: boolean;
  stability: StabilitySplit | null;
}

export interface CsScenarioCandle {
  direction: "bull" | "bear";
  n: number;
  rate: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  bodyBps: number | null;
  upperWickBps: number | null;
  lowerWickBps: number | null;
  rangeBps: number | null;
}

export interface CsProjectionLevels {
  anchorPrice: number;
  c3Open: number;
  c3HighMedPrice: number | null;
  c3LowMedPrice: number | null;
  hiBreakoutP30Price: number | null;
  hiBreakoutP50Price: number | null;
  hiBreakoutP70Price: number | null;
  loBreakoutP30Price: number | null;
  loBreakoutP50Price: number | null;
  loBreakoutP70Price: number | null;
  hiBreakoutP30Bps: number | null;
  hiBreakoutP50Bps: number | null;
  hiBreakoutP70Bps: number | null;
  loBreakoutP30Bps: number | null;
  loBreakoutP50Bps: number | null;
  loBreakoutP70Bps: number | null;
  mfeLongMedBps: number | null;
  mfeShortMedBps: number | null;
  bullCandle: CsScenarioCandle;
  bearCandle: CsScenarioCandle;
}

export interface CsExcursionRow {
  key: string;
  label: string;
  kind: "breakout" | "contained" | "reference";
  distribution: DistributionSummary | null;
}

export interface CsLatestContext {
  tradeDate: string;
  c1: { open: number; high: number; low: number; close: number };
  c2: { open: number; high: number; low: number; close: number };
  c3Open: number;
  c2CloseSource?: "cme_settlement" | "1600_proxy" | "bar_close";
  sigMask: number;
  dims: Record<CsDimName, boolean>;
}

export interface CandleScienceSuiteResult {
  symbol: string;
  tf: string;
  n: number;
  guards: GuardResult;
  activeMask: number;
  expectedMask: number;
  outcomes: CsOutcomeStat[];
  excursions: CsExcursionRow[];
  scenarios: {
    bull: CsScenarioCandle;
    bear: CsScenarioCandle;
  };
  projection: CsProjectionLevels | null;
  perYear: { year: number; n: number; bullK: number; bullRate: number | null }[];
  latest: CsLatestContext | null;
  matchedDates: string[];
  disclaimer: string;
}

function buildBitMasks(dims?: Partial<Record<CsDimName, boolean>>): {
  activeMask: number;
  expectedMask: number;
} {
  let activeMask = 0;
  let expectedMask = 0;
  if (!dims) return { activeMask, expectedMask };
  for (const [k, val] of Object.entries(dims)) {
    if (typeof val !== "boolean") continue;
    const bitIdx = CS_DIM_BIT[k as CsDimName];
    if (bitIdx === undefined) continue;
    const bit = 1 << bitIdx;
    activeMask |= bit;
    if (val) expectedMask |= bit;
  }
  return { activeMask, expectedMask };
}

function parseDist(
  row: Record<string, unknown> | null | undefined,
  prefix: string,
): DistributionSummary | null {
  const cnt = asInt(row?.[`${prefix}_n`]) ?? 0;
  const mean = asNum(row?.[`${prefix}_mean`]);
  const qStr = asStr(row?.[`${prefix}_q`]);
  if (cnt <= 0 || mean === null || !qStr) return null;
  const parsed = JSON.parse(qStr) as (number | null)[];
  if (!parsed.every((x): x is number => typeof x === "number")) return null;
  return distributionFromQuantiles(cnt, round(mean), parsed.map((x) => round(x)), "bps");
}

export async function runCandleScienceSuite(
  store: Store,
  config: EdgeStatsConfig,
  req: CandleScienceSuiteRequest,
): Promise<CandleScienceSuiteResult> {
  await ensureDailyTables(store);
  const symCfg = findSymbol(config, req.symbol);
  const defaultKey = defaultSessionKey(symCfg);
  const tf = req.tf ?? "1d";
  const { activeMask, expectedMask } = buildBitMasks(req.dims);

  const fromClause = `
    FROM cs_candles cs
    LEFT JOIN daily_context d ON d.symbol = cs.symbol AND d.trade_date = cs.trade_date
    LEFT JOIN session_features f ON f.symbol = cs.symbol AND f.trade_date = cs.trade_date AND f.session_key = ${sqlStr(defaultKey)}
  `;
  const conds: string[] = [
    `cs.symbol = ${sqlStr(symCfg.symbol)}`,
    `cs.tf = ${sqlStr(tf)}`,
    "cs.complete = TRUE",
    "cs.roll_safe = TRUE",
  ];
  // Never include the current forming Globex trading day in 1d historical stats
  if (tf === "1d") {
    conds.push(`cs.trade_date < DATE ${sqlStr(currentGlobexTradeDateIso())}`);
  }
  if (activeMask !== 0) {
    conds.push(`(cs.sig_mask & ${activeMask}) = ${expectedMask}`);
  }
  if (req.since) conds.push(`cs.trade_date >= ${sqlDate(req.since)}`);
  if (req.until) conds.push(`cs.trade_date <= ${sqlDate(req.until)}`);
  if (req.whereDsl && req.whereDsl.trim().length > 0) {
    const expr = parseConditionDsl(req.whereDsl);
    const compiledSql = compileConditionExpr(expr, compileCtxFor(symCfg));
    conds.push(`(${compiledSql})`);
  }
  const whereClause = conds.join(" AND ");

  const cte = `
    WITH matched AS (
      SELECT cs.*,
             row_number() OVER (ORDER BY cs.bar_ts) AS rn,
             count(*) OVER () AS total
      ${fromClause}
      WHERE ${whereClause}
    )
  `;

  const outcomeSpecs: { key: string; label: string; falseLabel: string; expr: string }[] = [
    { key: "c3_bull", label: "C3 Bullish (C3C > C3O)", falseLabel: "C3 Bearish (C3C <= C3O)", expr: "c3_bull" },
    { key: "c3h_gt_c2h", label: "Breaks C2 High (C3H > C2H)", falseLabel: "High Contained (C3H <= C2H)", expr: "c3h_gt_c2h" },
    { key: "c3l_lt_c2l", label: "Breaks C2 Low (C3L < C2L)", falseLabel: "Low Contained (C3L >= C2L)", expr: "c3l_lt_c2l" },
    { key: "c3c_gt_c2h", label: "Closes > C2 High", falseLabel: "Closes <= C2 High", expr: "c3c_gt_c2h" },
    { key: "c3c_gt_c2o", label: "Closes > C2 Open", falseLabel: "Closes <= C2 Open", expr: "c3c_gt_c2o" },
    { key: "c3c_gt_c2c", label: "Closes > C2 Close", falseLabel: "Closes <= C2 Close", expr: "c3c_gt_c2c" },
    { key: "c3c_gt_c2l", label: "Closes > C2 Low", falseLabel: "Closes <= C2 Low", expr: "c3c_gt_c2l" },
  ];

  const outcomeSelects = outcomeSpecs
    .map(
      (o) => `
      coalesce(sum(CASE WHEN ${o.expr} THEN 1 ELSE 0 END), 0)::INT AS k_${o.key},
      coalesce(sum(CASE WHEN rn * 2 <= total AND ${o.expr} THEN 1 ELSE 0 END), 0)::INT AS k1_${o.key},
      coalesce(sum(CASE WHEN rn * 2 > total AND ${o.expr} THEN 1 ELSE 0 END), 0)::INT AS k2_${o.key}
    `,
    )
    .join(",\n");

  const aggRow = await store.one(`
    ${cte}
    SELECT
      count(*)::INT AS n,
      coalesce(sum(CASE WHEN rn * 2 <= total THEN 1 ELSE 0 END), 0)::INT AS n1,
      coalesce(sum(CASE WHEN rn * 2 > total THEN 1 ELSE 0 END), 0)::INT AS n2,
      ${outcomeSelects}
    FROM matched
  `);

  const n = asInt(aggRow?.n) ?? 0;
  const n1 = asInt(aggRow?.n1) ?? 0;
  const n2 = asInt(aggRow?.n2) ?? 0;
  const guards = applyGuards(n, config.minN);

  const outcomes: CsOutcomeStat[] = outcomeSpecs.map((o) => {
    const k = asInt(aggRow?.[`k_${o.key}`]) ?? 0;
    const fk = Math.max(0, n - k);
    const k1 = asInt(aggRow?.[`k1_${o.key}`]) ?? 0;
    const k2 = asInt(aggRow?.[`k2_${o.key}`]) ?? 0;
    const w = wilson(k, n);
    const fw = wilson(fk, n);
    return {
      key: o.key,
      label: o.label,
      falseLabel: o.falseLabel,
      n,
      k,
      estimate: w ? round(w.estimate) : null,
      ci95: w ? [round(w.lo), round(w.hi)] : null,
      falseK: fk,
      falseEstimate: fw ? round(fw.estimate) : null,
      falseCi95: fw ? [round(fw.lo), round(fw.hi)] : null,
      lowSample: n < config.minN.warn,
      stability: n > 0 ? stabilitySplit(n1, k1, n2, k2) : null,
    };
  });

  // 8 directional breakout/reference + 2 contained excursion distributions (in bps of C2C)
  const excursionSpecs: {
    key: string;
    label: string;
    kind: "breakout" | "contained" | "reference";
    expr: string;
  }[] = [
    {
      key: "brk_hi",
      label: "High Breakout (C3H - C2H | C3H > C2H)",
      kind: "breakout",
      expr: "CASE WHEN c3h_gt_c2h THEN dist_c3h_c2h_bps ELSE NULL END",
    },
    {
      key: "brk_lo",
      label: "Low Breakout (|C3L - C2L| | C3L < C2L)",
      kind: "breakout",
      expr: "CASE WHEN c3l_lt_c2l THEN abs(dist_c3l_c2l_bps) ELSE NULL END",
    },
    {
      key: "cnt_hi",
      label: "Contained High Distance (C2H - C3H | C3H <= C2H)",
      kind: "contained",
      expr: "CASE WHEN c3h_lte_c2h THEN abs(dist_c3h_c2h_bps) ELSE NULL END",
    },
    {
      key: "cnt_lo",
      label: "Contained Low Distance (C3L - C2L | C3L >= C2L)",
      kind: "contained",
      expr: "CASE WHEN c3l_gte_c2l THEN abs(dist_c3l_c2l_bps) ELSE NULL END",
    },
    {
      key: "hi_c2c",
      label: "Upside vs C2 Close (C3H - C2C)",
      kind: "reference",
      expr: "dist_c3h_c2c_bps",
    },
    {
      key: "lo_c2c",
      label: "Downside vs C2 Close (C3L - C2C)",
      kind: "reference",
      expr: "dist_c3l_c2c_bps",
    },
    {
      key: "hi_c2o",
      label: "Upside vs C2 Open (C3H - C2O)",
      kind: "reference",
      expr: "dist_c3h_c2o_bps",
    },
    {
      key: "lo_c2o",
      label: "Downside vs C2 Open (C3L - C2O)",
      kind: "reference",
      expr: "dist_c3l_c2o_bps",
    },
    {
      key: "mfe_l",
      label: "C3 Open -> High MFE (bps)",
      kind: "reference",
      expr: "mfe_long_c3o_bps",
    },
    {
      key: "mfe_s",
      label: "C3 Open -> Low MFE (bps)",
      kind: "reference",
      expr: "mfe_short_c3o_bps",
    },
  ];

  const qList = "[0.0, 0.10, 0.25, 0.30, 0.50, 0.70, 0.75, 0.90, 0.95, 1.0]";
  const excSelects = excursionSpecs
    .map(
      (e) => `
      count(${e.expr})::INT AS ${e.key}_n,
      avg(${e.expr}) AS ${e.key}_mean,
      to_json(quantile_cont(${e.expr}, ${qList})) AS ${e.key}_q
    `,
    )
    .join(",\n");
  const excRow = await store.one(`${cte} SELECT ${excSelects} FROM matched`);
  const excursions: CsExcursionRow[] = excursionSpecs.map((e) => ({
    key: e.key,
    label: e.label,
    kind: e.kind,
    distribution: parseDist(excRow, e.key),
  }));

  // Empirical median candle geometry (body + upper/lower wicks in bps of C2C) for BOTH Bull (True) and Bear (False) C3 outcomes
  const shapeRow = await store.one(`
    ${cte}
    SELECT
      count(*) FILTER (WHERE c3_bull AND c2_c > 0)::INT AS bull_n,
      median(((c3_c - c3_o) / c2_c) * 10000.0) FILTER (WHERE c3_bull AND c2_c > 0) AS bull_body,
      median(((c3_h - c3_c) / c2_c) * 10000.0) FILTER (WHERE c3_bull AND c2_c > 0) AS bull_uw,
      median(((c3_o - c3_l) / c2_c) * 10000.0) FILTER (WHERE c3_bull AND c2_c > 0) AS bull_lw,
      median(((c3_h - c3_l) / c2_c) * 10000.0) FILTER (WHERE c3_bull AND c2_c > 0) AS bull_rng,
      count(*) FILTER (WHERE NOT c3_bull AND c2_c > 0)::INT AS bear_n,
      median(((c3_o - c3_c) / c2_c) * 10000.0) FILTER (WHERE NOT c3_bull AND c2_c > 0) AS bear_body,
      median(((c3_h - c3_o) / c2_c) * 10000.0) FILTER (WHERE NOT c3_bull AND c2_c > 0) AS bear_uw,
      median(((c3_c - c3_l) / c2_c) * 10000.0) FILTER (WHERE NOT c3_bull AND c2_c > 0) AS bear_lw,
      median(((c3_h - c3_l) / c2_c) * 10000.0) FILTER (WHERE NOT c3_bull AND c2_c > 0) AS bear_rng
    FROM matched
  `);

  const perYearRows = await store.all(`
    ${cte}
    SELECT year, count(*)::INT AS n,
           coalesce(sum(CASE WHEN c3_bull THEN 1 ELSE 0 END), 0)::INT AS bk
    FROM matched
    GROUP BY year
    ORDER BY year
  `);
  const perYear = perYearRows.map((r) => {
    const yn = asInt(r.n) ?? 0;
    const bk = asInt(r.bk) ?? 0;
    return {
      year: asInt(r.year) ?? 0,
      n: yn,
      bullK: bk,
      bullRate: yn > 0 ? round(bk / yn) : null,
    };
  });

function resolveLiveParquet(symCfg: SymbolConfig, store: Store): string | null {
  const name = symCfg.external?.name ?? symCfg.symbol.replace(/\d+$/, "");
  const repoRoot = resolve(dirname(store.dataDir), "..", "..");
  const p = resolve(repoRoot, "data", "live", `live_storage_-${name}.parquet`);
  return existsSync(p) ? p : null;
}

function resolveDaily1dParquet(symCfg: SymbolConfig, store: Store): string | null {
  if (symCfg.external) {
    const baseDir = dirname(store.dataDir);
    const extRoot = resolve(baseDir, symCfg.external.root);
    const candidate = resolve(dirname(extRoot), "1d", `${symCfg.external.name}.parquet`);
    if (existsSync(candidate)) return candidate;
  }
  const name = symCfg.external?.name ?? symCfg.symbol.replace(/\d+$/, "");
  const repoRoot = resolve(dirname(store.dataDir), "..", "..");
  const candidate = resolve(repoRoot, "data", "market", "bars", "1d", `${name}.parquet`);
  return existsSync(candidate) ? candidate : null;
}

async function detectLiveCandleContext(
  store: Store,
  symCfg: SymbolConfig,
  tf: "1d" | "4h" | "1h" | "15m",
): Promise<CsLatestContext | null> {
  const livePath = resolveLiveParquet(symCfg, store);
  const daily1dPath = tf === "1d" ? resolveDaily1dParquet(symCfg, store) : null;

  if (livePath) {
    try {
      if (tf === "1d") {
        // Merge official CME settlement bars from bars/1d/<ROOT>.parquet with newer days from live_storage.
        // Whenever a date exists in bars/1d, its official CME settlement OHLC wins over the 1m proxy.
        const settleSql = daily1dPath
          ? `SELECT CAST(trading_date AS VARCHAR) AS td, open AS o, high AS h, low AS l, close AS c, 'cme_settlement' AS src
             FROM read_parquet(${sqlPath(daily1dPath)})`
          : `SELECT CAST(NULL AS VARCHAR) AS td, CAST(NULL AS DOUBLE) AS o, CAST(NULL AS DOUBLE) AS h,
                    CAST(NULL AS DOUBLE) AS l, CAST(NULL AS DOUBLE) AS c, 'cme_settlement' AS src WHERE FALSE`;
        const rows = await store.all(`
          WITH live_days AS (
            SELECT
              CAST(strftime(to_timestamp(time / 1000) AT TIME ZONE 'America/New_York' + INTERVAL 6 HOURS, '%Y-%m-%d') AS VARCHAR) AS td,
              arg_min(open, time) AS o,
              max(high) AS h,
              min(low) AS l,
              coalesce(
                arg_max(close, time) FILTER (WHERE hour(to_timestamp(time / 1000) AT TIME ZONE 'America/New_York') >= 8
                                               AND hour(to_timestamp(time / 1000) AT TIME ZONE 'America/New_York') < 16),
                arg_max(close, time)
              ) AS c,
              '1600_proxy' AS src
            FROM read_parquet(${sqlPath(livePath)})
            GROUP BY 1
          ),
          settle_days AS (${settleSql}),
          merged AS (
            SELECT td, o, h, l, c, src FROM settle_days
            UNION ALL
            SELECT l.td, l.o, l.h, l.l, l.c, l.src
            FROM live_days l
            WHERE NOT EXISTS (SELECT 1 FROM settle_days s WHERE s.td = l.td)
          )
          SELECT td AS label, o, h, l, c, src
          FROM merged
          ORDER BY td DESC
          LIMIT 3
        `);
        if (rows.length === 3) {
          const c3 = rows[0]!;
          const c2 = rows[1]!;
          const c1 = rows[2]!;
          const c1Obj = {
            open: asNum(c1.o) ?? 0,
            high: asNum(c1.h) ?? 0,
            low: asNum(c1.l) ?? 0,
            close: asNum(c1.c) ?? 0,
          };
          const c2Obj = {
            open: asNum(c2.o) ?? 0,
            high: asNum(c2.h) ?? 0,
            low: asNum(c2.l) ?? 0,
            close: asNum(c2.c) ?? 0,
          };
          const c3Open = asNum(c3.o) ?? 0;
          const sig = classifyCandleScienceLive(c1Obj, c2Obj, c3Open);
          const dims = Object.fromEntries(
            CS_DIM_NAMES.map((name, i) => [name, sig.dims[i] ?? false]),
          ) as Record<CsDimName, boolean>;
          const src = asStr(c2.src) === "cme_settlement" ? "cme_settlement" : "1600_proxy";
          return {
            tradeDate: `${asStr(c3.label) ?? ""} (live)`,
            c1: c1Obj,
            c2: c2Obj,
            c3Open,
            c2CloseSource: src,
            sigMask: sig.sig_mask,
            dims,
          };
        }
      } else {
        const rows = await store.all(`
          WITH b AS (
            SELECT *,
              time_bucket(INTERVAL '${tf === "4h" ? "4 hours" : tf === "1h" ? "1 hour" : "15 minutes"}', to_timestamp(time / 1000)) AS bucket
            FROM read_parquet(${sqlPath(livePath)})
          )
          SELECT CAST(strftime(bucket AT TIME ZONE 'America/New_York', '%Y-%m-%d %H:%M') AS VARCHAR) AS label,
                 arg_min(open, time) AS o,
                 max(high) AS h,
                 min(low) AS l,
                 arg_max(close, time) AS c
          FROM b
          GROUP BY bucket
          ORDER BY bucket DESC
          LIMIT 3
        `);
        if (rows.length === 3) {
          const c3 = rows[0]!;
          const c2 = rows[1]!;
          const c1 = rows[2]!;
          const c1Obj = {
            open: asNum(c1.o) ?? 0,
            high: asNum(c1.h) ?? 0,
            low: asNum(c1.l) ?? 0,
            close: asNum(c1.c) ?? 0,
          };
          const c2Obj = {
            open: asNum(c2.o) ?? 0,
            high: asNum(c2.h) ?? 0,
            low: asNum(c2.l) ?? 0,
            close: asNum(c2.c) ?? 0,
          };
          const c3Open = asNum(c3.o) ?? 0;
          const sig = classifyCandleScienceLive(c1Obj, c2Obj, c3Open);
          const dims = Object.fromEntries(
            CS_DIM_NAMES.map((name, i) => [name, sig.dims[i] ?? false]),
          ) as Record<CsDimName, boolean>;
          return {
            tradeDate: `${asStr(c3.label) ?? ""} (live)`,
            c1: c1Obj,
            c2: c2Obj,
            c3Open,
            c2CloseSource: "bar_close",
            sigMask: sig.sig_mask,
            dims,
          };
        }
      }
    } catch {
      // fall through to stored cs_candles latest row
    }
  }

  const latestRow = await store.one(`
    SELECT CAST(trade_date AS VARCHAR) AS td,
           c1_o, c1_h, c1_l, c1_c, c2_o, c2_h, c2_l, c2_c, c3_o, sig_mask
    FROM cs_candles
    WHERE symbol = ${sqlStr(symCfg.symbol)} AND tf = ${sqlStr(tf)}
    ORDER BY bar_ts DESC
    LIMIT 1
  `);
  if (!latestRow) return null;
  const mask = asInt(latestRow.sig_mask) ?? 0;
  const dims = Object.fromEntries(
    CS_DIM_NAMES.map((name, i) => [name, (mask & (1 << i)) !== 0]),
  ) as Record<CsDimName, boolean>;
  return {
    tradeDate: asStr(latestRow.td) ?? "",
    c1: {
      open: asNum(latestRow.c1_o) ?? 0,
      high: asNum(latestRow.c1_h) ?? 0,
      low: asNum(latestRow.c1_l) ?? 0,
      close: asNum(latestRow.c1_c) ?? 0,
    },
    c2: {
      open: asNum(latestRow.c2_o) ?? 0,
      high: asNum(latestRow.c2_h) ?? 0,
      low: asNum(latestRow.c2_l) ?? 0,
      close: asNum(latestRow.c2_c) ?? 0,
    },
    c3Open: asNum(latestRow.c3_o) ?? 0,
    sigMask: mask,
    dims,
  };
}

  const latest = await detectLiveCandleContext(store, symCfg, tf);

  const bullOut = outcomes.find((o) => o.key === "c3_bull");
  const buildScenario = (dir: "bull" | "bear"): CsScenarioCandle => {
    const p = dir === "bull" ? "bull" : "bear";
    const sn = asInt(shapeRow?.[`${p}_n`]) ?? 0;
    const body = asNum(shapeRow?.[`${p}_body`]);
    const uw = asNum(shapeRow?.[`${p}_uw`]);
    const lw = asNum(shapeRow?.[`${p}_lw`]);
    const rng = asNum(shapeRow?.[`${p}_rng`]);
    const anchor = latest && latest.c2.close > 0 ? latest.c2.close : null;
    const o = latest ? latest.c3Open : null;
    let c: number | null = null;
    let h: number | null = null;
    let l: number | null = null;
    if (anchor !== null && o !== null && body !== null && uw !== null && lw !== null) {
      if (dir === "bull") {
        c = round(o + anchor * (body / 10000), 2);
        h = round(c + anchor * (Math.max(0, uw) / 10000), 2);
        l = round(o - anchor * (Math.max(0, lw) / 10000), 2);
      } else {
        c = round(o - anchor * (body / 10000), 2);
        h = round(o + anchor * (Math.max(0, uw) / 10000), 2);
        l = round(c - anchor * (Math.max(0, lw) / 10000), 2);
      }
    }
    return {
      direction: dir,
      n: sn,
      rate: dir === "bull" ? (bullOut?.estimate ?? null) : (bullOut?.falseEstimate ?? null),
      open: o !== null ? round(o, 2) : null,
      high: h,
      low: l,
      close: c,
      bodyBps: body !== null ? round(body) : null,
      upperWickBps: uw !== null ? round(Math.max(0, uw)) : null,
      lowerWickBps: lw !== null ? round(Math.max(0, lw)) : null,
      rangeBps: rng !== null ? round(rng) : null,
    };
  };

  const scenarios = {
    bull: buildScenario("bull"),
    bear: buildScenario("bear"),
  };

  let projection: CsProjectionLevels | null = null;
  if (latest && latest.c2.close > 0) {
    const anchor = latest.c2.close;
    const byKey = new Map(excursions.map((e) => [e.key, e.distribution]));
    const brkHi = byKey.get("brk_hi");
    const brkLo = byKey.get("brk_lo");
    const hiC2c = byKey.get("hi_c2c");
    const loC2c = byKey.get("lo_c2c");
    const mfeL = byKey.get("mfe_l");
    const mfeS = byKey.get("mfe_s");
    const px = (base: number, bps: number | undefined, sign: 1 | -1 = 1) =>
      bps !== undefined ? round(base + sign * anchor * (bps / 10000), 2) : null;
    projection = {
      anchorPrice: anchor,
      c3Open: latest.c3Open,
      c3HighMedPrice: px(anchor, hiC2c?.median, 1),
      c3LowMedPrice: px(anchor, loC2c?.median, 1),
      hiBreakoutP30Price: px(latest.c2.high, brkHi?.p30, 1),
      hiBreakoutP50Price: px(latest.c2.high, brkHi?.median, 1),
      hiBreakoutP70Price: px(latest.c2.high, brkHi?.p70, 1),
      loBreakoutP30Price: px(latest.c2.low, brkLo?.p30, -1),
      loBreakoutP50Price: px(latest.c2.low, brkLo?.median, -1),
      loBreakoutP70Price: px(latest.c2.low, brkLo?.p70, -1),
      hiBreakoutP30Bps: brkHi?.p30 ?? null,
      hiBreakoutP50Bps: brkHi?.median ?? null,
      hiBreakoutP70Bps: brkHi?.p70 ?? null,
      loBreakoutP30Bps: brkLo?.p30 ?? null,
      loBreakoutP50Bps: brkLo?.median ?? null,
      loBreakoutP70Bps: brkLo?.p70 ?? null,
      mfeLongMedBps: mfeL?.median ?? null,
      mfeShortMedBps: mfeS?.median ?? null,
      bullCandle: scenarios.bull,
      bearCandle: scenarios.bear,
    };
  }

  const dateRows = await store.all(`
    ${cte}
    SELECT CAST(trade_date AS VARCHAR) AS td FROM matched ORDER BY bar_ts DESC LIMIT 50
  `);

  return {
    symbol: symCfg.symbol,
    tf,
    n,
    guards,
    activeMask,
    expectedMask,
    outcomes,
    excursions,
    scenarios,
    projection,
    perYear,
    latest,
    matchedDates: dateRows.map((r) => asStr(r.td) ?? "").filter(Boolean),
    disclaimer: DISCLAIMER,
  };
}
