/*
  Daily Profiler multi-outcome statistical suite & Composite Price Model.
  Every cell passes through the EdgeStats honesty layer (Wilson 95% CI,
  min-N guards, half/half stability split, and DISCLAIMER).
*/
import type { EdgeStatsConfig } from "../config";
import { defaultSessionKey, findSymbol } from "../config";
import { ensureDailyTables } from "../features/dailySchema";
import { currentGlobexTradeDateIso } from "../features/deriveDaily";
import { LEVEL_KEYS } from "../features/spineAdapter";
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
import { sqlDate, sqlStr } from "../util/sql";
import { asInt, asNum, asStr, round } from "../util/values";
import { compileConditionExpr } from "./compile";
import { compileCtxFor, DISCLAIMER } from "./execute";
import { parseConditionDsl } from "./parser";

export type ProfilerTargetSession = "asia" | "london" | "ny1" | "ny2" | "daily";

export interface ProfilerSessionFilter {
  status?: string; // "LT" | "LF" | "ST" | "SF" | "None"
  broken?: "yes" | "no";
}

export interface ProfilerSuiteRequest {
  symbol: string;
  targetSession: ProfilerTargetSession;
  filters?: Partial<
    Record<
      "asia" | "london" | "ny1" | "ny2" | "prev_asia" | "prev_london" | "prev_ny1" | "prev_ny2",
      ProfilerSessionFilter
    >
  >;
  p12Scenario?: string;
  alnPattern?: string;
  brokenBroken?: boolean;
  csC1Dir?: "bull" | "bear";
  csC2Dir?: "bull" | "bear";
  /** Arbitrary EdgeStats DSL WHERE expression (e.g. "NOT eventDay('FOMC') AND dayOfWeek = Tue"). */
  whereDsl?: string;
  since?: string;
  until?: string;
  bucketMinutes?: 5 | 15 | 30 | 60;
}

export interface ProfilerOutcomeRow {
  status: string;
  n: number;
  estimate: number | null;
  ci95: [number, number] | null;
  lowSample: boolean;
  stability: StabilitySplit | null;
  brokenN: number;
  brokenK: number;
  brokenRate: number | null;
  brokenCi95: [number, number] | null;
}

export interface ProfilerLevelTouchRow {
  level: string;
  n: number;
  touched: number;
  rate: number | null;
  ci95: [number, number] | null;
  lowSample: boolean;
  medianTouchMin: number | null;
}

export interface ProfilerTimeBucket {
  bucketMin: number;
  etLabel: string;
  hodCount: number;
  lodCount: number;
  hodRate: number;
  lodRate: number;
}

export interface ProfilerSessionShare {
  session: string;
  hodCount: number;
  hodRate: number | null;
  hodCi95: [number, number] | null;
  lodCount: number;
  lodRate: number | null;
  lodCi95: [number, number] | null;
}

export interface ProfilerSuiteResult {
  symbol: string;
  targetSession: ProfilerTargetSession;
  n: number;
  guards: GuardResult;
  outcomes: ProfilerOutcomeRow[];
  dailyHighDist: DistributionSummary | null;
  dailyLowDist: DistributionSummary | null;
  dailyRangeDist: DistributionSummary | null;
  timeBuckets: ProfilerTimeBucket[];
  sessionShares: ProfilerSessionShare[];
  levelTouches: ProfilerLevelTouchRow[];
  matchedDates: string[];
  disclaimer: string;
}

export interface PriceModelPoint {
  bucketIdx: number;
  etLabel: string;
  n: number;
  medianHighBps: number;
  medianLowBps: number;
  medianCloseBps: number;
  p25CloseBps: number;
  p75CloseBps: number;
  maxHighBps: number;
  minLowBps: number;
}

export interface ProfilerPriceModelResult {
  symbol: string;
  n: number;
  bucketMinutes: number;
  anchor: "prev_close" | "daily_open";
  guards: GuardResult;
  points: PriceModelPoint[];
  disclaimer: string;
}

export function offsetMinToEtLabel(offsetMin: number): string {
  const totalMin = (18 * 60 + offsetMin) % 1440;
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function buildProfilerWhere(
  config: EdgeStatsConfig,
  req: ProfilerSuiteRequest,
): { fromClause: string; whereClause: string; symbolName: string } {
  const symCfg = findSymbol(config, req.symbol);
  const defaultKey = defaultSessionKey(symCfg);
  const fromClause = `
    FROM daily_context d
    LEFT JOIN cs_candles cs ON cs.symbol = d.symbol AND cs.trade_date = d.trade_date AND cs.tf = '1d'
    LEFT JOIN session_features f ON f.symbol = d.symbol AND f.trade_date = d.trade_date AND f.session_key = ${sqlStr(defaultKey)}
  `;
  const conds: string[] = [
    `d.symbol = ${sqlStr(symCfg.symbol)}`,
    "d.complete = TRUE",
    `d.trade_date < DATE ${sqlStr(currentGlobexTradeDateIso())}`,
  ];
  if (req.since) conds.push(`d.trade_date >= ${sqlDate(req.since)}`);
  if (req.until) conds.push(`d.trade_date <= ${sqlDate(req.until)}`);

  if (req.filters) {
    for (const [sess, flt] of Object.entries(req.filters)) {
      if (!flt) continue;
      if (flt.status && flt.status !== "Any") {
        conds.push(`d.${sess}_status = ${sqlStr(flt.status)}`);
      }
      if (flt.broken === "yes") conds.push(`d.${sess}_broken = TRUE`);
      if (flt.broken === "no") conds.push(`d.${sess}_broken = FALSE`);
    }
  }
  if (req.p12Scenario && req.p12Scenario !== "Any") {
    conds.push(`d.p12_scenario = ${sqlStr(req.p12Scenario)}`);
  }
  if (req.alnPattern && req.alnPattern !== "Any") {
    conds.push(`d.aln_pattern = ${sqlStr(req.alnPattern)}`);
  }
  if (req.brokenBroken === true) conds.push("d.broken_broken = TRUE");
  if (req.brokenBroken === false) conds.push("d.broken_broken = FALSE");
  if (req.csC1Dir) conds.push(`cs.roll_safe = TRUE AND cs.c1_dir = ${sqlStr(req.csC1Dir)}`);
  if (req.csC2Dir) conds.push(`cs.roll_safe = TRUE AND cs.c2_dir = ${sqlStr(req.csC2Dir)}`);

  if (req.whereDsl && req.whereDsl.trim().length > 0) {
    const expr = parseConditionDsl(req.whereDsl);
    const compiledSql = compileConditionExpr(expr, compileCtxFor(symCfg));
    conds.push(`(${compiledSql})`);
  }

  return { fromClause, whereClause: conds.join(" AND "), symbolName: symCfg.symbol };
}

function parseDist(
  row: Record<string, unknown> | null | undefined,
  prefix: string,
  unit: string,
): DistributionSummary | null {
  const cnt = asInt(row?.[`${prefix}_n`]) ?? 0;
  const mean = asNum(row?.[`${prefix}_mean`]);
  const qStr = asStr(row?.[`${prefix}_q`]);
  if (cnt <= 0 || mean === null || !qStr) return null;
  const parsed = JSON.parse(qStr) as (number | null)[];
  if (!parsed.every((x): x is number => typeof x === "number")) return null;
  return distributionFromQuantiles(cnt, round(mean), parsed.map((x) => round(x)), unit);
}

export async function runProfilerSuite(
  store: Store,
  config: EdgeStatsConfig,
  req: ProfilerSuiteRequest,
): Promise<ProfilerSuiteResult> {
  await ensureDailyTables(store);
  const { fromClause, whereClause, symbolName } = buildProfilerWhere(config, req);
  const bucketMin = req.bucketMinutes ?? 30;
  const targetColPrefix = req.targetSession === "daily" ? "ny1" : req.targetSession;

  const baseCte = `
    WITH matched AS (
      SELECT d.*,
             row_number() OVER (ORDER BY d.trade_date) AS rn,
             count(*) OVER () AS total
      ${fromClause}
      WHERE ${whereClause}
    )
  `;

  // 1. Total N & Daily Range distributions
  const summaryRow = await store.one(`
    ${baseCte}
    SELECT
      count(*)::INT AS n,
      count(daily_high_bps)::INT AS hi_n,
      avg(daily_high_bps) AS hi_mean,
      to_json(quantile_cont(daily_high_bps, [0.0, 0.10, 0.25, 0.30, 0.50, 0.70, 0.75, 0.90, 0.95, 1.0])) AS hi_q,
      count(daily_low_bps)::INT AS lo_n,
      avg(daily_low_bps) AS lo_mean,
      to_json(quantile_cont(daily_low_bps, [0.0, 0.10, 0.25, 0.30, 0.50, 0.70, 0.75, 0.90, 0.95, 1.0])) AS lo_q,
      count(daily_range_bps)::INT AS rng_n,
      avg(daily_range_bps) AS rng_mean,
      to_json(quantile_cont(daily_range_bps, [0.0, 0.10, 0.25, 0.30, 0.50, 0.70, 0.75, 0.90, 0.95, 1.0])) AS rng_q
    FROM matched
  `);
  const totalN = asInt(summaryRow?.n) ?? 0;
  const guards = applyGuards(totalN, config.minN);

  // 2. 5-way Outcome breakdown + per-outcome broken rate + half/half stability
  const statuses = ["LT", "LF", "ST", "SF", "None"];
  const outcomeRows = await store.all(`
    ${baseCte}
    SELECT
      ${targetColPrefix}_status AS st,
      count(*)::INT AS k,
      coalesce(sum(CASE WHEN rn * 2 <= total THEN 1 ELSE 0 END), 0)::INT AS k1,
      coalesce(sum(CASE WHEN rn * 2 > total THEN 1 ELSE 0 END), 0)::INT AS k2,
      count(${targetColPrefix}_broken)::INT AS brk_n,
      coalesce(sum(CASE WHEN ${targetColPrefix}_broken = TRUE THEN 1 ELSE 0 END), 0)::INT AS brk_k
    FROM matched
    WHERE ${targetColPrefix}_status IS NOT NULL
    GROUP BY st
  `);
  const halfTotals = await store.one(`
    ${baseCte}
    SELECT
      count(*) FILTER (WHERE ${targetColPrefix}_status IS NOT NULL)::INT AS eligible_n,
      count(*) FILTER (WHERE ${targetColPrefix}_status IS NOT NULL AND rn * 2 <= total)::INT AS n1,
      count(*) FILTER (WHERE ${targetColPrefix}_status IS NOT NULL AND rn * 2 > total)::INT AS n2
    FROM matched
  `);
  const eligibleN = asInt(halfTotals?.eligible_n) ?? 0;
  const n1 = asInt(halfTotals?.n1) ?? 0;
  const n2 = asInt(halfTotals?.n2) ?? 0;
  const bySt = new Map(outcomeRows.map((r) => [asStr(r.st) ?? "", r]));

  const outcomes: ProfilerOutcomeRow[] = statuses.map((st) => {
    const r = bySt.get(st);
    const k = asInt(r?.k) ?? 0;
    const k1 = asInt(r?.k1) ?? 0;
    const k2 = asInt(r?.k2) ?? 0;
    const brkN = asInt(r?.brk_n) ?? 0;
    const brkK = asInt(r?.brk_k) ?? 0;
    const w = wilson(k, eligibleN);
    const bw = wilson(brkK, brkN);
    return {
      status: st,
      n: k,
      estimate: w ? round(w.estimate) : null,
      ci95: w ? [round(w.lo), round(w.hi)] : null,
      lowSample: eligibleN < config.minN.warn,
      stability: eligibleN > 0 ? stabilitySplit(n1, k1, n2, k2) : null,
      brokenN: brkN,
      brokenK: brkK,
      brokenRate: bw ? round(bw.estimate) : null,
      brokenCi95: bw ? [round(bw.lo), round(bw.hi)] : null,
    };
  });

  // 3. HOD/LOD time-of-day histograms
  const timeRows = await store.all(`
    ${baseCte}
    SELECT
      b AS bucket_min,
      count(*) FILTER (WHERE floor(hod_min / ${bucketMin}) * ${bucketMin} = b)::INT AS hod_c,
      count(*) FILTER (WHERE floor(lod_min / ${bucketMin}) * ${bucketMin} = b)::INT AS lod_c
    FROM (SELECT unnest(range(0, 1380, ${bucketMin})) AS b) grid
    LEFT JOIN matched ON TRUE
    GROUP BY b
    ORDER BY b
  `);
  const timeBuckets: ProfilerTimeBucket[] = timeRows.map((r) => {
    const bm = asInt(r.bucket_min) ?? 0;
    const hc = asInt(r.hod_c) ?? 0;
    const lc = asInt(r.lod_c) ?? 0;
    return {
      bucketMin: bm,
      etLabel: offsetMinToEtLabel(bm),
      hodCount: hc,
      lodCount: lc,
      hodRate: totalN > 0 ? round(hc / totalN) : 0,
      lodRate: totalN > 0 ? round(lc / totalN) : 0,
    };
  });

  // 4. HOD/LOD Session Shares
  const sessList = ["asia", "london", "ny1", "ny2", "post_ny2"];
  const shareRows = await store.all(`
    ${baseCte}
    SELECT
      s.sess,
      count(*) FILTER (WHERE matched.hod_session = s.sess)::INT AS hc,
      count(*) FILTER (WHERE matched.lod_session = s.sess)::INT AS lc
    FROM (VALUES ('asia'), ('london'), ('ny1'), ('ny2'), ('post_ny2')) s(sess)
    LEFT JOIN matched ON TRUE
    GROUP BY s.sess
  `);
  const shareMap = new Map(shareRows.map((r) => [asStr(r.sess) ?? "", r]));
  const sessionShares: ProfilerSessionShare[] = sessList.map((sess) => {
    const r = shareMap.get(sess);
    const hc = asInt(r?.hc) ?? 0;
    const lc = asInt(r?.lc) ?? 0;
    const hw = wilson(hc, totalN);
    const lw = wilson(lc, totalN);
    return {
      session: sess,
      hodCount: hc,
      hodRate: hw ? round(hw.estimate) : null,
      hodCi95: hw ? [round(hw.lo), round(hw.hi)] : null,
      lodCount: lc,
      lodRate: lw ? round(lw.estimate) : null,
      lodCi95: lw ? [round(lw.lo), round(lw.hi)] : null,
    };
  });

  // 5. 20 Reference Level Touches in one SQL pass
  const levelSelects = LEVEL_KEYS.map(
    (lv) => `
      count(touch_${lv})::INT AS n_${lv},
      coalesce(sum(CASE WHEN touch_${lv} = TRUE THEN 1 ELSE 0 END), 0)::INT AS k_${lv},
      median(touch_${lv}_min) FILTER (WHERE touch_${lv} = TRUE) AS med_${lv}
    `,
  ).join(",\n");
  const lvRow = await store.one(`${baseCte} SELECT ${levelSelects} FROM matched`);
  const levelTouches: ProfilerLevelTouchRow[] = LEVEL_KEYS.map((lv) => {
    const ln = asInt(lvRow?.[`n_${lv}`]) ?? 0;
    const lk = asInt(lvRow?.[`k_${lv}`]) ?? 0;
    const med = asNum(lvRow?.[`med_${lv}`]);
    const w = wilson(lk, ln);
    return {
      level: lv,
      n: ln,
      touched: lk,
      rate: w ? round(w.estimate) : null,
      ci95: w ? [round(w.lo), round(w.hi)] : null,
      lowSample: ln < config.minN.warn,
      medianTouchMin: med !== null ? Math.round(med) : null,
    };
  });

  // 6. Recent matched dates for drilldown
  const dateRows = await store.all(`
    ${baseCte}
    SELECT CAST(trade_date AS VARCHAR) AS td FROM matched ORDER BY trade_date DESC LIMIT 50
  `);

  return {
    symbol: symbolName,
    targetSession: req.targetSession,
    n: totalN,
    guards,
    outcomes,
    dailyHighDist: parseDist(summaryRow, "hi", "bps"),
    dailyLowDist: parseDist(summaryRow, "lo", "bps"),
    dailyRangeDist: parseDist(summaryRow, "rng", "bps"),
    timeBuckets,
    sessionShares,
    levelTouches,
    matchedDates: dateRows.map((r) => asStr(r.td) ?? "").filter(Boolean),
    disclaimer: DISCLAIMER,
  };
}

export async function runProfilerPriceModel(
  store: Store,
  config: EdgeStatsConfig,
  req: ProfilerSuiteRequest & { anchor?: "prev_close" | "daily_open" },
): Promise<ProfilerPriceModelResult> {
  await ensureDailyTables(store);
  const { fromClause, whereClause, symbolName } = buildProfilerWhere(config, req);
  const bucketMin = req.bucketMinutes ?? 5;
  const groupFactor = Math.max(1, Math.floor(bucketMin / 5));
  const anchor = req.anchor ?? "daily_open";
  const hiCol = anchor === "prev_close" ? "p.high_bps_prev_close" : "p.high_bps_daily_open";
  const loCol = anchor === "prev_close" ? "p.low_bps_prev_close" : "p.low_bps_daily_open";
  const clCol = anchor === "prev_close" ? "p.close_bps_prev_close" : "p.close_bps_daily_open";

  const countRow = await store.one(`
    SELECT count(*)::INT AS n ${fromClause} WHERE ${whereClause}
  `);
  const n = asInt(countRow?.n) ?? 0;
  const guards = applyGuards(n, config.minN);

  const rows = await store.all(`
    WITH matched AS (
      SELECT d.symbol, d.trade_date ${fromClause} WHERE ${whereClause}
    ),
    rebinned AS (
      SELECT
        p.trade_date,
        CAST(floor(p.bucket_idx / ${groupFactor}) * ${groupFactor} AS INT) AS bidx,
        max(${hiCol}) AS hi,
        min(${loCol}) AS lo,
        arg_max(${clCol}, p.bucket_idx) AS cl
      FROM daily_paths_5m p
      JOIN matched m ON m.symbol = p.symbol AND m.trade_date = p.trade_date
      WHERE ${clCol} IS NOT NULL
      GROUP BY p.trade_date, bidx
    )
    SELECT
      bidx,
      count(*)::INT AS cnt,
      median(hi) AS med_hi,
      median(lo) AS med_lo,
      median(cl) AS med_cl,
      quantile_cont(cl, 0.25) AS p25_cl,
      quantile_cont(cl, 0.75) AS p75_cl,
      max(hi) AS max_hi,
      min(lo) AS min_lo
    FROM rebinned
    GROUP BY bidx
    ORDER BY bidx
  `);

  const points: PriceModelPoint[] = rows.map((r) => {
    const bidx = asInt(r.bidx) ?? 0;
    return {
      bucketIdx: bidx,
      etLabel: offsetMinToEtLabel(bidx * 5),
      n: asInt(r.cnt) ?? 0,
      medianHighBps: round(asNum(r.med_hi) ?? 0),
      medianLowBps: round(asNum(r.med_lo) ?? 0),
      medianCloseBps: round(asNum(r.med_cl) ?? 0),
      p25CloseBps: round(asNum(r.p25_cl) ?? 0),
      p75CloseBps: round(asNum(r.p75_cl) ?? 0),
      maxHighBps: round(asNum(r.max_hi) ?? 0),
      minLowBps: round(asNum(r.min_lo) ?? 0),
    };
  });

  return {
    symbol: symbolName,
    n,
    bucketMinutes: bucketMin,
    anchor,
    guards,
    points,
    disclaimer: DISCLAIMER,
  };
}
