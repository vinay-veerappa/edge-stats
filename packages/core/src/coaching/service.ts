import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DateTime } from "luxon";
import type { EdgeStatsConfig } from "../config";
import { findSymbol } from "../config";
import { runQuery } from "../query/execute";
import { getSessionBars } from "../query/session-bars";
import type { Store } from "../store/store";
import { freshness } from "../sync";
import { sqlPath } from "../util/sql";
import { asNum } from "../util/values";
import {
  buildCrossInstrumentPlan,
  evaluateInstrumentSession,
  type CoachingBar,
  type InstrumentCoachState,
  type MarketCoachingSnapshot,
} from "./scanner";
import { evaluateCoachModules, type ModuleStatus } from "./modules/registry";
import { evaluateTradeDecision, type TradeDecision } from "./modules/decisionEngine";
import { readGexLevels } from "./modules/gexFeed";
import { getFastTapeSnapshot } from "./modules/schwabHubFeed";
import type {
  BasketAssetRow,
  ModuleSignal,
  PermissionState,
  ReferenceLevels,
} from "./modules/types";

export interface ModularCoachingSnapshot extends MarketCoachingSnapshot {
  feedSource: "schwab-hub" | "parquet";
  permission: PermissionState;
  signals: ModuleSignal[];
  modules: ModuleStatus[];
  basket: BasketAssetRow[];
  decision: TradeDecision;
}

const DEFAULT_SYMBOLS = ["ES1", "NQ1", "YM1"] as const;
const statCache = new Map<string, { n: number; estimate: number | null; ci95: [number, number] | null }>();

function resolveLiveParquetPath(config: EdgeStatsConfig, symbol: string): string | null {
  const sym = findSymbol(config, symbol);
  if (!sym?.external) return null;
  const threeUp = resolve(sym.external.root, "..", "..", "..", "live", `live_storage_-${sym.external.name}.parquet`);
  if (existsSync(threeUp)) return threeUp;
  const twoUp = resolve(sym.external.root, "..", "..", "live", `live_storage_-${sym.external.name}.parquet`);
  return existsSync(twoUp) ? twoUp : null;
}

async function readLiveRthBars(
  store: Store,
  config: EdgeStatsConfig,
  symbol: string,
  tradeDate: string,
): Promise<CoachingBar[]> {
  const path = resolveLiveParquetPath(config, symbol);
  if (!path) return [];
  const startEt = DateTime.fromISO(`${tradeDate}T09:30:00`, { zone: "America/New_York" });
  const endEt = DateTime.fromISO(`${tradeDate}T16:00:00`, { zone: "America/New_York" });
  if (!startEt.isValid || !endEt.isValid) return [];
  const rows = await store.all(
    `SELECT time, open, high, low, close, volume
     FROM read_parquet(${sqlPath(path)})
     WHERE time >= ${startEt.toMillis()} AND time < ${endEt.toMillis()}
     ORDER BY time ASC`,
  );
  return rows.map((r) => ({
    tsMs: asNum(r.time) ?? 0,
    open: asNum(r.open) ?? 0,
    high: asNum(r.high) ?? 0,
    low: asNum(r.low) ?? 0,
    close: asNum(r.close) ?? 0,
    volume: asNum(r.volume) ?? 0,
  }));
}

async function readLiveGlobexBars(
  store: Store,
  config: EdgeStatsConfig,
  symbol: string,
  tradeDate: string,
): Promise<CoachingBar[]> {
  const path = resolveLiveParquetPath(config, symbol);
  if (!path) return [];
  const dt = DateTime.fromISO(tradeDate, { zone: "America/New_York" });
  if (!dt.isValid) return [];
  // Globex window: either today's 18:00+ ET (Sunday/evening) or yesterday 18:00 -> today 09:30 ET
  const eveStart = dt.set({ hour: 18, minute: 0, second: 0, millisecond: 0 });
  const prevEveStart = eveStart.minus({ days: 1 });
  const rthStart = dt.set({ hour: 9, minute: 30, second: 0, millisecond: 0 });

  const eveRows = await store.all(
    `SELECT time, open, high, low, close, volume
     FROM read_parquet(${sqlPath(path)})
     WHERE time >= ${eveStart.toMillis()}
     ORDER BY time ASC`,
  );
  const rows =
    eveRows.length > 0
      ? eveRows
      : await store.all(
          `SELECT time, open, high, low, close, volume
           FROM read_parquet(${sqlPath(path)})
           WHERE time >= ${prevEveStart.toMillis()} AND time < ${rthStart.toMillis()}
           ORDER BY time ASC`,
        );

  return rows.map((r) => ({
    tsMs: asNum(r.time) ?? 0,
    open: asNum(r.open) ?? 0,
    high: asNum(r.high) ?? 0,
    low: asNum(r.low) ?? 0,
    close: asNum(r.close) ?? 0,
    volume: asNum(r.volume) ?? 0,
  }));
}

async function getLatestFoldedLevels(
  store: Store,
  config: EdgeStatsConfig,
  symbol: string,
): Promise<{ prevClose: number | null; prevHigh: number | null; prevLow: number | null }> {
  try {
    const f = await freshness(store, config);
    const symFresh = f.symbols.find((s) => s.symbol === symbol);
    const lastMs = symFresh?.lastBarMs;
    if (!lastMs) return { prevClose: null, prevHigh: null, prevLow: null };
    const lastDate = DateTime.fromMillis(lastMs, { zone: "America/New_York" }).toISODate();
    if (!lastDate) return { prevClose: null, prevHigh: null, prevLow: null };
    const sb = await getSessionBars(store, config, `${symbol}|rth|${lastDate}`);
    return {
      prevClose: sb.levels.close ?? sb.levels.prevClose,
      prevHigh: sb.levels.high ?? sb.levels.prevHigh,
      prevLow: sb.levels.low ?? sb.levels.prevLow,
    };
  } catch {
    return { prevClose: null, prevHigh: null, prevLow: null };
  }
}

function mergeBars(folded: CoachingBar[], live: CoachingBar[]): CoachingBar[] {
  if (live.length === 0) return folded;
  const byTs = new Map<number, CoachingBar>();
  for (const b of folded) byTs.set(b.tsMs, b);
  for (const b of live) {
    if (!byTs.has(b.tsMs)) byTs.set(b.tsMs, b);
  }
  return [...byTs.values()].sort((a, b) => a.tsMs - b.tsMs);
}

async function cachedStat(
  store: Store,
  config: EdgeStatsConfig,
  symbol: string,
  tradeDate: string,
  dsl: string,
) {
  const key = `${symbol}|${tradeDate}|${dsl}`;
  const hit = statCache.get(key);
  if (hit) return hit;
  const res = await runQuery(store, config, { symbol, dsl, until: tradeDate });
  const val = {
    n: res.n,
    estimate: res.estimate,
    ci95: res.ci95,
  };
  statCache.set(key, val);
  return val;
}

export async function latestRthTradeDate(
  store: Store,
  config: EdgeStatsConfig,
): Promise<string | null> {
  const f = await freshness(store, config);
  let bestMs = 0;
  for (const s of f.symbols) {
    if (s.lastBarMs && s.lastBarMs > bestMs) bestMs = s.lastBarMs;
  }
  const liveNq = resolveLiveParquetPath(config, "NQ1");
  if (liveNq) {
    try {
      const row = await store.one(`SELECT MAX(time) AS max_ts FROM read_parquet(${sqlPath(liveNq)})`);
      const liveMs = asNum(row?.max_ts) ?? 0;
      if (liveMs > bestMs) bestMs = liveMs;
    } catch {
      // ignore transient parquet read errors during live writes
    }
  }
  if (bestMs <= 0) return null;
  return DateTime.fromMillis(bestMs, { zone: "America/New_York" }).toISODate();
}

export async function evaluateMarketCoaching(
  store: Store,
  config: EdgeStatsConfig,
  options?: { tradeDate?: string; symbols?: string[]; disabledModules?: string[] },
): Promise<ModularCoachingSnapshot> {
  const tradeDate = options?.tradeDate ?? (await latestRthTradeDate(store, config));
  if (!tradeDate) {
    throw new Error("No RTH sessions found in EdgeStats store");
  }
  const symbols = options?.symbols ?? [...DEFAULT_SYMBOLS];
  const instruments: InstrumentCoachState[] = [];
  const levelsBySymbol: Record<string, ReferenceLevels> = {};

  for (const symbol of symbols) {
    try {
      let folded: CoachingBar[] = [];
      let prevClose: number | null = null;
      let prevHigh: number | null = null;
      let prevLow: number | null = null;
      try {
        const sb = await getSessionBars(store, config, `${symbol}|rth|${tradeDate}`);
        folded = sb.bars.map((b) => ({
          tsMs: b.ts,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
        }));
        prevClose = sb.levels.prevClose;
        prevHigh = sb.levels.prevHigh;
        prevLow = sb.levels.prevLow;
      } catch {
        // session not yet folded into DuckDB; fall back to live_storage
      }
      const live = await readLiveRthBars(store, config, symbol, tradeDate);
      let bars = mergeBars(folded, live);
      if (bars.length === 0) {
        bars = await readLiveGlobexBars(store, config, symbol, tradeDate);
        if (bars.length > 0 && prevHigh === null && prevLow === null) {
          const prior = await getLatestFoldedLevels(store, config, symbol);
          prevClose = prevClose ?? prior.prevClose;
          prevHigh = prior.prevHigh;
          prevLow = prior.prevLow;
        }
      }
      if (bars.length === 0) continue;
      const state = evaluateInstrumentSession(symbol, tradeDate, bars, prevClose);
      let sessionHigh = -Infinity;
      let sessionLow = Infinity;
      for (const b of bars) {
        if (b.high > sessionHigh) sessionHigh = b.high;
        if (b.low < sessionLow) sessionLow = b.low;
      }
      levelsBySymbol[symbol] = {
        pdh: prevHigh ?? undefined,
        pdl: prevLow ?? undefined,
        sessionHigh: Number.isFinite(sessionHigh) ? sessionHigh : undefined,
        sessionLow: Number.isFinite(sessionLow) ? sessionLow : undefined,
      };

      const edgeQueries: Array<{ label: string; dsl: string }> = [];
      if (state.org.orgInto30m) {
        edgeQueries.push({ label: "orgInto30m -> gapFill", dsl: "gapFill WHERE orgInto30m" });
      } else if (state.org.orgAway30m) {
        edgeQueries.push({ label: "orgAway30m -> gapHold", dsl: "gapHold WHERE orgAway30m" });
      }
      if (state.noonGate === "NO_NOON_FADE" && state.org.gapDir === "UP" && (state.org.gapBps ?? 0) >= 45) {
        edgeQueries.push({
          label: "LargeGapUp + orbMidNeverTested -> closeGreen",
          dsl: "closeGreen WHERE gapUp AND absGapPct >= 0.45 AND orbMidNeverTested(30)",
        });
      }
      if (state.orb30.orb25ExtReject !== "NONE") {
        edgeQueries.push({
          label: "ORB30 break -> 25% ext hit",
          dsl: "orbTargetHit(30, 0.25) WHERE orbBroke(30, 'either')",
        });
      }

      const edgeStats: InstrumentCoachState["edgeStats"] = [];
      for (const q of edgeQueries) {
        try {
          const s = await cachedStat(store, config, symbol, tradeDate, q.dsl);
          edgeStats.push({ label: q.label, ...s });
        } catch {
          // ignore if query fails for sparse symbol
        }
      }
      state.edgeStats = edgeStats;
      instruments.push(state);
    } catch {
      // skip symbol if session bars missing for tradeDate
    }
  }

  const nqSym = findSymbol(config, "NQ1");
  const liveDir = nqSym?.external
    ? [
        resolve(nqSym.external.root, "..", "..", "..", "live"),
        resolve(nqSym.external.root, "..", "..", "live"),
      ].find((d) => existsSync(d))
    : undefined;
  const optionsDir = nqSym?.external
    ? [
        resolve(nqSym.external.root, "..", "..", "..", "options"),
        resolve(nqSym.external.root, "..", "..", "options"),
      ].find((d) => existsSync(d))
    : undefined;
  const fast = getFastTapeSnapshot(liveDir);
  const gex = readGexLevels(optionsDir);
  const modResult = evaluateCoachModules(
    {
      tradeDate,
      asOfEt: instruments[0]?.asOfEt ?? "",
      instruments,
      levelsBySymbol,
      quotes: fast.quotes,
      orderflow: fast.orderflow,
      basket: fast.basket,
      gex,
    },
    options?.disabledModules ?? [],
  );

  const routing = buildCrossInstrumentPlan(instruments);
  const decision = evaluateTradeDecision({
    instruments,
    routing,
    permission: modResult.permission,
    signals: modResult.signals,
  });

  return {
    tradeDate,
    evaluatedAtUtc: new Date().toISOString(),
    instruments,
    routing,
    feedSource: fast.feedSource,
    permission: modResult.permission,
    signals: modResult.signals,
    modules: modResult.modules,
    basket: fast.basket,
    decision,
  };
}
