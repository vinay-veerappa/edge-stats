/*
  Candle Science v17.5 Workbench (/candle-science).
  16-dimension C1 -> C2 -> C3 structural classifier + MFE/MAE P30/P50/P70
  excursion boxes backed by crates/spine_wasm -> cs_candles (after=1 roll-safe).
*/
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { CandleScienceSuiteResult, CsDimName } from "@luxalgo/edge-stats";
import { api } from "../lib/api";
import { useCachedAsync } from "../lib/hooks";
import { cn } from "../lib/utils";

const DIM_GROUPS: { title: string; items: { key: CsDimName; label: string }[] }[] = [
  {
    title: "Direction (2)",
    items: [
      { key: "c1_bull", label: "C1 Bull" },
      { key: "c2_bull", label: "C2 Bull" },
    ],
  },
  {
    title: "C2 vs C1 (10)",
    items: [
      { key: "c2h_gt_c1h", label: "C2H > C1H" },
      { key: "c2h_gt_c1o", label: "C2H > C1O" },
      { key: "c2l_gt_c1l", label: "C2L > C1L" },
      { key: "c2l_gt_c1o", label: "C2L > C1O" },
      { key: "c2c_gt_c1h", label: "C2C > C1H" },
      { key: "c2c_gt_c1l", label: "C2C > C1L" },
      { key: "c2c_gt_c1c", label: "C2C > C1C" },
      { key: "c2c_gt_c1o", label: "C2C > C1O" },
      { key: "c2o_gt_c1c", label: "C2O > C1C" },
      { key: "c2o_gt_c1o", label: "C2O > C1O" },
    ],
  },
  {
    title: "C3 Open vs C2 (4)",
    items: [
      { key: "c3o_gt_c2c", label: "C3O > C2C" },
      { key: "c3o_gt_c2o", label: "C3O > C2O" },
      { key: "c3o_gt_c2h", label: "C3O > C2H" },
      { key: "c3o_gt_c2l", label: "C3O > C2L" },
    ],
  },
];

const PRESET_TIERS: Record<"minimal" | "standard" | "detailed" | "full", CsDimName[]> = {
  minimal: ["c1_bull", "c2_bull"],
  standard: [
    "c1_bull",
    "c2_bull",
    "c2h_gt_c1h",
    "c2l_gt_c1l",
    "c2c_gt_c1h",
    "c2c_gt_c1l",
    "c2c_gt_c1c",
    "c3o_gt_c2c",
  ],
  detailed: [
    "c1_bull",
    "c2_bull",
    "c2h_gt_c1h",
    "c2l_gt_c1l",
    "c2c_gt_c1h",
    "c2c_gt_c1l",
    "c2c_gt_c1c",
    "c2c_gt_c1o",
    "c3o_gt_c2c",
    "c3o_gt_c2o",
  ],
  full: DIM_GROUPS.flatMap((g) => g.items.map((i) => i.key)),
};

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function fmtCi(ci: [number, number] | null | undefined): string {
  if (!ci) return "—";
  return `[${(ci[0] * 100).toFixed(1)}%, ${(ci[1] * 100).toFixed(1)}%]`;
}

function fmtVal(bps: number | null | undefined, unit: "bps" | "%"): string {
  if (bps === null || bps === undefined) return "—";
  return unit === "bps" ? `${bps.toFixed(1)} bps` : `${(bps / 100).toFixed(2)}%`;
}

function fmtSigned(bps: number | null | undefined, unit: "bps" | "%"): string {
  if (bps === null || bps === undefined) return "—";
  const sign = bps > 0 ? "+" : "";
  return unit === "bps" ? `${sign}${bps.toFixed(1)} bps` : `${sign}${(bps / 100).toFixed(2)}%`;
}

type DiagramMode = "aligned" | "zoomout" | "ladder";

function CandleScienceDiagram({
  res,
  dims,
  liveActive,
  unit,
  svgRef,
  onDownloadPng,
}: {
  res: CandleScienceSuiteResult;
  dims: Partial<Record<CsDimName, boolean>>;
  liveActive: boolean;
  unit: "bps" | "%";
  svgRef: RefObject<SVGSVGElement | null>;
  onDownloadPng: () => void;
}) {
  const [mode, setMode] = useState<DiagramMode>("aligned");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);
  const latest = res.latest;
  const outByKey = new Map(res.outcomes.map((o) => [o.key, o]));
  const excByKey = new Map(res.excursions.map((e) => [e.key, e.distribution]));

  const filtersMatchLive =
    liveActive ||
    (latest !== null &&
      Object.entries(dims).every(([k, v]) => v === undefined || latest.dims[k as CsDimName] === v));
  const useRealPrices = Boolean(latest && filtersMatchLive);

  let c1: { open: number; high: number; low: number; close: number };
  let c2: { open: number; high: number; low: number; close: number };
  let c3O: number;

  if (useRealPrices && latest) {
    c1 = latest.c1;
    c2 = latest.c2;
    c3O = latest.c3Open;
  } else {
    // Construct synthetic C1/C2/C3O that faithfully respects active structural filters
    const c1Bull = dims.c1_bull ?? true;
    const c2Bull = dims.c2_bull ?? true;
    c1 = c1Bull
      ? { open: 99.4, high: 100.3, low: 99.1, close: 100.0 }
      : { open: 100.0, high: 100.3, low: 99.1, close: 99.4 };
    const shift = dims.c2h_gt_c1h === true ? 0.35 : dims.c2h_gt_c1h === false ? -0.35 : 0.0;
    c2 = c2Bull
      ? { open: 99.5 + shift, high: 100.45 + shift, low: 99.2 + shift, close: 100.15 + shift }
      : { open: 100.15 + shift, high: 100.45 + shift, low: 99.2 + shift, close: 99.5 + shift };
    const bodyHi = Math.max(c2.open, c2.close);
    const bodyLo = Math.min(c2.open, c2.close);
    if (dims.c3o_gt_c2h === true) c3O = c2.high + 0.14;
    else if (dims.c3o_gt_c2l === false) c3O = c2.low - 0.14;
    else if (dims.c3o_gt_c2c === true && dims.c3o_gt_c2o === false) c3O = (c2.open + c2.close) / 2;
    else if (dims.c3o_gt_c2c === false && dims.c3o_gt_c2o === true) c3O = (c2.open + c2.close) / 2;
    else if (dims.c3o_gt_c2c === true) c3O = Math.min(c2.high - 0.06, c2.close + 0.12);
    else if (dims.c3o_gt_c2c === false) c3O = Math.max(c2.low + 0.06, c2.close - 0.12);
    else if (dims.c3o_gt_c2o === true) c3O = Math.min(c2.high - 0.06, bodyHi + 0.06);
    else if (dims.c3o_gt_c2o === false) c3O = Math.max(c2.low + 0.06, bodyLo - 0.06);
    else c3O = c2.close;
  }

  const anchor = c2.close > 0 ? c2.close : c3O;
  const pBull = outByKey.get("c3_bull")?.estimate ?? 0.5;
  const pBear = outByKey.get("c3_bull")?.falseEstimate ?? 1 - pBull;
  const pHiBrk = outByKey.get("c3h_gt_c2h")?.estimate ?? 0;
  const pLoBrk = outByKey.get("c3l_lt_c2l")?.estimate ?? 0;
  const pCloseAboveC2H = outByKey.get("c3c_gt_c2h")?.estimate ?? 0;
  const pCloseAboveC2O = outByKey.get("c3c_gt_c2o")?.estimate ?? 0;
  const pCloseAboveC2C = outByKey.get("c3c_gt_c2c")?.estimate ?? 0;
  const pCloseAboveC2L = outByKey.get("c3c_gt_c2l")?.estimate ?? 0;

  const brkHi = excByKey.get("brk_hi");
  const brkLo = excByKey.get("brk_lo");
  const mfeL = excByKey.get("mfe_l");
  const mfeS = excByKey.get("mfe_s");

  // Empirical Bull (True) & Bear (False) median candle shapes anchored strictly at C3O
  const bullSc = res.scenarios?.bull;
  const bearSc = res.scenarios?.bear;
  const bullBodyBps = bullSc?.bodyBps ?? Math.max(25, (mfeL?.median ?? 60) * 0.58);
  const bullUwBps = bullSc?.upperWickBps ?? Math.max(10, (mfeL?.median ?? 60) * 0.35);
  const bullLwBps = bullSc?.lowerWickBps ?? Math.max(10, (mfeS?.median ?? 45) * 0.55);
  const bullCandle = {
    open: c3O,
    close: c3O + anchor * (bullBodyBps / 10000),
    high: c3O + anchor * ((bullBodyBps + bullUwBps) / 10000),
    low: c3O - anchor * (bullLwBps / 10000),
    bodyBps: bullBodyBps,
    uwBps: bullUwBps,
    lwBps: bullLwBps,
    n: bullSc?.n ?? 0,
  };

  const bearBodyBps = bearSc?.bodyBps ?? Math.max(25, (mfeS?.median ?? 60) * 0.58);
  const bearUwBps = bearSc?.upperWickBps ?? Math.max(10, (mfeL?.median ?? 45) * 0.55);
  const bearLwBps = bearSc?.lowerWickBps ?? Math.max(10, (mfeS?.median ?? 60) * 0.35);
  const bearCandle = {
    open: c3O,
    close: c3O - anchor * (bearBodyBps / 10000),
    high: c3O + anchor * (bearUwBps / 10000),
    low: c3O - anchor * ((bearBodyBps + bearLwBps) / 10000),
    bodyBps: bearBodyBps,
    uwBps: bearUwBps,
    lwBps: bearLwBps,
    n: bearSc?.n ?? 0,
  };

  const hiBandP30 = brkHi?.p30 !== undefined ? c2.high + anchor * (brkHi.p30 / 10000) : null;
  const hiBandP50 = brkHi?.median !== undefined ? c2.high + anchor * (brkHi.median / 10000) : null;
  const hiBandP70 = brkHi?.p70 !== undefined ? c2.high + anchor * (brkHi.p70 / 10000) : null;
  const loBandP30 = brkLo?.p30 !== undefined ? c2.low - anchor * (brkLo.p30 / 10000) : null;
  const loBandP50 = brkLo?.median !== undefined ? c2.low - anchor * (brkLo.median / 10000) : null;
  const loBandP70 = brkLo?.p70 !== undefined ? c2.low - anchor * (brkLo.p70 / 10000) : null;

  const W = 940;
  const H = expanded ? 740 : 450;
  const top = expanded ? 62 : 52;
  const bot = expanded ? 52 : 44;

  // Layout geometry per mode:
  // - aligned: C1 in compact left strip (own scale), C2 + C3 Bull + C3 Bear share ONE exact Y-scale!
  // - zoomout: C1 + C2 + C3 Bull + C3 Bear ALL share ONE unified 1:1 Y-scale!
  // - ladder: C2 (slim ref) + C3 Bull + C3 Bear + zoomed P30/P50/P70 boxes share ONE exact Y-scale (no C1 strip)
  const showC1Strip = mode === "aligned";
  const splitX = showC1Strip ? 140 : 0;

  const sharedPrices = [
    ...(mode === "zoomout" ? [c1.high, c1.low] : []),
    c2.high,
    c2.low,
    c2.open,
    c2.close,
    c3O,
    bullCandle.high,
    bullCandle.low,
    bearCandle.high,
    bearCandle.low,
    ...(hiBandP70 !== null ? [hiBandP70] : []),
    ...(loBandP70 !== null ? [loBandP70] : []),
  ];
  const sMin = Math.min(...sharedPrices);
  const sMax = Math.max(...sharedPrices);
  const sPad = Math.max((sMax - sMin) * 0.08, anchor * 0.001);
  const yShared = (p: number) =>
    top + ((sMax + sPad - p) / Math.max(1e-6, sMax - sMin + 2 * sPad)) * (H - top - bot);

  const c1Pad = Math.max((c1.high - c1.low) * 0.14, anchor * 0.001);
  const yC1 = (p: number) =>
    mode === "zoomout"
      ? yShared(p)
      : top + ((c1.high + c1Pad - p) / Math.max(1e-6, c1.high - c1.low + 2 * c1Pad)) * (H - top - bot);

  const x1 = mode === "zoomout" ? 72 : 70;
  const x2 = mode === "zoomout" ? 185 : mode === "aligned" ? 215 : 85;
  const xBull = mode === "ladder" ? 565 : 610;
  const xBear = mode === "ladder" ? 725 : 760;
  const labelLeftX = x2 + 36;
  const labelW = xBull - labelLeftX - 44;
  const lineRightX = W - 82;
  const fs = expanded ? 12.5 : 10.5;
  const fsSmall = expanded ? 11.5 : 9.8;
  const candleW = expanded ? 54 : 44;

  const drawCandle = (
    key: string,
    x: number,
    bw: number,
    yFn: (p: number) => number,
    o: number,
    h: number,
    l: number,
    c: number,
    label: string,
    sub: string,
    opts?: { dashed?: boolean; opacity?: number; highlight?: boolean },
  ) => {
    const bull = c >= o;
    const op = opts?.opacity ?? 1;
    const fill = bull
      ? `rgba(20, 184, 166, ${opts?.highlight ? 0.44 : 0.30})`
      : `rgba(244, 63, 94, ${opts?.highlight ? 0.44 : 0.30})`;
    const stroke = bull ? "#14b8a6" : "#f43f5e";
    const bodyTop = yFn(Math.max(o, c));
    const bodyBot = yFn(Math.min(o, c));
    const bodyH = Math.max(5, bodyBot - bodyTop);
    return (
      <g key={key} opacity={op}>
        <line x1={x} x2={x} y1={yFn(h)} y2={yFn(l)} stroke={stroke} strokeWidth={expanded ? 2.8 : 2.2} />
        <rect
          x={x - bw / 2}
          y={bodyTop}
          width={bw}
          height={bodyH}
          rx={3}
          fill={fill}
          stroke={stroke}
          strokeWidth={opts?.highlight ? 2.4 : 1.7}
          strokeDasharray={opts?.dashed ? "5,3" : undefined}
        />
        <text
          x={x}
          y={H - 14}
          textAnchor="middle"
          fill={opts?.highlight ? "#ffffff" : "rgba(255,255,255,0.85)"}
          fontSize={fs}
          fontFamily="monospace"
          fontWeight={opts?.highlight ? "700" : "600"}
        >
          {label}
        </text>
        <text
          x={x}
          y={expanded ? 42 : 34}
          textAnchor="middle"
          fill="rgba(255,255,255,0.68)"
          fontSize={fsSmall}
          fontFamily="monospace"
        >
          {sub}
        </text>
      </g>
    );
  };

  // Reference lines directly aligned to C2 OHLC & C3O
  const c2GapBps = ((c3O - c2.close) / anchor) * 10000;
  const ladderLevels = [
    {
      key: "c2h",
      price: c2.high,
      color: "#6ee7b7",
      text: `C2H · Brk ${fmtPct(pHiBrk)} / Hold ${fmtPct(1 - pHiBrk)} · Cls> ${fmtPct(pCloseAboveC2H)}`,
    },
    {
      key: "c2o",
      price: c2.open,
      color: "#cbd5e1",
      text: `C2O · Cls> ${fmtPct(pCloseAboveC2O)} / <= ${fmtPct(1 - pCloseAboveC2O)}`,
    },
    {
      key: "c2c",
      price: c2.close,
      color: "#93c5fd",
      text: `C2C · Cls> ${fmtPct(pCloseAboveC2C)} / <= ${fmtPct(1 - pCloseAboveC2C)}`,
    },
    {
      key: "c3o",
      price: c3O,
      color: "#fde047",
      text: `C3O Open (${fmtSigned(c2GapBps, unit)} vs C2C)`,
    },
    {
      key: "c2l",
      price: c2.low,
      color: "#fda4af",
      text: `C2L · Brk ${fmtPct(pLoBrk)} / Hold ${fmtPct(1 - pLoBrk)} · Cls> ${fmtPct(pCloseAboveC2L)}`,
    },
  ];

  const minGap = expanded ? 28 : 20;
  const sortedLadder = ladderLevels
    .map((lv) => ({ ...lv, rawY: yShared(lv.price), labelY: yShared(lv.price) }))
    .sort((a, b) => a.rawY - b.rawY);
  for (let i = 1; i < sortedLadder.length; i++) {
    if (sortedLadder[i]!.labelY - sortedLadder[i - 1]!.labelY < minGap) {
      sortedLadder[i]!.labelY = sortedLadder[i - 1]!.labelY + minGap;
    }
  }

  const bullStronger = pBull >= pBear;

  const cardBody = (
    <div
      className={cn(
        "rounded-xl border border-border p-4",
        expanded
          ? "fixed inset-4 z-50 flex flex-col bg-[#0b0e14] p-5 shadow-2xl"
          : "bg-white/[0.02]",
      )}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium text-foreground">
            C2 ↔ C3 Dual-Outcome Structure ({useRealPrices ? latest?.tradeDate : "Filtered Pattern"})
          </span>
          <span className="font-mono text-[11px] text-emerald-300">
            Bull {fmtPct(pBull)} (Body +{fmtVal(bullCandle.bodyBps, unit)})
          </span>
          <span className="font-mono text-[11px] text-rose-300">
            Bear {fmtPct(pBear)} (Body -{fmtVal(bearCandle.bodyBps, unit)})
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-border bg-white/[0.02] p-0.5 font-mono text-[11px]">
            {(
              [
                { id: "aligned", label: "Aligned (C2 ↔ C3)" },
                { id: "zoomout", label: "Zoom-Out (1:1 C1–C3)" },
                { id: "ladder", label: "Zoomed Ladder" },
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                className={cn(
                  "rounded-md px-2 py-0.5 transition-colors",
                  mode === m.id
                    ? "bg-white/[0.11] text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          {expanded && (
            <button
              type="button"
              onClick={onDownloadPng}
              className="rounded-lg border border-border bg-white/[0.04] px-2.5 py-1 font-mono text-[11px] text-muted-foreground hover:bg-white/[0.09] hover:text-foreground"
            >
              PNG
            </button>
          )}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="rounded-lg border border-border bg-white/[0.04] px-2.5 py-1 font-mono text-[11px] text-muted-foreground hover:bg-white/[0.09] hover:text-foreground"
            title={expanded ? "Exit fullscreen (Esc)" : "Expand diagram to fullscreen"}
          >
            {expanded ? "Close (Esc)" : "Expand ⤢"}
          </button>
        </div>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        className={cn("w-full select-none", expanded ? "min-h-0 flex-1" : "h-[420px]")}
      >
        <rect x={0} y={0} width={W} height={H} fill="#0b0e14" rx={8} />

        {/* Optional C1 side divider in aligned mode */}
        {showC1Strip && (
          <>
            <line
              x1={splitX}
              x2={splitX}
              y1={12}
              y2={H - 12}
              stroke="rgba(255,255,255,0.12)"
              strokeDasharray="4,4"
            />
            <text
              x={splitX / 2}
              y={13}
              textAnchor="middle"
              fill="rgba(255,255,255,0.34)"
              fontSize="9.5"
              fontFamily="monospace"
            >
              C1 CONTEXT
            </text>
          </>
        )}

        <text
          x={(splitX + lineRightX) / 2}
          y={13}
          textAnchor="middle"
          fill="rgba(255,255,255,0.34)"
          fontSize="9.5"
          fontFamily="monospace"
        >
          {mode === "zoomout"
            ? `UNIFIED 1:1 SCALE · C1 → C2 → BOTH C3 OUTCOMES (${unit})`
            : `SHARED 1:1 Y-SCALE · C2 ALIGNED DIRECTLY TO BOTH C3 OUTCOMES (${unit})`}
        </text>

        {/* Contained zone shading between C2H and C2L across C2 -> C3 */}
        <rect
          x={x2}
          y={yShared(c2.high)}
          width={lineRightX - x2}
          height={Math.max(4, yShared(c2.low) - yShared(c2.high))}
          fill="rgba(148, 163, 184, 0.045)"
        />

        {/* High Breakout P30 -> P70 shaded box spanning both C3 scenarios */}
        {hiBandP30 !== null && hiBandP70 !== null && (
          <g>
            <rect
              x={xBull - 44}
              y={Math.min(yShared(hiBandP70), yShared(hiBandP30))}
              width={xBear - xBull + 88}
              height={Math.max(8, Math.abs(yShared(hiBandP30) - yShared(hiBandP70)))}
              fill="rgba(16, 185, 129, 0.14)"
              stroke="rgba(16, 185, 129, 0.45)"
              strokeWidth={1}
              rx={3}
            />
            {hiBandP50 !== null && (
              <line
                x1={xBull - 44}
                x2={xBear + 44}
                y1={yShared(hiBandP50)}
                y2={yShared(hiBandP50)}
                stroke="#34d399"
                strokeWidth={1.2}
                strokeDasharray="3,2"
              />
            )}
            <text
              x={xBear + 50}
              y={(yShared(hiBandP70) + yShared(hiBandP30)) / 2 + 3}
              fill="#6ee7b7"
              fontSize="10"
              fontFamily="monospace"
            >
              +{fmtVal(brkHi?.p30, unit)}→+{fmtVal(brkHi?.p70, unit)}
            </text>
          </g>
        )}

        {/* Low Breakout P30 -> P70 shaded box spanning both C3 scenarios */}
        {loBandP30 !== null && loBandP70 !== null && (
          <g>
            <rect
              x={xBull - 44}
              y={Math.min(yShared(loBandP30), yShared(loBandP70))}
              width={xBear - xBull + 88}
              height={Math.max(8, Math.abs(yShared(loBandP70) - yShared(loBandP30)))}
              fill="rgba(244, 63, 94, 0.14)"
              stroke="rgba(244, 63, 94, 0.45)"
              strokeWidth={1}
              rx={3}
            />
            {loBandP50 !== null && (
              <line
                x1={xBull - 44}
                x2={xBear + 44}
                y1={yShared(loBandP50)}
                y2={yShared(loBandP50)}
                stroke="#fb7185"
                strokeWidth={1.2}
                strokeDasharray="3,2"
              />
            )}
            <text
              x={xBear + 50}
              y={(yShared(loBandP30) + yShared(loBandP70)) / 2 + 3}
              fill="#fda4af"
              fontSize="10"
              fontFamily="monospace"
            >
              -{fmtVal(brkLo?.p30, unit)}→-{fmtVal(brkLo?.p70, unit)}
            </text>
          </g>
        )}

        {/* Horizontal aligned reference lines running straight from C2 across to BOTH C3 candles */}
        {sortedLadder.map((lv) => (
          <g key={lv.key}>
            <line
              x1={x2}
              x2={lineRightX}
              y1={lv.rawY}
              y2={lv.rawY}
              stroke={lv.key === "c3o" ? "rgba(250, 204, 21, 0.65)" : "rgba(255,255,255,0.16)"}
              strokeWidth={lv.key === "c3o" ? 1.4 : 1}
              strokeDasharray={lv.key === "c3o" ? "3,2" : "3,4"}
            />
            {/* Leader tick when pill was nudged vertically to prevent overlap */}
            {Math.abs(lv.labelY - lv.rawY) > 2 && (
              <line
                x1={labelLeftX - 6}
                x2={labelLeftX}
                y1={lv.rawY}
                y2={lv.labelY - 5}
                stroke={lv.color}
                strokeWidth={0.9}
                opacity={0.55}
              />
            )}
            <rect
              x={labelLeftX}
              y={lv.labelY - (expanded ? 15 : 12)}
              width={Math.max(220, labelW)}
              height={expanded ? 21 : 16}
              rx={3}
              fill="rgba(11, 14, 20, 0.9)"
            />
            <text
              x={labelLeftX + 6}
              y={lv.labelY}
              fill={lv.color}
              fontSize={fsSmall}
              fontFamily="monospace"
            >
              {lv.text}
            </text>
            {useRealPrices && (
              <text
                x={W - 6}
                y={lv.rawY + 4}
                textAnchor="end"
                fill={lv.color}
                fontSize={fsSmall}
                fontFamily="monospace"
              >
                {lv.price.toFixed(1)}
              </text>
            )}
          </g>
        ))}

        {/* C1 -> C2 connector in zoomout mode */}
        {mode === "zoomout" && (
          <line
            x1={x1 + 24}
            y1={yC1(c1.close)}
            x2={x2 - 24}
            y2={yShared(c2.open)}
            stroke="#facc15"
            strokeWidth={1.2}
            strokeDasharray="4,4"
            opacity={0.65}
          />
        )}

        {/* C2C -> C3O explicit alignment anchor dots */}
        <circle cx={x2 + 24} cy={yShared(c2.close)} r={3} fill="#93c5fd" />
        <circle cx={xBull - 28} cy={yShared(c3O)} r={3} fill="#fde047" />
        <circle cx={xBear - 28} cy={yShared(c3O)} r={3} fill="#fde047" />

        {/* C1 candle (in aligned + zoomout modes) */}
        {mode !== "ladder" &&
          drawCandle(
            "c1",
            x1,
            candleW - 4,
            yC1,
            c1.open,
            c1.high,
            c1.low,
            c1.close,
            "C1",
            c1.close >= c1.open ? "Bull" : "Bear",
          )}

        {/* C2 candle — ALWAYS on yShared so C2H/C2O/C2C/C2L align 1:1 with C3 */}
        {drawCandle(
          "c2",
          x2,
          mode === "ladder" ? 36 : candleW,
          yShared,
          c2.open,
          c2.high,
          c2.low,
          c2.close,
          "C2",
          c2.close >= c2.open ? "Bull" : "Bear",
        )}

        {/* TRUE Possibility: Empirical Median Bullish C3 Candle anchored at C3O */}
        {drawCandle(
          "c3_bull",
          xBull,
          candleW,
          yShared,
          bullCandle.open,
          bullCandle.high,
          bullCandle.low,
          bullCandle.close,
          `TRUE · Bull ${fmtPct(pBull)}`,
          `UW +${fmtVal(bullCandle.uwBps, unit)} · B +${fmtVal(bullCandle.bodyBps, unit)}`,
          { dashed: true, opacity: bullStronger ? 1 : 0.72, highlight: bullStronger },
        )}
        <text
          x={xBull}
          y={Math.min(H - 32, yShared(bullCandle.low) + 15)}
          textAnchor="middle"
          fill="#6ee7b7"
          fontSize={fsSmall}
          fontFamily="monospace"
          opacity={bullStronger ? 0.95 : 0.7}
        >
          LW -{fmtVal(bullCandle.lwBps, unit)}
        </text>

        {/* FALSE Possibility: Empirical Median Bearish C3 Candle anchored at C3O */}
        {drawCandle(
          "c3_bear",
          xBear,
          candleW,
          yShared,
          bearCandle.open,
          bearCandle.high,
          bearCandle.low,
          bearCandle.close,
          `FALSE · Bear ${fmtPct(pBear)}`,
          `UW +${fmtVal(bearCandle.uwBps, unit)} · B -${fmtVal(bearCandle.bodyBps, unit)}`,
          { dashed: true, opacity: !bullStronger ? 1 : 0.72, highlight: !bullStronger },
        )}
        <text
          x={xBear}
          y={Math.min(H - 32, yShared(bearCandle.low) + 15)}
          textAnchor="middle"
          fill="#fda4af"
          fontSize={fsSmall}
          fontFamily="monospace"
          opacity={!bullStronger ? 0.95 : 0.7}
        >
          LW -{fmtVal(bearCandle.lwBps, unit)}
        </text>
      </svg>
    </div>
  );

  return (
    <>
      {expanded && (
        <div
          className="fixed inset-0 z-40 bg-black/75 backdrop-blur-sm"
          onClick={() => setExpanded(false)}
        />
      )}
      {cardBody}
    </>
  );
}

export function CandleSciencePage() {
  const symbolsQuery = useCachedAsync("symbols", (signal) => api.symbols(signal));
  const symbols = symbolsQuery.data?.symbols ?? [];
  const [symbol, setSymbol] = useState<string>("");
  const [tf, setTf] = useState<"1d" | "4h" | "1h" | "15m">("1d");
  const [dims, setDims] = useState<Partial<Record<CsDimName, boolean>>>({
    c1_bull: true,
    c2_bull: true,
  });
  const [whereDsl, setWhereDsl] = useState<string>("");
  const [unit, setUnit] = useState<"bps" | "%">("%");
  const [res, setRes] = useState<CandleScienceSuiteResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol && symbols.length > 0) {
      const nq = symbols.find((s) => s.symbol === "NQ1");
      setSymbol(nq ? nq.symbol : symbols[0]!.symbol);
    }
  }, [symbol, symbols]);

  useEffect(() => {
    if (!symbol) return;
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    api
      .candleScienceSuite(
        {
          symbol,
          tf,
          dims,
          whereDsl: whereDsl.trim() || undefined,
        },
        ac.signal,
      )
      .then(setRes)
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [symbol, tf, dims, whereDsl]);

  const [liveTier, setLiveTier] = useState<"minimal" | "standard" | "detailed" | "full">("standard");
  const [liveActive, setLiveActive] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 2800);
  };

  // Restore shared permalink query params on mount (?symbol=...&tf=...&mask=...&exp=...&where=...)
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const s = sp.get("symbol");
    const t = sp.get("tf") as "1d" | "4h" | "1h" | "15m" | null;
    const w = sp.get("where");
    const maskStr = sp.get("mask");
    const expStr = sp.get("exp");
    if (s) setSymbol(s);
    if (t && ["1d", "4h", "1h", "15m"].includes(t)) setTf(t);
    if (w) setWhereDsl(w);
    if (maskStr) {
      const m = Number(maskStr);
      const e = Number(expStr ?? "0");
      const allDims = PRESET_TIERS.full;
      const restored: Partial<Record<CsDimName, boolean>> = {};
      for (let i = 0; i < allDims.length; i++) {
        if ((m & (1 << i)) !== 0) restored[allDims[i]!] = (e & (1 << i)) !== 0;
      }
      setDims(restored);
    }
  }, []);

  const copyMarkdown = async () => {
    if (!res) return;
    const lines = [
      `### Candle Science · ${res.symbol} (${res.tf}) · ${res.latest?.tradeDate ?? ""} · N=${res.n}`,
      ...(res.latest
        ? [`- C2C: \`${res.latest.c2.close.toFixed(2)}\` · C3O: \`${res.latest.c3Open.toFixed(2)}\``]
        : []),
      "| Metric | True | False |",
      "|---|---:|---:|",
      ...res.outcomes.map(
        (o) => `| ${o.label} | **${fmtPct(o.estimate)}** (${o.k}) | ${fmtPct(o.falseEstimate)} (${o.falseK}) |`,
      ),
      ...(res.projection
        ? [
            `- High Breakout: P30 \`${res.projection.hiBreakoutP30Price ?? "—"}\` (+${fmtVal(res.projection.hiBreakoutP30Bps, unit)}) · P50 \`${res.projection.hiBreakoutP50Price ?? "—"}\` · P70 \`${res.projection.hiBreakoutP70Price ?? "—"}\` (+${fmtVal(res.projection.hiBreakoutP70Bps, unit)})`,
            `- Low Breakout: P30 \`${res.projection.loBreakoutP30Price ?? "—"}\` (-${fmtVal(res.projection.loBreakoutP30Bps, unit)}) · P50 \`${res.projection.loBreakoutP50Price ?? "—"}\` · P70 \`${res.projection.loBreakoutP70Price ?? "—"}\` (-${fmtVal(res.projection.loBreakoutP70Bps, unit)})`,
          ]
        : []),
    ];
    await navigator.clipboard.writeText(lines.join("\n"));
    flash("Copied Markdown to clipboard");
  };

  const copyLink = async () => {
    if (!res) return;
    const sp = new URLSearchParams({ symbol: res.symbol, tf: res.tf });
    if (res.activeMask) {
      sp.set("mask", String(res.activeMask));
      sp.set("exp", String(res.expectedMask));
    }
    if (whereDsl.trim()) sp.set("where", whereDsl.trim());
    const url = `${window.location.origin}/candle-science?${sp.toString()}`;
    await navigator.clipboard.writeText(url);
    flash("Copied shareable link");
  };

  const downloadPng = () => {
    const svg = svgRef.current;
    if (!svg || !res) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 2160;
      canvas.height = 860;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#0b0e14";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const a = document.createElement("a");
        a.download = `candle-science-${res.symbol}-${res.tf}.png`;
        a.href = canvas.toDataURL("image/png");
        a.click();
      }
      URL.revokeObjectURL(url);
      flash("Downloaded PNG");
    };
    img.src = url;
  };

  const saveSnapshot = async () => {
    if (!res) return;
    try {
      const snap = await api.createSnapshot({
        symbol: res.symbol,
        kind: "candle_science",
        tf: res.tf as "1d" | "4h" | "1h" | "15m",
        candleScience: {
          tf: res.tf as "1d" | "4h" | "1h" | "15m",
          dims,
          whereDsl: whereDsl.trim() || undefined,
        },
      });
      await navigator.clipboard.writeText(snap.snapshotId).catch(() => {});
      flash(`Saved ${snap.snapshotId} (ID copied)`);
    } catch (err: unknown) {
      flash(`Snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const cycleDim = (k: CsDimName) => {
    setLiveActive(false);
    setDims((prev) => {
      const cur = prev[k];
      const next = { ...prev };
      if (cur === undefined) next[k] = true;
      else if (cur === true) next[k] = false;
      else delete next[k];
      return next;
    });
  };

  const applyLatestPreset = (tier: "minimal" | "standard" | "detailed" | "full") => {
    const latest = res?.latest;
    if (!latest) return;
    setLiveTier(tier);
    setLiveActive(true);
    const next: Partial<Record<CsDimName, boolean>> = {};
    for (const k of PRESET_TIERS[tier]) {
      next[k] = latest.dims[k];
    }
    setDims(next);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Candle Science (v17.5)</h1>
          <p className="text-sm text-muted-foreground">
            16-dimension C1 → C2 → C3 probabilities & P30 / P50 / P70 target/reversal boxes (roll-safe after=1).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!res?.latest}
            onClick={() => applyLatestPreset(liveTier)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40",
              liveActive
                ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-300"
                : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20",
            )}
            title="Auto-fill filters from the latest C1 -> C2 -> C3O signature (current forming bar excluded from historical N)"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Live ({liveTier})
          </button>
          <select
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className="rounded-lg border border-border bg-white/[0.03] px-3 py-1.5 font-mono text-xs"
          >
            {symbols.map((s) => (
              <option key={s.symbol} value={s.symbol} className="bg-zinc-900">
                {s.symbol}
              </option>
            ))}
          </select>
          <div className="flex rounded-lg border border-border bg-white/[0.02] p-0.5">
            {(["1d", "4h", "1h", "15m"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTf(t)}
                className={cn(
                  "rounded-md px-2.5 py-1 font-mono text-xs",
                  tf === t ? "bg-white/[0.09] text-foreground" : "text-muted-foreground",
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setUnit((u) => (u === "bps" ? "%" : "bps"))}
            className="rounded-lg border border-border bg-white/[0.03] px-2.5 py-1.5 font-mono text-xs"
          >
            Unit: {unit}
          </button>
          <button
            type="button"
            disabled={!res}
            onClick={() => void copyMarkdown()}
            className="rounded-lg border border-border bg-white/[0.03] px-2.5 py-1.5 text-xs hover:bg-white/[0.08] disabled:opacity-40"
          >
            Copy MD
          </button>
          <button
            type="button"
            disabled={!res}
            onClick={() => void copyLink()}
            className="rounded-lg border border-border bg-white/[0.03] px-2.5 py-1.5 text-xs hover:bg-white/[0.08] disabled:opacity-40"
          >
            Copy Link
          </button>
          <button
            type="button"
            disabled={!res}
            onClick={downloadPng}
            className="rounded-lg border border-border bg-white/[0.03] px-2.5 py-1.5 text-xs hover:bg-white/[0.08] disabled:opacity-40"
          >
            PNG
          </button>
          <button
            type="button"
            disabled={!res}
            onClick={() => void saveSnapshot()}
            className="rounded-lg border border-blue-500/40 bg-blue-500/15 px-2.5 py-1.5 text-xs font-medium text-blue-300 hover:bg-blue-500/25 disabled:opacity-40"
          >
            Save Snapshot
          </button>
        </div>
      </div>

      {toast && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 font-mono text-xs text-emerald-300">
          {toast}
        </div>
      )}

      {/* Preset Auto-Detect & 16-Dimension Toggle Matrix */}
      <div className="space-y-4 rounded-xl border border-border bg-white/[0.02] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-faint">Match Latest ({res?.latest?.tradeDate ?? "—"}):</span>
            {(["minimal", "standard", "detailed", "full"] as const).map((tier) => (
              <button
                key={tier}
                type="button"
                disabled={!res?.latest}
                onClick={() => applyLatestPreset(tier)}
                className="rounded-full border border-border bg-white/[0.04] px-2.5 py-1 text-xs capitalize hover:bg-white/[0.08] disabled:opacity-40"
              >
                {tier}
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setLiveActive(false);
                setDims({});
              }}
              className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Clear All
            </button>
          </div>
          {res && (
            <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
              {res.latest && (
                <span className="text-[11px] text-muted-foreground">
                  C2C={res.latest.c2.close.toFixed(2)} (
                  {res.latest.c2CloseSource === "cme_settlement"
                    ? "CME settle"
                    : res.latest.c2CloseSource === "1600_proxy"
                      ? "16:00 proxy"
                      : "close"}
                  ) · C3O={res.latest.c3Open.toFixed(2)}
                </span>
              )}
              <span>N = {res.n}</span>
              {res.guards.lowSample && (
                <span className="rounded bg-amber-500/20 px-2 py-0.5 text-amber-300">
                  Low N (&lt;{res.guards.warnFloor})
                </span>
              )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {DIM_GROUPS.map((g) => (
            <div key={g.title} className="space-y-2">
              <div className="text-[11px] font-medium uppercase tracking-wider text-faint">
                {g.title}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {g.items.map((item) => {
                  const val = dims[item.key];
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => cycleDim(item.key)}
                      className={cn(
                        "rounded-md border px-2 py-1 font-mono text-[11px] transition-colors",
                        val === true
                          ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
                          : val === false
                            ? "border-rose-500/50 bg-rose-500/15 text-rose-300"
                            : "border-border bg-white/[0.02] text-muted-foreground hover:text-foreground",
                      )}
                      title="Click to cycle: Any -> True -> False -> Any"
                    >
                      {item.label}: {val === true ? "T" : val === false ? "F" : "·"}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-faint">WHERE</span>
          <input
            value={whereDsl}
            onChange={(e) => setWhereDsl(e.target.value)}
            placeholder="Cross-condition with Profiler or Events, e.g. brokenBroken OR sessionStatus(asia, LT)"
            className="w-full rounded-lg border border-border bg-white/[0.03] px-3 py-1.5 font-mono text-xs placeholder:text-faint"
          />
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
          {error}
        </div>
      )}

      {loading && !res && (
        <div className="p-8 text-center text-sm text-muted-foreground">Computing Candle Science…</div>
      )}

      {res && (
        <div className="space-y-6">
          {/* Graphical Split-Scale C1->C2 Context + Zoomed C3 Target Ladder */}
          <CandleScienceDiagram
            res={res}
            dims={dims}
            liveActive={liveActive}
            unit={unit}
            svgRef={svgRef}
            onDownloadPng={downloadPng}
          />

          {/* Dual True vs False C3 Probability Cards */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {res.outcomes.map((o) => {
              const tPct = (o.estimate ?? 0) * 100;
              return (
                <div key={o.key} className="rounded-xl border border-border bg-white/[0.02] p-4">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-emerald-300">{o.label}</span>
                    <span className="text-right text-rose-300">{o.falseLabel}</span>
                  </div>
                  <div className="mt-2 flex items-baseline justify-between font-mono">
                    <div>
                      <span className="text-xl font-semibold text-emerald-300">
                        {fmtPct(o.estimate)}
                      </span>
                      <span className="ml-1.5 text-[11px] text-faint">({o.k})</span>
                    </div>
                    <div className="text-right">
                      <span className="mr-1.5 text-[11px] text-faint">({o.falseK})</span>
                      <span className="text-xl font-semibold text-rose-300">
                        {fmtPct(o.falseEstimate)}
                      </span>
                    </div>
                  </div>
                  <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-rose-500/40">
                    <div className="h-full bg-emerald-400" style={{ width: `${tPct}%` }} />
                  </div>
                  <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-muted-foreground">
                    <span>T CI {fmtCi(o.ci95)}</span>
                    <span>
                      {o.stability?.agree === true
                        ? "Stable"
                        : o.stability?.agree === false
                          ? "Drifted"
                          : "—"}
                    </span>
                    <span>F CI {fmtCi(o.falseCi95)}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Breakout vs Contained Excursion Percentile Table (P30 CTQ / P50 Box / P70 Reversal Limit) */}
          <div className="overflow-x-auto rounded-xl border border-border bg-white/[0.02]">
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <span className="text-xs font-medium">
                Excursion Envelopes ({unit} of C2 Close) — P30 CTQ · P50 Median · P70 Reversal Limit
              </span>
              <span className="font-mono text-[11px] text-faint">{res.disclaimer}</span>
            </div>
            <table className="w-full text-left font-mono text-xs">
              <thead className="border-b border-border text-[11px] text-faint">
                <tr>
                  <th className="px-4 py-2">Distribution</th>
                  <th className="px-3 py-2">N</th>
                  <th className="px-3 py-2">P10</th>
                  <th className="px-3 py-2 text-emerald-300">P30 (CTQ)</th>
                  <th className="px-3 py-2 text-blue-300">P50 (Med)</th>
                  <th className="px-3 py-2 text-amber-300">P70 (Rev)</th>
                  <th className="px-3 py-2">P90</th>
                  <th className="px-3 py-2">P95</th>
                </tr>
              </thead>
              <tbody>
                {res.excursions.map((e) => {
                  const d = e.distribution;
                  return (
                    <tr key={e.key} className="border-b border-border/50">
                      <td className="px-4 py-2 font-sans text-xs">{e.label}</td>
                      <td className="px-3 py-2 text-faint">{d?.count ?? 0}</td>
                      <td className="px-3 py-2 text-muted-foreground">{fmtVal(d?.p10, unit)}</td>
                      <td className="px-3 py-2 font-medium text-emerald-300">
                        {fmtVal(d?.p30, unit)}
                      </td>
                      <td className="px-3 py-2 font-semibold text-blue-300">
                        {fmtVal(d?.median, unit)}
                      </td>
                      <td className="px-3 py-2 font-medium text-amber-300">
                        {fmtVal(d?.p70, unit)}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{fmtVal(d?.p90, unit)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{fmtVal(d?.p95, unit)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
