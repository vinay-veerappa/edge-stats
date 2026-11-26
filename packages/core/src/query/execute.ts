/*
  The executor: compiled query → DuckDB → the honest envelope. Every result
  carries N, the Wilson 95% CI, minimum-N guards, a first-half/second-half
  stability split, per-year counts, a recency view, the echoed normalized
  query, and the matching sessions behind the number. No bare percentages.
*/
import type { EdgeStatsConfig, SymbolConfig } from "../config";
import { defaultSessionKey, findSymbol } from "../config";
import { calendarVersionInfo } from "../calendar";
import type { CompileCtx } from "../registry";
import { QueryError, registry } from "../registry";
import type { DistributionSummary, GuardResult, StabilitySplit } from "../stats/stats";
import { applyGuards, distributionFromQuantiles, stabilitySplit, wilson } from "../stats/stats";
import type { Store } from "../store/store";
import { ensureDailyTables } from "../features/dailySchema";
import { sqlDate, sqlStr } from "../util/sql";
import { asBool, asInt, asNum, asStr, round } from "../util/values";
import { ENGINE_VERSION } from "../version";
import type { QueryAst } from "./ast";
import { queryAstSchema } from "./ast";
import { compileQuery } from "./compile";
import { parseDsl } from "./parser";

export const DISCLAIMER =
  "Historical conditional frequencies with sample sizes. Not predictions, not advice.";

export interface QueryRequest {
  dsl?: string;
  ast?: unknown;
  symbol: string;
  sessionKey?: string;
  since?: string;
  until?: string;
  /** Group results by a groupable registry field instead of one aggregate. */
  groupBy?: string;
  /** How many matching sessions to return for drill-down (default 25). */
  sessionsLimit?: number;
  /** Return the estimate even below the refuse floor (the banner still shows). */
  force?: boolean;
}

export interface SessionRef {
  sessionId: string;
  tradeDate: string;
  success: boolean;
  value: number | null;
}

export interface GroupResult {
  group: string;
  n: number;
  successes: number;
  estimate: number | null;
  ci95: [number, number] | null;
  lowSample: boolean;
}

export interface RecencyView {
  window: number;
  n: number;
  successes: number;
  estimate: number | null;
  ci95: [number, number] | null;
  /** True when the recency CI and the all-history CI do not overlap. */
  diverges: boolean | null;
}

export interface QueryResult {
  engine: { version: string; storeFingerprint: string; calendarVersion: string };
  query: {
    dsl: string;
    ast: QueryAst;
    outcome: string;
    symbol: string;
    sessionKey: string;
    since: string | null;
    until: string | null;
  };
  n: number;
  successes: number;
  estimate: number | null;
  ci95: [number, number] | null;
  guards: GuardResult;
  stability: StabilitySplit | null;
  perYear: { year: number; n: number; successes: number; estimate: number | null }[];
  recency: RecencyView | null;
  distribution: DistributionSummary | null;
  groups: GroupResult[] | null;
  sessions: SessionRef[];
  disclaimer: string;
}

export function compileCtxFor(symbol: SymbolConfig): CompileCtx {
  const orWindows = [...new Set([...symbol.orWindows, symbol.ibWindow])].sort((a, b) => a - b);
  return { orWindows, ibWindow: symbol.ibWindow };
}

export function parseRequestAst(req: QueryRequest): QueryAst {
  if (req.dsl !== undefined && req.ast !== undefined) {
    throw new QueryError("pass either dsl or ast, not both");
  }
  if (req.dsl !== undefined) return parseDsl(req.dsl);
  if (req.ast !== undefined) return queryAstSchema.parse(req.ast);
  throw new QueryError("a query needs a dsl string or an ast");
}

const ensuredDailyStores = new WeakSet<Store>();

async function ensureDailyOnce(store: Store): Promise<void> {
  if (ensuredDailyStores.has(store)) return;
  await ensureDailyTables(store);
  ensuredDailyStores.add(store);
}

export async function runQuery(
  store: Store,
  config: EdgeStatsConfig,
  req: QueryRequest,
): Promise<QueryResult> {
  await ensureDailyOnce(store);
  const symbol = findSymbol(config, req.symbol);
  const defaultKey = defaultSessionKey(symbol);
  const sessionKey = req.sessionKey ?? defaultKey;
  const ast = parseRequestAst(req);
  const compiled = compileQuery(ast, compileCtxFor(symbol));

  const isDaily = sessionKey === "daily";
  const isCs = sessionKey.startsWith("cs_");
  const csTf = isCs ? sessionKey.slice(3) : "1d";

  let fromClause: string;
  let tdCol: string;
  let yearCol: string;
  let sessionIdCol: string;
  let orderCol: string;
  const conditions: string[] = [];

  if (isDaily) {
    fromClause = `
      FROM daily_context d
      LEFT JOIN cs_candles cs ON cs.symbol = d.symbol AND cs.trade_date = d.trade_date AND cs.tf = '1d'
      LEFT JOIN session_features f ON f.symbol = d.symbol AND f.trade_date = d.trade_date AND f.session_key = ${sqlStr(defaultKey)}
    `;
    tdCol = "d.trade_date";
    yearCol = "d.year";
    sessionIdCol = `d.symbol || ':daily:' || CAST(d.trade_date AS VARCHAR)`;
    orderCol = "d.trade_date";
    conditions.push(`d.symbol = ${sqlStr(symbol.symbol)}`, "d.complete");
  } else if (isCs) {
    fromClause = `
      FROM cs_candles cs
      LEFT JOIN daily_context d ON d.symbol = cs.symbol AND d.trade_date = cs.trade_date
      LEFT JOIN session_features f ON f.symbol = cs.symbol AND f.trade_date = cs.trade_date AND f.session_key = ${sqlStr(defaultKey)}
    `;
    tdCol = "cs.trade_date";
    yearCol = "cs.year";
    sessionIdCol = `cs.symbol || ':' || ${sqlStr(sessionKey)} || ':' || CAST(cs.bar_ts AS VARCHAR)`;
    orderCol = "cs.bar_ts";
    conditions.push(
      `cs.symbol = ${sqlStr(symbol.symbol)}`,
      `cs.tf = ${sqlStr(csTf)}`,
      "cs.complete",
      "cs.roll_safe",
    );
  } else {
    fromClause = `
      FROM session_features f
      LEFT JOIN daily_context d ON d.symbol = f.symbol AND d.trade_date = f.trade_date
      LEFT JOIN cs_candles cs ON cs.symbol = f.symbol AND cs.trade_date = f.trade_date AND cs.tf = '1d'
    `;
    tdCol = "f.trade_date";
    yearCol = "f.year";
    sessionIdCol = "f.session_id";
    orderCol = "f.trade_date";
    conditions.push(
      `f.symbol = ${sqlStr(symbol.symbol)}`,
      `f.session_key = ${sqlStr(sessionKey)}`,
      "f.complete",
    );
  }

  conditions.push(`(${compiled.eligibilitySql})`);
  if (req.since) conditions.push(`${tdCol} >= ${sqlDate(req.since)}`);
  if (req.until) conditions.push(`${tdCol} <= ${sqlDate(req.until)}`);
  if (compiled.whereSql) conditions.push(compiled.whereSql);

  const recencyWindow = config.recencyWindow;
  const whereClause = conditions.join("\n      AND ");
  const succExpr = `coalesce((${compiled.successSql}), FALSE)`;
  const valExpr = compiled.valueSql ? `(${compiled.valueSql})` : "CAST(NULL AS DOUBLE)";
  const baseSql = `
    SELECT
      ${succExpr} AS succ,
      ${valExpr} AS val,
      ${tdCol} AS td,
      row_number() OVER (ORDER BY ${orderCol}) AS rn,
      count(*) OVER () AS total
    ${fromClause}
    WHERE ${whereClause}
  `;

  const totals = await store.one(`
    SELECT
      count(*)::INT AS n,
      coalesce(sum(CASE WHEN succ THEN 1 ELSE 0 END), 0)::INT AS k,
      coalesce(sum(CASE WHEN rn * 2 <= total THEN 1 ELSE 0 END), 0)::INT AS n1,
      coalesce(sum(CASE WHEN rn * 2 <= total AND succ THEN 1 ELSE 0 END), 0)::INT AS k1,
      coalesce(sum(CASE WHEN rn * 2 > total THEN 1 ELSE 0 END), 0)::INT AS n2,
      coalesce(sum(CASE WHEN rn * 2 > total AND succ THEN 1 ELSE 0 END), 0)::INT AS k2,
      coalesce(sum(CASE WHEN rn > total - ${recencyWindow} THEN 1 ELSE 0 END), 0)::INT AS nr,
      coalesce(sum(CASE WHEN rn > total - ${recencyWindow} AND succ THEN 1 ELSE 0 END), 0)::INT AS kr,
      count(val)::INT AS valn,
      avg(val) AS vmean,
      to_json(quantile_cont(val, [0.0, 0.10, 0.25, 0.30, 0.50, 0.70, 0.75, 0.90, 0.95, 1.0])) AS vq
    FROM (${baseSql})
  `);

  const n = asInt(totals?.n) ?? 0;
  const k = asInt(totals?.k) ?? 0;
  const guardResult = applyGuards(n, config.minN);
  const w = wilson(k, n);
  const showEstimate = w !== null && (!guardResult.refused || req.force === true);

  const perYearRows = await store.all(`
    SELECT ${yearCol} AS year, count(*)::INT AS n,
           coalesce(sum(CASE WHEN ${succExpr} THEN 1 ELSE 0 END), 0)::INT AS k
    ${fromClause}
    WHERE ${whereClause}
    GROUP BY ${yearCol} ORDER BY ${yearCol}
  `);
  const perYear = perYearRows.map((r) => {
    const yn = asInt(r.n) ?? 0;
    const yk = asInt(r.k) ?? 0;
    return {
      year: asInt(r.year) ?? 0,
      n: yn,
      successes: yk,
      estimate: yn > 0 ? round(yk / yn) : null,
    };
  });

  const sessionsLimit = Math.max(0, Math.min(req.sessionsLimit ?? 25, 500));
  const sessionRows =
    sessionsLimit === 0
      ? []
      : await store.all(`
          SELECT ${sessionIdCol} AS session_id, CAST(${tdCol} AS VARCHAR) AS d,
                 ${succExpr} AS succ, ${valExpr} AS val
          ${fromClause}
          WHERE ${whereClause}
          ORDER BY ${orderCol} DESC LIMIT ${sessionsLimit}
        `);
  const sessions: SessionRef[] = sessionRows.map((r) => ({
    sessionId: asStr(r.session_id) ?? "",
    tradeDate: asStr(r.d) ?? "",
    success: asBool(r.succ) ?? false,
    value: asNum(r.val),
  }));

  let groups: GroupResult[] | null = null;
  if (req.groupBy) {
    const field = registry.fields.get(req.groupBy);
    if (!field || !field.groupable) {
      const groupable = [...registry.fields.values()].filter((f) => f.groupable).map((f) => f.name);
      throw new QueryError(
        `cannot group by '${req.groupBy}'`,
        `groupable fields: ${groupable.join(", ")}`,
      );
    }
    const groupRows = await store.all(`
      SELECT CAST(${field.sql} AS VARCHAR) AS g, count(*)::INT AS n,
             coalesce(sum(CASE WHEN ${succExpr} THEN 1 ELSE 0 END), 0)::INT AS k
      ${fromClause}
      WHERE ${whereClause}
      GROUP BY g ORDER BY g
    `);
    groups = groupRows.map((r) => {
      const gn = asInt(r.n) ?? 0;
      const gk = asInt(r.k) ?? 0;
      const gw = wilson(gk, gn);
      return {
        group: asStr(r.g) ?? "NULL",
        n: gn,
        successes: gk,
        estimate: gw ? round(gw.estimate) : null,
        ci95: gw ? [round(gw.lo), round(gw.hi)] : null,
        lowSample: gn < config.minN.warn,
      };
    });
  }

  const n1 = asInt(totals?.n1) ?? 0;
  const k1 = asInt(totals?.k1) ?? 0;
  const n2 = asInt(totals?.n2) ?? 0;
  const k2 = asInt(totals?.k2) ?? 0;
  const stability = n > 0 ? stabilitySplit(n1, k1, n2, k2) : null;

  const nr = asInt(totals?.nr) ?? 0;
  const kr = asInt(totals?.kr) ?? 0;
  let recency: RecencyView | null = null;
  if (n > 0 && nr < n) {
    const rw = wilson(kr, nr);
    let diverges: boolean | null = null;
    if (rw && w) diverges = rw.lo > w.hi || rw.hi < w.lo;
    recency = {
      window: recencyWindow,
      n: nr,
      successes: kr,
      estimate: rw ? round(rw.estimate) : null,
      ci95: rw ? [round(rw.lo), round(rw.hi)] : null,
      diverges,
    };
  }

  let distribution: DistributionSummary | null = null;
  const valn = asInt(totals?.valn) ?? 0;
  if (compiled.valueSql && valn > 0) {
    const vq = asStr(totals?.vq);
    const vmean = asNum(totals?.vmean);
    if (vq && vmean !== null) {
      const parsed = JSON.parse(vq) as (number | null)[];
      if (parsed.every((x): x is number => typeof x === "number")) {
        distribution = distributionFromQuantiles(
          valn,
          round(vmean),
          parsed.map((x) => round(x)),
          compiled.valueUnit ?? "",
        );
      }
    }
  }

  return {
    engine: {
      version: ENGINE_VERSION,
      storeFingerprint: await store.fingerprint(),
      calendarVersion: calendarVersionInfo(store.dataDir).hash,
    },
    query: {
      dsl: compiled.normalizedDsl,
      ast,
      outcome: compiled.outcomeName,
      symbol: symbol.symbol,
      sessionKey,
      since: req.since ?? null,
      until: req.until ?? null,
    },
    n,
    successes: k,
    estimate: showEstimate && w ? round(w.estimate) : null,
    ci95: showEstimate && w ? [round(w.lo), round(w.hi)] : null,
    guards: guardResult,
    stability,
    perYear,
    recency,
    distribution,
    groups,
    sessions,
    disclaimer: DISCLAIMER,
  };
}

export interface SessionDetail {
  sessionId: string;
  features: Record<string, unknown>;
}

/** Drill-down: the full feature rows behind a result's session ids. */
export async function getSessions(store: Store, sessionIds: string[]): Promise<SessionDetail[]> {
  if (sessionIds.length === 0) return [];
  if (sessionIds.length > 500) throw new QueryError("at most 500 sessions per drill-down call");
  const ids = sessionIds.map((s) => sqlStr(s)).join(", ");
  const rows = await store.all(`
    SELECT * REPLACE (CAST(trade_date AS VARCHAR) AS trade_date)
    FROM session_features WHERE session_id IN (${ids}) ORDER BY trade_date
  `);
  return rows.map((r) => {
    const features: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(r)) {
      features[key] = typeof value === "bigint" ? Number(value) : value;
    }
    return { sessionId: asStr(r.session_id) ?? "", features };
  });
}
