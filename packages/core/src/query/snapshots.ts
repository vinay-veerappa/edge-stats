/*
  Journal-ready immutable Snapshot API (schemaVersion: 1).
  Captures point-in-time Candle Science and/or Daily Profiler statistics,
  exact target/reversal price levels, Wilson 95% CIs, engine fingerprint,
  permalink, and pre-rendered Markdown for Trade Journal / Discord / LLM reuse.
*/
import { randomUUID } from "node:crypto";
import type { EdgeStatsConfig } from "../config";
import type { CsDimName } from "../features/spineAdapter";
import type { Store } from "../store/store";
import { sqlStr } from "../util/sql";
import { asStr } from "../util/values";
import {
  runCandleScienceSuite,
  type CandleScienceSuiteRequest,
  type CandleScienceSuiteResult,
} from "./candleScienceSuite";
import {
  runProfilerSuite,
  type ProfilerSuiteRequest,
  type ProfilerSuiteResult,
} from "./profilerSuite";

export interface CreateSnapshotRequest {
  symbol: string;
  kind?: "candle_science" | "profiler" | "combined";
  tf?: "1d" | "4h" | "1h" | "15m";
  candleScience?: Omit<CandleScienceSuiteRequest, "symbol">;
  profiler?: Omit<ProfilerSuiteRequest, "symbol">;
  note?: string;
}

export interface EdgeSnapshotV1 {
  schemaVersion: 1;
  snapshotId: string;
  capturedAt: string;
  tradeDate: string;
  symbol: string;
  kind: "candle_science" | "profiler" | "combined";
  tf: string;
  engineFingerprint: string;
  permalink: string;
  note: string | null;
  candleScience: CandleScienceSuiteResult | null;
  profiler: ProfilerSuiteResult | null;
  markdownSummary: string;
}

export interface SnapshotSummaryItem {
  snapshotId: string;
  capturedAt: string;
  tradeDate: string;
  symbol: string;
  kind: string;
  tf: string;
  permalink: string;
}

let ensuredStores = new WeakSet<Store>();

export async function ensureSnapshotsTable(store: Store): Promise<void> {
  if (ensuredStores.has(store)) return;
  await store.run(`
    CREATE TABLE IF NOT EXISTS edge_snapshots (
      snapshot_id VARCHAR PRIMARY KEY,
      schema_version INTEGER,
      captured_at VARCHAR,
      trade_date VARCHAR,
      symbol VARCHAR,
      kind VARCHAR,
      tf VARCHAR,
      engine_fingerprint VARCHAR,
      permalink VARCHAR,
      markdown_summary VARCHAR,
      payload_json VARCHAR
    )
  `);
  ensuredStores.add(store);
}

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function bpsToPct(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return "—";
  return `${(bps / 100).toFixed(2)}%`;
}

export function renderSnapshotMarkdown(snap: Omit<EdgeSnapshotV1, "markdownSummary">): string {
  const lines: string[] = [];
  lines.push(
    `### EdgeStats Snapshot · ${snap.symbol} (${snap.tf}) · ${snap.tradeDate}`,
  );
  lines.push(
    `> ID: \`${snap.snapshotId}\` · Captured: ${snap.capturedAt} · Fingerprint: \`${snap.engineFingerprint}\``,
  );

  if (snap.candleScience) {
    const cs = snap.candleScience;
    const src =
      cs.latest?.c2CloseSource === "cme_settlement"
        ? "CME settle"
        : cs.latest?.c2CloseSource === "1600_proxy"
          ? "16:00 proxy"
          : "close";
    lines.push("");
    lines.push(`#### Candle Science (N = ${cs.n}, mask = ${cs.activeMask})`);
    if (cs.latest) {
      lines.push(
        `- **C2 Close (${src}):** \`${cs.latest.c2.close.toFixed(2)}\` · **C3 Open:** \`${cs.latest.c3Open.toFixed(2)}\``,
      );
    }
    lines.push("| Metric | True | False |");
    lines.push("|---|---:|---:|");
    for (const o of cs.outcomes) {
      lines.push(
        `| ${o.label} | **${pct(o.estimate)}** (${o.k}) | ${pct(o.falseEstimate)} (${o.falseK}) |`,
      );
    }
    if (cs.projection) {
      const p = cs.projection;
      const b = p.bullCandle;
      const r = p.bearCandle;
      lines.push("");
      lines.push(
        `- **Bull C3 Scenario (${pct(b.rate)}, n=${b.n}):** Body +${bpsToPct(b.bodyBps)} · Upper Wick +${bpsToPct(b.upperWickBps)} · Lower Wick -${bpsToPct(b.lowerWickBps)} (O \`${b.open ?? "—"}\` → C \`${b.close ?? "—"}\`, H \`${b.high ?? "—"}\`, L \`${b.low ?? "—"}\`)`,
      );
      lines.push(
        `- **Bear C3 Scenario (${pct(r.rate)}, n=${r.n}):** Body -${bpsToPct(r.bodyBps)} · Upper Wick +${bpsToPct(r.upperWickBps)} · Lower Wick -${bpsToPct(r.lowerWickBps)} (O \`${r.open ?? "—"}\` → C \`${r.close ?? "—"}\`, H \`${r.high ?? "—"}\`, L \`${r.low ?? "—"}\`)`,
      );
      lines.push(
        `- **High Breakout (from C2H):** P30 \`${p.hiBreakoutP30Price ?? "—"}\` (+${bpsToPct(p.hiBreakoutP30Bps)}) · P50 \`${p.hiBreakoutP50Price ?? "—"}\` (+${bpsToPct(p.hiBreakoutP50Bps)}) · P70 \`${p.hiBreakoutP70Price ?? "—"}\` (+${bpsToPct(p.hiBreakoutP70Bps)})`,
      );
      lines.push(
        `- **Low Breakout (from C2L):** P30 \`${p.loBreakoutP30Price ?? "—"}\` (-${bpsToPct(p.loBreakoutP30Bps)}) · P50 \`${p.loBreakoutP50Price ?? "—"}\` (-${bpsToPct(p.loBreakoutP50Bps)}) · P70 \`${p.loBreakoutP70Price ?? "—"}\` (-${bpsToPct(p.loBreakoutP70Bps)})`,
      );
    }
  }

  if (snap.profiler) {
    const pr = snap.profiler;
    lines.push("");
    lines.push(`#### Daily Profiler — ${pr.targetSession.toUpperCase()} (N = ${pr.n})`);
    lines.push("| Status | Rate | 95% CI | Broken Rate |");
    lines.push("|---|---:|---|---:|");
    for (const o of pr.outcomes) {
      const ci = o.ci95 ? `[${pct(o.ci95[0])}, ${pct(o.ci95[1])}]` : "—";
      lines.push(`| ${o.status} | **${pct(o.estimate)}** (${o.n}) | ${ci} | ${pct(o.brokenRate)} |`);
    }
  }

  if (snap.note) {
    lines.push("");
    lines.push(`**Note:** ${snap.note}`);
  }
  lines.push("");
  lines.push(`_Historical conditional frequencies with sample sizes. Not predictions, not advice._`);
  return lines.join("\n");
}

export async function createEdgeSnapshot(
  store: Store,
  config: EdgeStatsConfig,
  req: CreateSnapshotRequest,
): Promise<EdgeSnapshotV1> {
  await ensureSnapshotsTable(store);
  const kind = req.kind ?? (req.candleScience && req.profiler ? "combined" : req.profiler ? "profiler" : "candle_science");
  const tf = req.tf ?? req.candleScience?.tf ?? "1d";

  const candleScience =
    kind === "candle_science" || kind === "combined"
      ? await runCandleScienceSuite(store, config, {
          symbol: req.symbol,
          tf,
          dims: req.candleScience?.dims as Partial<Record<CsDimName, boolean>> | undefined,
          whereDsl: req.candleScience?.whereDsl,
          since: req.candleScience?.since,
          until: req.candleScience?.until,
        })
      : null;

  const profiler =
    kind === "profiler" || kind === "combined"
      ? await runProfilerSuite(store, config, {
          symbol: req.symbol,
          targetSession: req.profiler?.targetSession ?? "ny1",
          filters: req.profiler?.filters,
          p12Scenario: req.profiler?.p12Scenario,
          brokenBroken: req.profiler?.brokenBroken,
          whereDsl: req.profiler?.whereDsl,
          since: req.profiler?.since,
          until: req.profiler?.until,
        })
      : null;

  const capturedAt = new Date().toISOString();
  const tradeDate =
    candleScience?.latest?.tradeDate?.replace(" (live)", "") ??
    profiler?.matchedDates[0] ??
    capturedAt.slice(0, 10);
  const fp = await store.fingerprint();
  const shortId = randomUUID().slice(0, 8);
  const snapshotId = `snap_${tradeDate.replaceAll("-", "")}_${req.symbol}_${tf}_${shortId}`;

  const params = new URLSearchParams({ symbol: req.symbol });
  if (candleScience) {
    params.set("tf", tf);
    if (candleScience.activeMask) {
      params.set("mask", String(candleScience.activeMask));
      params.set("exp", String(candleScience.expectedMask));
    }
    if (req.candleScience?.whereDsl) params.set("where", req.candleScience.whereDsl);
  }
  const permalink =
    kind === "profiler" ? `/profiler?${params.toString()}` : `/candle-science?${params.toString()}`;

  const base: Omit<EdgeSnapshotV1, "markdownSummary"> = {
    schemaVersion: 1,
    snapshotId,
    capturedAt,
    tradeDate,
    symbol: req.symbol,
    kind,
    tf,
    engineFingerprint: fp,
    permalink,
    note: req.note ?? null,
    candleScience,
    profiler,
  };
  const markdownSummary = renderSnapshotMarkdown(base);
  const full: EdgeSnapshotV1 = { ...base, markdownSummary };

  await store.run(`
    INSERT INTO edge_snapshots (
      snapshot_id, schema_version, captured_at, trade_date, symbol, kind, tf,
      engine_fingerprint, permalink, markdown_summary, payload_json
    ) VALUES (
      ${sqlStr(full.snapshotId)}, 1, ${sqlStr(full.capturedAt)}, ${sqlStr(full.tradeDate)},
      ${sqlStr(full.symbol)}, ${sqlStr(full.kind)}, ${sqlStr(full.tf)},
      ${sqlStr(full.engineFingerprint)}, ${sqlStr(full.permalink)},
      ${sqlStr(full.markdownSummary)}, ${sqlStr(JSON.stringify(full))}
    )
  `);

  return full;
}

export async function getEdgeSnapshot(
  store: Store,
  snapshotId: string,
): Promise<EdgeSnapshotV1 | null> {
  await ensureSnapshotsTable(store);
  const row = await store.one(
    `SELECT payload_json FROM edge_snapshots WHERE snapshot_id = ${sqlStr(snapshotId)}`,
  );
  const raw = asStr(row?.payload_json);
  return raw ? (JSON.parse(raw) as EdgeSnapshotV1) : null;
}

export async function listEdgeSnapshots(
  store: Store,
  opts: { symbol?: string; tradeDate?: string; limit?: number } = {},
): Promise<SnapshotSummaryItem[]> {
  await ensureSnapshotsTable(store);
  const conds: string[] = [];
  if (opts.symbol) conds.push(`symbol = ${sqlStr(opts.symbol)}`);
  if (opts.tradeDate) conds.push(`trade_date = ${sqlStr(opts.tradeDate)}`);
  const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const rows = await store.all(`
    SELECT snapshot_id, captured_at, trade_date, symbol, kind, tf, permalink
    FROM edge_snapshots
    ${where}
    ORDER BY captured_at DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    snapshotId: asStr(r.snapshot_id) ?? "",
    capturedAt: asStr(r.captured_at) ?? "",
    tradeDate: asStr(r.trade_date) ?? "",
    symbol: asStr(r.symbol) ?? "",
    kind: asStr(r.kind) ?? "",
    tf: asStr(r.tf) ?? "",
    permalink: asStr(r.permalink) ?? "",
  }));
}
