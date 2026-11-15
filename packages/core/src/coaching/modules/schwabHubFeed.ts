import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { BasketAssetRow, FastQuote, OrderflowState } from "./types";

const BASKET_SYMBOLS = ["META", "AMZN", "NVDA", "MSFT", "GOOGL", "AAPL", "TSLA"] as const;
const FUTURES_MAP: Record<string, string> = {
  "/ES": "ES1",
  "/NQ": "NQ1",
  "/YM": "YM1",
};

const quotes = new Map<string, FastQuote>();
const orderflowMtime = new Map<string, { mtimeMs: number; state: OrderflowState }>();
let wsStarted = false;
let wsConnected = false;

function mapHubSymbol(raw: string): string {
  const upper = raw.toUpperCase();
  if (FUTURES_MAP[upper]) return FUTURES_MAP[upper];
  return upper.startsWith("$") ? upper.slice(1) : upper;
}

function ingestHubEvent(msg: unknown) {
  if (!msg || typeof msg !== "object") return;
  const ev = msg as { service?: string; content?: Array<Record<string, unknown>> };
  if (!Array.isArray(ev.content)) return;

  const now = Date.now();
  for (const item of ev.content) {
    const rawKey = typeof item.key === "string" ? item.key : "";
    if (!rawKey) continue;
    const symbol = mapHubSymbol(rawKey);
    const prev = quotes.get(symbol);

    // Schwab LEVELONE_EQUITIES / LEVELONE_FUTURES field numbers:
    // 3: Last, 12/13: High/Low (equities) or 13/14 (futures), 15/18/29: NetPct/Open/Close
    const last = Number(item["3"] ?? item["lastPrice"] ?? prev?.last ?? 0);
    if (!Number.isFinite(last) || last <= 0) continue;

    const prevClose = Number(item["15"] ?? item["closePrice"] ?? prev?.prevClose ?? 0) || undefined;
    const netPctRaw = Number(item["43"] ?? item["netPercentChangeInDouble"] ?? prev?.netPct ?? NaN);
    const netPct = Number.isFinite(netPctRaw)
      ? netPctRaw
      : prevClose
        ? ((last - prevClose) / prevClose) * 100
        : prev?.netPct;

    quotes.set(symbol, {
      symbol,
      last,
      prevClose,
      netPct,
      volume: Number(item["8"] ?? prev?.volume ?? 0) || undefined,
      bidSize: Number(item["4"] ?? prev?.bidSize ?? 0) || undefined,
      askSize: Number(item["5"] ?? prev?.askSize ?? 0) || undefined,
      tsMs: now,
    });
  }
}

export function startSchwabHubFeed(wsUrl = process.env.SCHWAB_HUB_WS_URL ?? "ws://127.0.0.1:8081/ws") {
  if (wsStarted || typeof WebSocket === "undefined") return;
  wsStarted = true;

  const connect = () => {
    try {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        wsConnected = true;
      };
      ws.onmessage = (e) => {
        try {
          ingestHubEvent(JSON.parse(String(e.data)));
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        wsConnected = false;
        setTimeout(connect, 5000);
      };
      ws.onerror = () => {
        wsConnected = false;
      };
    } catch {
      wsConnected = false;
      setTimeout(connect, 5000);
    }
  };

  connect();
}

function readOrderflowFile(liveDir: string, root: "ES" | "NQ", outSym: string): OrderflowState | null {
  const path = resolve(liveDir, `orderflow_${root}.json`);
  if (!existsSync(path)) return null;
  try {
    const st = statSync(path);
    const cached = orderflowMtime.get(outSym);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.state;

    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      t?: number;
      cvd?: number;
      cvd_series?: Array<{ t?: number; cvd?: number }>;
    };
    const series = Array.isArray(parsed.cvd_series) ? parsed.cvd_series : [];
    const latestCvd = Number(parsed.cvd ?? series[series.length - 1]?.cvd ?? 0);
    const fiveMinAgoTs = (parsed.t ?? Date.now()) - 5 * 60_000;
    const basePoint = series.find((p) => (p.t ?? 0) >= fiveMinAgoTs) ?? series[0];
    const cvdDelta5m = basePoint ? latestCvd - Number(basePoint.cvd ?? 0) : 0;

    const state: OrderflowState = {
      symbol: outSym,
      cvd: latestCvd,
      cvdDelta5m,
      tsMs: Number(parsed.t ?? st.mtimeMs),
    };
    orderflowMtime.set(outSym, { mtimeMs: st.mtimeMs, state });
    return state;
  } catch {
    return null;
  }
}

export function getFastTapeSnapshot(liveDir?: string): {
  feedSource: "schwab-hub" | "parquet";
  quotes: Record<string, FastQuote>;
  orderflow: Record<string, OrderflowState>;
  basket: BasketAssetRow[];
} {
  const quoteObj: Record<string, FastQuote> = {};
  for (const [k, v] of quotes.entries()) {
    quoteObj[k] = v;
  }

  const orderflow: Record<string, OrderflowState> = {};
  if (liveDir) {
    const es = readOrderflowFile(liveDir, "ES", "ES1");
    const nq = readOrderflowFile(liveDir, "NQ", "NQ1");
    if (es) orderflow["ES1"] = es;
    if (nq) orderflow["NQ1"] = nq;
  }

  const basket: BasketAssetRow[] = [];
  for (const sym of BASKET_SYMBOLS) {
    const q = quotes.get(sym);
    if (!q) continue;
    const dayPct = q.netPct ?? 0;
    basket.push({
      symbol: sym,
      last: q.last,
      dayPct: Number(dayPct.toFixed(2)),
      score: Number((dayPct * 0.5).toFixed(2)),
    });
  }

  return {
    feedSource: wsConnected && quotes.size > 0 ? "schwab-hub" : "parquet",
    quotes: quoteObj,
    orderflow,
    basket,
  };
}
