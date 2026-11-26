/*
  Daily Profiler Workbench (/profiler).
  Sequential Asia -> London -> NY1 -> NY2 causal conditioning backed by
  crates/spine_wasm -> daily_context + daily_paths_5m. Includes context-aware
  Live auto-filter, mirrored HOD/LOD & False/Broken timing histograms,
  Range Distribution histograms, 20 Level Touches, Composite Price Model,
  Expandable full-viewport charts, and Copy/Link/Snapshot toolbar.
*/
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type {
  ProfilerLiveContext,
  ProfilerPriceModelResult,
  ProfilerRangeBin,
  ProfilerSessionFilter,
  ProfilerSessionTimeBucket,
  ProfilerSuiteResult,
  ProfilerTargetSession,
  ProfilerTimeBucket,
} from "@luxalgo/edge-stats";
import { api } from "../lib/api";
import { useCachedAsync } from "../lib/hooks";
import { cn } from "../lib/utils";

const TARGETS: { id: ProfilerTargetSession; label: string }[] = [
  { id: "asia", label: "Asia" },
  { id: "london", label: "London" },
  { id: "ny1", label: "NY1" },
  { id: "ny2", label: "NY2" },
  { id: "daily", label: "Daily" },
];

type PriorKey = "prev_ny1" | "prev_ny2" | "asia" | "london" | "ny1" | "ny2";

const PRIOR_MAP: Record<ProfilerTargetSession, PriorKey[]> = {
  asia: ["prev_ny1", "prev_ny2"],
  london: ["prev_ny2", "asia"],
  ny1: ["prev_ny2", "asia", "london"],
  ny2: ["prev_ny2", "asia", "london", "ny1"],
  daily: ["prev_ny1", "prev_ny2", "asia", "london", "ny1", "ny2"],
};

const PRIOR_LABELS: Record<PriorKey, string> = {
  prev_ny1: "Prev NY1",
  prev_ny2: "Prev NY2",
  asia: "Asia",
  london: "London",
  ny1: "NY1",
  ny2: "NY2",
};

const STATUSES = ["Any", "LT", "LF", "ST", "SF", "None"] as const;

type TimeWindow = "full" | "overnight" | "rth" | "ny";

const TIME_WINDOWS: Record<TimeWindow, { label: string; minOff: number; maxOff: number }> = {
  full: { label: "Full Day (18:00–17:00)", minOff: 0, maxOff: 1380 },
  overnight: { label: "Overnight (18:00–07:30)", minOff: 0, maxOff: 810 },
  ny: { label: "NY1–NY2 (07:30–16:00)", minOff: 810, maxOff: 1320 },
  rth: { label: "RTH (08:30–16:00)", minOff: 870, maxOff: 1320 },
};

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function fmtCi(ci: [number, number] | null | undefined): string {
  if (!ci) return "—";
  return `[${(ci[0] * 100).toFixed(1)}%, ${(ci[1] * 100).toFixed(1)}%]`;
}

function fmtUnit(bpsVal: number | null | undefined, unit: "bps" | "%"): string {
  if (bpsVal === null || bpsVal === undefined) return "—";
  return unit === "bps" ? `${bpsVal.toFixed(1)} bps` : `${(bpsVal / 100).toFixed(2)}%`;
}

function fmtOffsetMin(min: number | null | undefined): string {
  if (min === null || min === undefined) return "—";
  const total = (18 * 60 + Math.round(min)) % 1440;
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")} ET`;
}

/** Build causally-valid prior filters from live context for the chosen target session. */
function buildLiveFiltersForTarget(
  live: ProfilerLiveContext,
  target: ProfilerTargetSession,
): {
  filters: Partial<Record<PriorKey, ProfilerSessionFilter>>;
  p12Scenario: string;
  brokenBroken: "any" | "yes" | "no";
} {
  const filters: Partial<Record<PriorKey, ProfilerSessionFilter>> = {};
  const add = (k: PriorKey, status: string | null, broken: boolean | null) => {
    if (status && status !== "None") {
      filters[k] = {
        status,
        broken: broken === true ? "yes" : broken === false ? "no" : undefined,
      };
    }
  };

  if (target === "asia") {
    add("prev_ny1", live.prevNy1Status, live.prevNy1Broken);
    add("prev_ny2", live.prevNy2Status, live.prevNy2Broken);
    return { filters, p12Scenario: "Any", brokenBroken: "any" };
  }
  if (target === "london") {
    add("prev_ny2", live.prevNy2Status, live.prevNy2Broken);
    add("asia", live.asiaStatus, live.asiaBroken);
    return { filters, p12Scenario: "Any", brokenBroken: "any" };
  }
  if (target === "ny1") {
    add("asia", live.asiaStatus, live.asiaBroken);
    add("london", live.londonStatus, live.londonBroken);
    return {
      filters,
      p12Scenario: live.p12Scenario ?? "Any",
      brokenBroken: live.brokenBroken === true ? "yes" : live.brokenBroken === false ? "no" : "any",
    };
  }
  if (target === "ny2") {
    add("asia", live.asiaStatus, live.asiaBroken);
    add("london", live.londonStatus, live.londonBroken);
    add("ny1", live.ny1Status, live.ny1Broken);
    return {
      filters,
      p12Scenario: live.p12Scenario ?? "Any",
      brokenBroken: live.brokenBroken === true ? "yes" : live.brokenBroken === false ? "no" : "any",
    };
  }
  // Daily target: apply only sessions strictly before currentSession
  const sessOrder = ["asia", "london", "ny1", "ny2", "post_ny2"] as const;
  const curIdx = sessOrder.indexOf(live.currentSession);
  if (curIdx <= 0) {
    add("prev_ny1", live.prevNy1Status, live.prevNy1Broken);
    add("prev_ny2", live.prevNy2Status, live.prevNy2Broken);
  }
  if (curIdx >= 1) add("asia", live.asiaStatus, live.asiaBroken);
  if (curIdx >= 2) add("london", live.londonStatus, live.londonBroken);
  if (curIdx >= 3) add("ny1", live.ny1Status, live.ny1Broken);
  if (curIdx >= 4) add("ny2", live.ny2Status, live.ny2Broken);
  return {
    filters,
    p12Scenario: curIdx >= 2 && live.p12Scenario ? live.p12Scenario : "Any",
    brokenBroken:
      curIdx >= 2
        ? live.brokenBroken === true
          ? "yes"
          : live.brokenBroken === false
            ? "no"
            : "any"
        : "any",
  };
}

function ExpandableCard({
  title,
  subtitle,
  controls,
  children,
}: {
  title: string;
  subtitle?: string;
  controls?: ReactNode;
  children: (expanded: boolean) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  return (
    <>
      {expanded && (
        <div
          className="fixed inset-0 z-40 bg-black/75 backdrop-blur-sm"
          onClick={() => setExpanded(false)}
        />
      )}
      <div
        className={cn(
          "rounded-xl border border-border p-4",
          expanded
            ? "fixed inset-4 z-50 flex flex-col bg-[#0b0e14] p-5 shadow-2xl"
            : "bg-white/[0.02]",
        )}
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="font-medium text-foreground">{title}</span>
            {subtitle && <span className="font-mono text-[11px] text-muted-foreground">{subtitle}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {controls}
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="rounded-lg border border-border bg-white/[0.04] px-2.5 py-1 font-mono text-[11px] text-muted-foreground hover:bg-white/[0.09] hover:text-foreground"
            >
              {expanded ? "Close (Esc)" : "Expand ⤢"}
            </button>
          </div>
        </div>
        <div className={cn(expanded ? "flex min-h-0 flex-1 flex-col" : "")}>{children(expanded)}</div>
      </div>
    </>
  );
}

/** Mirrored HOD (green up) / LOD (red down) Time-of-Day Histogram with zoom window + hover + Expand. */
function HodLodHistogram({
  buckets,
  n,
  bucketMinutes,
  onBucketChange,
}: {
  buckets: ProfilerTimeBucket[];
  n: number;
  bucketMinutes: 5 | 15 | 30 | 60;
  onBucketChange: (b: 5 | 15 | 30 | 60) => void;
}) {
  const [win, setWin] = useState<TimeWindow>("full");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const spec = TIME_WINDOWS[win];
  const visible = useMemo(
    () => buckets.filter((b) => b.bucketMin >= spec.minOff && b.bucketMin < spec.maxOff),
    [buckets, spec],
  );

  const maxRate = Math.max(0.05, ...visible.map((b) => Math.max(b.hodRate, b.lodRate)));
  const topHod = useMemo(
    () => [...visible].sort((a, b) => b.hodCount - a.hodCount)[0],
    [visible],
  );
  const topLod = useMemo(
    () => [...visible].sort((a, b) => b.lodCount - a.lodCount)[0],
    [visible],
  );

  const hovered = hoverIdx !== null ? visible[hoverIdx] : null;

  return (
    <ExpandableCard
      title="HOD / LOD Time-of-Day Histogram (ET)"
      subtitle={
        hovered
          ? `${hovered.etLabel} ET · HOD ${fmtPct(hovered.hodRate)} (${hovered.hodCount}) · LOD ${fmtPct(hovered.lodRate)} (${hovered.lodCount})`
          : `N=${n} · Peak HOD: ${topHod?.etLabel ?? "—"} (${fmtPct(topHod?.hodRate)}) · Peak LOD: ${topLod?.etLabel ?? "—"} (${fmtPct(topLod?.lodRate)})`
      }
      controls={
        <>
          <div className="flex items-center gap-0.5 rounded-lg border border-border bg-white/[0.02] p-0.5 font-mono text-[11px]">
            {(Object.keys(TIME_WINDOWS) as TimeWindow[]).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWin(w)}
                className={cn(
                  "rounded-md px-2 py-0.5",
                  win === w ? "bg-white/[0.11] text-foreground" : "text-muted-foreground",
                )}
              >
                {w === "full" ? "Full" : w === "overnight" ? "ON" : w === "ny" ? "NY1–2" : "RTH"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-0.5 rounded-lg border border-border bg-white/[0.02] p-0.5 font-mono text-[11px]">
            {([5, 15, 30, 60] as const).map((bm) => (
              <button
                key={bm}
                type="button"
                onClick={() => onBucketChange(bm)}
                className={cn(
                  "rounded-md px-1.5 py-0.5",
                  bucketMinutes === bm ? "bg-white/[0.11] text-foreground" : "text-muted-foreground",
                )}
              >
                {bm}m
              </button>
            ))}
          </div>
        </>
      }
    >
      {(expanded) => {
        const W = 940;
        const H = expanded ? 620 : 300;
        const pad = { t: 24, r: 20, b: 36, l: 48 };
        const midY = pad.t + (H - pad.t - pad.b) / 2;
        const halfH = (H - pad.t - pad.b) / 2 - 8;
        const plotW = W - pad.l - pad.r;
        const barStep = visible.length > 0 ? plotW / visible.length : 10;
        const barW = Math.max(2, barStep * 0.78);
        const labelEvery = Math.max(1, Math.ceil(visible.length / 16));

        return (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="xMidYMid meet"
            className={cn("w-full select-none", expanded ? "min-h-0 flex-1" : "h-72")}
            onMouseLeave={() => setHoverIdx(null)}
          >
            <rect x={0} y={0} width={W} height={H} fill="#0b0e14" rx={6} />
            {/* Zero baseline */}
            <line x1={pad.l} x2={W - pad.r} y1={midY} y2={midY} stroke="rgba(255,255,255,0.22)" />
            {/* Y-axis labels */}
            <text x={pad.l - 6} y={pad.t + 10} textAnchor="end" fill="#6ee7b7" fontSize="10" fontFamily="monospace">
              +{(maxRate * 100).toFixed(0)}%
            </text>
            <text x={pad.l - 6} y={midY + 3} textAnchor="end" fill="rgba(255,255,255,0.45)" fontSize="10" fontFamily="monospace">
              0%
            </text>
            <text x={pad.l - 6} y={H - pad.b - 2} textAnchor="end" fill="#fda4af" fontSize="10" fontFamily="monospace">
              {(maxRate * 100).toFixed(0)}%
            </text>

            {/* Key ET reference markers (00:00 Midnight, 09:30 RTH Open) */}
            {[
              { label: "00:00", color: "#94a3b8" },
              { label: "09:30", color: "#f59e0b" },
              { label: "11:30", color: "#60a5fa" },
            ].map((mk) => {
              const idx = visible.findIndex((b) => b.etLabel === mk.label);
              if (idx < 0) return null;
              const x = pad.l + idx * barStep + barStep / 2;
              return (
                <g key={mk.label}>
                  <line
                    x1={x}
                    x2={x}
                    y1={pad.t}
                    y2={H - pad.b}
                    stroke={mk.color}
                    strokeDasharray="3,3"
                    opacity={0.65}
                  />
                  <text x={x + 3} y={pad.t + 10} fill={mk.color} fontSize="9.5" fontFamily="monospace">
                    {mk.label}
                  </text>
                </g>
              );
            })}

            {/* Bars */}
            {visible.map((b, i) => {
              const x = pad.l + i * barStep + (barStep - barW) / 2;
              const hH = (b.hodRate / maxRate) * halfH;
              const lH = (b.lodRate / maxRate) * halfH;
              const isHov = hoverIdx === i;
              return (
                <g key={b.bucketMin} onMouseEnter={() => setHoverIdx(i)}>
                  <rect
                    x={pad.l + i * barStep}
                    y={pad.t}
                    width={barStep}
                    height={H - pad.t - pad.b}
                    fill={isHov ? "rgba(255,255,255,0.06)" : "transparent"}
                  />
                  {hH > 0 && (
                    <rect
                      x={x}
                      y={midY - hH}
                      width={barW}
                      height={hH}
                      fill={isHov ? "#34d399" : "rgba(16,185,129,0.75)"}
                      rx={1.5}
                    />
                  )}
                  {lH > 0 && (
                    <rect
                      x={x}
                      y={midY}
                      width={barW}
                      height={lH}
                      fill={isHov ? "#fb7185" : "rgba(244,63,94,0.75)"}
                      rx={1.5}
                    />
                  )}
                  {i % labelEvery === 0 && (
                    <text
                      x={x + barW / 2}
                      y={H - 12}
                      textAnchor="middle"
                      fill="rgba(255,255,255,0.5)"
                      fontSize="9.5"
                      fontFamily="monospace"
                    >
                      {b.etLabel}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        );
      }}
    </ExpandableCard>
  );
}

/** Single-series histogram for False Moves, Session Breaks, or Range High/Low Distributions. */
function SimpleHistogramCard({
  title,
  subtitle,
  bars,
  color,
  hoverColor,
  medianLabel,
}: {
  title: string;
  subtitle: string;
  bars: { key: string; label: string; count: number; rate: number }[];
  color: string;
  hoverColor: string;
  medianLabel?: string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const maxRate = Math.max(0.05, ...bars.map((b) => b.rate));
  const hov = hoverIdx !== null ? bars[hoverIdx] : null;

  return (
    <ExpandableCard
      title={title}
      subtitle={
        hov
          ? `${hov.label} · ${fmtPct(hov.rate)} (${hov.count} days)`
          : `${subtitle}${medianLabel ? ` · Med ${medianLabel}` : ""}`
      }
    >
      {(expanded) => {
        if (bars.length === 0) {
          return (
            <div className="p-6 text-center text-xs text-muted-foreground">No observations matched.</div>
          );
        }
        const W = 900;
        const H = expanded ? 560 : 210;
        const pad = { t: 18, r: 16, b: 34, l: 44 };
        const plotW = W - pad.l - pad.r;
        const plotH = H - pad.t - pad.b;
        const step = plotW / bars.length;
        const bw = Math.max(3, step * 0.78);
        const labelEvery = Math.max(1, Math.ceil(bars.length / 12));

        return (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="xMidYMid meet"
            className={cn("w-full select-none", expanded ? "min-h-0 flex-1" : "h-48")}
            onMouseLeave={() => setHoverIdx(null)}
          >
            <rect x={0} y={0} width={W} height={H} fill="#0b0e14" rx={6} />
            <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="rgba(255,255,255,0.16)" />
            <text x={pad.l - 6} y={pad.t + 10} textAnchor="end" fill="rgba(255,255,255,0.5)" fontSize="10" fontFamily="monospace">
              {(maxRate * 100).toFixed(0)}%
            </text>
            <text x={pad.l - 6} y={H - pad.b} textAnchor="end" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="monospace">
              0%
            </text>
            {bars.map((b, i) => {
              const x = pad.l + i * step + (step - bw) / 2;
              const bh = (b.rate / maxRate) * plotH;
              const isHov = hoverIdx === i;
              return (
                <g key={b.key} onMouseEnter={() => setHoverIdx(i)}>
                  <rect
                    x={pad.l + i * step}
                    y={pad.t}
                    width={step}
                    height={plotH}
                    fill={isHov ? "rgba(255,255,255,0.06)" : "transparent"}
                  />
                  <rect
                    x={x}
                    y={H - pad.b - bh}
                    width={bw}
                    height={bh}
                    fill={isHov ? hoverColor : color}
                    rx={2}
                  />
                  {i % labelEvery === 0 && (
                    <text
                      x={x + bw / 2}
                      y={H - 12}
                      textAnchor="middle"
                      fill="rgba(255,255,255,0.5)"
                      fontSize="9.5"
                      fontFamily="monospace"
                    >
                      {b.label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        );
      }}
    </ExpandableCard>
  );
}

function PriceModelCard({
  data,
  unit,
  anchor,
  onAnchorChange,
}: {
  data: ProfilerPriceModelResult;
  unit: "bps" | "%";
  anchor: "daily_open" | "prev_close";
  onAnchorChange: (a: "daily_open" | "prev_close") => void;
}) {
  const [win, setWin] = useState<TimeWindow>("full");
  const spec = TIME_WINDOWS[win];
  const minBidx = Math.floor(spec.minOff / 5);
  const maxBidx = Math.ceil(spec.maxOff / 5);
  const pts = useMemo(
    () => data.points.filter((p) => p.bucketIdx >= minBidx && p.bucketIdx <= maxBidx),
    [data.points, minBidx, maxBidx],
  );

  return (
    <ExpandableCard
      title="Composite 5m Price Model (Median + IQR P25–P75)"
      subtitle={`N=${data.n} · Anchor: ${anchor === "daily_open" ? "Daily Open" : "Prev Close"}`}
      controls={
        <>
          <div className="flex items-center gap-0.5 rounded-lg border border-border bg-white/[0.02] p-0.5 font-mono text-[11px]">
            {(Object.keys(TIME_WINDOWS) as TimeWindow[]).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWin(w)}
                className={cn(
                  "rounded-md px-2 py-0.5",
                  win === w ? "bg-white/[0.11] text-foreground" : "text-muted-foreground",
                )}
              >
                {w === "full" ? "Full" : w === "overnight" ? "ON" : w === "ny" ? "NY1–2" : "RTH"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => onAnchorChange(anchor === "daily_open" ? "prev_close" : "daily_open")}
            className="rounded-lg border border-border bg-white/[0.03] px-2 py-0.5 font-mono text-[11px]"
          >
            {anchor === "daily_open" ? "Open" : "PrevCls"}
          </button>
        </>
      }
    >
      {(expanded) => {
        if (pts.length === 0) {
          return (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No 5-minute composite path data matched these filters.
            </div>
          );
        }
        const W = 940;
        const H = expanded ? 620 : 300;
        const pad = { t: 22, r: 22, b: 32, l: 62 };
        const ys = pts.flatMap((p) => [p.p25CloseBps, p.p75CloseBps, p.medianHighBps, p.medianLowBps]);
        const yMin = Math.min(...ys, -10);
        const yMax = Math.max(...ys, 10);
        const xSpan = Math.max(1, maxBidx - minBidx);
        const xOf = (bidx: number) => pad.l + ((bidx - minBidx) / xSpan) * (W - pad.l - pad.r);
        const yOf = (val: number) =>
          pad.t + ((yMax - val) / Math.max(1e-6, yMax - yMin)) * (H - pad.t - pad.b);

        const linePath = (getter: (p: (typeof pts)[number]) => number) =>
          pts
            .map((p, i) => `${i === 0 ? "M" : "L"}${xOf(p.bucketIdx).toFixed(1)},${yOf(getter(p)).toFixed(1)}`)
            .join(" ");

        const bandPath =
          pts.map((p, i) => `${i === 0 ? "M" : "L"}${xOf(p.bucketIdx).toFixed(1)},${yOf(p.p75CloseBps).toFixed(1)}`).join(" ") +
          " " +
          [...pts]
            .reverse()
            .map((p) => `L${xOf(p.bucketIdx).toFixed(1)},${yOf(p.p25CloseBps).toFixed(1)}`)
            .join(" ") +
          " Z";

        const markers = [
          { bidx: 0, label: "18:00" },
          { bidx: 72, label: "00:00" },
          { bidx: 102, label: "02:30" },
          { bidx: 162, label: "07:30" },
          { bidx: 186, label: "09:30" },
          { bidx: 210, label: "11:30" },
          { bidx: 264, label: "16:00" },
        ].filter((m) => m.bidx >= minBidx && m.bidx <= maxBidx);

        return (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="xMidYMid meet"
            className={cn("w-full select-none", expanded ? "min-h-0 flex-1" : "h-72")}
          >
            <rect x={0} y={0} width={W} height={H} fill="#0b0e14" rx={6} />
            <line
              x1={pad.l}
              x2={W - pad.r}
              y1={yOf(0)}
              y2={yOf(0)}
              stroke="rgba(255,255,255,0.22)"
              strokeDasharray="3,3"
            />
            {markers.map((m) => (
              <g key={m.label}>
                <line
                  x1={xOf(m.bidx)}
                  x2={xOf(m.bidx)}
                  y1={pad.t}
                  y2={H - pad.b}
                  stroke="rgba(255,255,255,0.1)"
                  strokeDasharray="2,4"
                />
                <text
                  x={xOf(m.bidx)}
                  y={H - 10}
                  textAnchor="middle"
                  fill="rgba(255,255,255,0.5)"
                  fontSize="10"
                  fontFamily="monospace"
                >
                  {m.label}
                </text>
              </g>
            ))}
            {[yMax, 0, yMin].map((v, i) => (
              <text
                key={i}
                x={pad.l - 6}
                y={yOf(v) + 3}
                textAnchor="end"
                fill="rgba(255,255,255,0.5)"
                fontSize="10"
                fontFamily="monospace"
              >
                {fmtUnit(v, unit)}
              </text>
            ))}
            <path d={bandPath} fill="rgba(59,130,246,0.18)" />
            <path d={linePath((p) => p.medianHighBps)} fill="none" stroke="rgba(16,185,129,0.6)" strokeWidth="1.2" />
            <path d={linePath((p) => p.medianLowBps)} fill="none" stroke="rgba(244,63,94,0.6)" strokeWidth="1.2" />
            <path d={linePath((p) => p.medianCloseBps)} fill="none" stroke="#60a5fa" strokeWidth="2.2" />
          </svg>
        );
      }}
    </ExpandableCard>
  );
}

export function ProfilerPage() {
  const symbolsQuery = useCachedAsync("symbols", (signal) => api.symbols(signal));
  const symbols = symbolsQuery.data?.symbols ?? [];
  const [symbol, setSymbol] = useState<string>("");
  const [targetSession, setTargetSession] = useState<ProfilerTargetSession>("ny1");
  const [filters, setFilters] = useState<Partial<Record<PriorKey, ProfilerSessionFilter>>>({});
  const [p12Scenario, setP12Scenario] = useState<string>("Any");
  const [brokenBroken, setBrokenBroken] = useState<"any" | "yes" | "no">("any");
  const [whereDsl, setWhereDsl] = useState<string>("");
  const [bucketMinutes, setBucketMinutes] = useState<5 | 15 | 30 | 60>(15);
  const [anchor, setAnchor] = useState<"daily_open" | "prev_close">("daily_open");
  const [unit, setUnit] = useState<"bps" | "%">("%");
  const [tab, setTab] = useState<"outcomes" | "timing" | "levels" | "price-model">("outcomes");

  const [liveCtx, setLiveCtx] = useState<ProfilerLiveContext | null>(null);
  const [liveActive, setLiveActive] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const [suite, setSuite] = useState<ProfilerSuiteResult | null>(null);
  const [priceModel, setPriceModel] = useState<ProfilerPriceModelResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 2800);
  };

  useEffect(() => {
    if (!symbol && symbols.length > 0) {
      const nq = symbols.find((s) => s.symbol === "NQ1");
      setSymbol(nq ? nq.symbol : symbols[0]!.symbol);
    }
  }, [symbol, symbols]);

  // Restore shared permalink params (?symbol=...&target=...&p12=...&bb=...&where=...)
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const s = sp.get("symbol");
    const t = sp.get("target") as ProfilerTargetSession | null;
    const p12 = sp.get("p12");
    const bb = sp.get("bb") as "any" | "yes" | "no" | null;
    const w = sp.get("where");
    if (s) setSymbol(s);
    if (t && ["asia", "london", "ny1", "ny2", "daily"].includes(t)) setTargetSession(t);
    if (p12) setP12Scenario(p12);
    if (bb && ["any", "yes", "no"].includes(bb)) setBrokenBroken(bb);
    if (w) setWhereDsl(w);
  }, []);

  // Fetch live profiler context whenever symbol changes
  useEffect(() => {
    if (!symbol) return;
    const ac = new AbortController();
    api
      .liveContext(symbol, ac.signal)
      .then((res) => setLiveCtx(res.daily))
      .catch(() => {});
    return () => ac.abort();
  }, [symbol]);

  // When Live mode is active, switching Target Session (Asia/London/NY1/NY2/Daily)
  // automatically re-applies ONLY the causally prior live sessions for that target!
  useEffect(() => {
    if (!liveActive || !liveCtx) return;
    const applied = buildLiveFiltersForTarget(liveCtx, targetSession);
    setFilters(applied.filters);
    setP12Scenario(applied.p12Scenario);
    setBrokenBroken(applied.brokenBroken);
  }, [liveActive, liveCtx, targetSession]);

  const toggleLive = () => {
    if (!liveCtx) return;
    if (liveActive) {
      setLiveActive(false);
      return;
    }
    setLiveActive(true);
    const applied = buildLiveFiltersForTarget(liveCtx, targetSession);
    setFilters(applied.filters);
    setP12Scenario(applied.p12Scenario);
    setBrokenBroken(applied.brokenBroken);
    flash(`Live (${liveCtx.tradeDate} · ${liveCtx.currentSession.toUpperCase()}) applied for ${targetSession.toUpperCase()}`);
  };

  const activePriors = PRIOR_MAP[targetSession];

  const payload = useMemo(() => {
    const cleanFilters: Partial<Record<PriorKey, ProfilerSessionFilter>> = {};
    for (const k of activePriors) {
      const f = filters[k];
      if (f && ((f.status && f.status !== "Any") || f.broken)) {
        cleanFilters[k] = f;
      }
    }
    return {
      symbol,
      targetSession,
      filters: cleanFilters,
      p12Scenario: p12Scenario === "Any" ? undefined : p12Scenario,
      brokenBroken: brokenBroken === "any" ? undefined : brokenBroken === "yes",
      whereDsl: whereDsl.trim() || undefined,
      bucketMinutes,
    };
  }, [symbol, targetSession, activePriors, filters, p12Scenario, brokenBroken, whereDsl, bucketMinutes]);

  useEffect(() => {
    if (!symbol) return;
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all([
      api.profilerSuite(payload, ac.signal),
      tab === "price-model"
        ? api.profilerPriceModel(
            { ...payload, bucketMinutes: bucketMinutes === 60 ? 30 : bucketMinutes, anchor },
            ac.signal,
          )
        : Promise.resolve(null),
    ])
      .then(([s, pm]) => {
        setSuite(s);
        if (pm) setPriceModel(pm);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [symbol, payload, tab, bucketMinutes, anchor]);

  const copyMarkdown = async () => {
    if (!suite) return;
    const lines = [
      `### Daily Profiler · ${suite.symbol} · Target ${suite.targetSession.toUpperCase()} · N=${suite.n}`,
      ...(liveCtx ? [`- Live Context: \`${liveCtx.tradeDate}\` (Active: ${liveCtx.currentSession.toUpperCase()}) · P12=${liveCtx.p12Scenario ?? "—"}`] : []),
      "| Status | Rate | N | Broken Rate |",
      "|---|---:|---:|---:|",
      ...suite.outcomes.map(
        (o) => `| ${o.status} | **${fmtPct(o.estimate)}** | ${o.n} | ${fmtPct(o.brokenRate)} |`,
      ),
      `- Daily High Med: \`${fmtUnit(suite.dailyHighDist?.median, unit)}\` · Daily Low Med: \`${fmtUnit(suite.dailyLowDist?.median, unit)}\` · Daily Range Med: \`${fmtUnit(suite.dailyRangeDist?.median, unit)}\``,
    ];
    await navigator.clipboard.writeText(lines.join("\n"));
    flash("Copied Markdown to clipboard");
  };

  const copyLink = async () => {
    if (!suite) return;
    const sp = new URLSearchParams({ symbol: suite.symbol, target: suite.targetSession });
    if (p12Scenario !== "Any") sp.set("p12", p12Scenario);
    if (brokenBroken !== "any") sp.set("bb", brokenBroken);
    if (whereDsl.trim()) sp.set("where", whereDsl.trim());
    await navigator.clipboard.writeText(`${window.location.origin}/profiler?${sp.toString()}`);
    flash("Copied shareable link");
  };

  const saveSnapshot = async () => {
    if (!suite) return;
    try {
      const snap = await api.createSnapshot({
        symbol: suite.symbol,
        kind: "profiler",
        profiler: {
          targetSession: suite.targetSession,
          filters: payload.filters,
          p12Scenario: payload.p12Scenario,
          brokenBroken: payload.brokenBroken,
          whereDsl: payload.whereDsl,
        },
      });
      await navigator.clipboard.writeText(snap.snapshotId).catch(() => {});
      flash(`Saved ${snap.snapshotId} (ID copied)`);
    } catch (err: unknown) {
      flash(`Snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const falseBars = useMemo(
    () =>
      (suite?.sessionTimeBuckets ?? [])
        .filter((b: ProfilerSessionTimeBucket) => b.falseCount > 0)
        .map((b) => ({ key: `f_${b.bucketMin}`, label: b.etLabel, count: b.falseCount, rate: b.falseRate })),
    [suite],
  );
  const brokenBars = useMemo(
    () =>
      (suite?.sessionTimeBuckets ?? [])
        .filter((b: ProfilerSessionTimeBucket) => b.brokenCount > 0)
        .map((b) => ({ key: `b_${b.bucketMin}`, label: b.etLabel, count: b.brokenCount, rate: b.brokenRate })),
    [suite],
  );
  const highRangeBars = useMemo(
    () =>
      (suite?.highRangeBins ?? []).map((b: ProfilerRangeBin) => ({
        key: `h_${b.binBps}`,
        label: b.label,
        count: b.count,
        rate: b.rate,
      })),
    [suite],
  );
  const lowRangeBars = useMemo(
    () =>
      (suite?.lowRangeBins ?? []).map((b: ProfilerRangeBin) => ({
        key: `l_${b.binBps}`,
        label: b.label,
        count: b.count,
        rate: b.rate,
      })),
    [suite],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Daily Profiler</h1>
          <p className="text-sm text-muted-foreground">
            Causal Spine sequential session conditioning (Asia → London → NY1 → NY2) with timing & range histograms.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!liveCtx}
            onClick={toggleLive}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40",
              liveActive
                ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-300"
                : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20",
            )}
            title="Auto-apply causally completed live prior sessions for the selected Target Session (updates dynamically as you switch Asia/London/NY1/NY2)"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Live {liveCtx ? `(${liveCtx.tradeDate} · ${liveCtx.currentSession.toUpperCase()})` : ""}
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
          <button
            type="button"
            onClick={() => {
              setLiveActive(false);
              setFilters({});
              setP12Scenario("Any");
              setBrokenBroken("any");
              setWhereDsl("");
            }}
            className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={() => setUnit((u) => (u === "bps" ? "%" : "bps"))}
            className="rounded-lg border border-border bg-white/[0.03] px-2.5 py-1.5 font-mono text-xs"
          >
            Unit: {unit}
          </button>
          <button
            type="button"
            disabled={!suite}
            onClick={() => void copyMarkdown()}
            className="rounded-lg border border-border bg-white/[0.03] px-2.5 py-1.5 text-xs hover:bg-white/[0.08] disabled:opacity-40"
          >
            Copy MD
          </button>
          <button
            type="button"
            disabled={!suite}
            onClick={() => void copyLink()}
            className="rounded-lg border border-border bg-white/[0.03] px-2.5 py-1.5 text-xs hover:bg-white/[0.08] disabled:opacity-40"
          >
            Copy Link
          </button>
          <button
            type="button"
            disabled={!suite}
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

      {/* Target Session + Causal Prior Filter Strip */}
      <div className="space-y-3 rounded-xl border border-border bg-white/[0.02] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-faint">Target:</span>
          {TARGETS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTargetSession(t.id)}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                targetSession === t.id
                  ? "bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/40"
                  : "bg-white/[0.04] text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2 text-xs">
            <span className="text-faint">P12:</span>
            <select
              value={p12Scenario}
              onChange={(e) => {
                setLiveActive(false);
                setP12Scenario(e.target.value);
              }}
              className="rounded-md border border-border bg-white/[0.03] px-2 py-1 font-mono text-xs"
            >
              {["Any", "1", "2", "3", "4", "5"].map((s) => (
                <option key={s} value={s} className="bg-zinc-900">
                  {s === "Any" ? "Any" : `Scen ${s}`}
                </option>
              ))}
            </select>
            <span className="text-faint">Broken-Broken:</span>
            <select
              value={brokenBroken}
              onChange={(e) => {
                setLiveActive(false);
                setBrokenBroken(e.target.value as "any" | "yes" | "no");
              }}
              className="rounded-md border border-border bg-white/[0.03] px-2 py-1 font-mono text-xs"
            >
              <option value="any" className="bg-zinc-900">Any</option>
              <option value="yes" className="bg-zinc-900">Yes</option>
              <option value="no" className="bg-zinc-900">No</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {activePriors.map((k) => {
            const cur = filters[k] ?? {};
            return (
              <div
                key={k}
                className="flex items-center justify-between gap-2 rounded-lg border border-border/70 bg-white/[0.02] px-3 py-2"
              >
                <span className="text-xs font-medium">{PRIOR_LABELS[k]}</span>
                <div className="flex items-center gap-1.5">
                  <select
                    value={cur.status ?? "Any"}
                    onChange={(e) => {
                      setLiveActive(false);
                      setFilters((prev) => ({
                        ...prev,
                        [k]: { ...prev[k], status: e.target.value },
                      }));
                    }}
                    className="rounded border border-border bg-zinc-900 px-1.5 py-0.5 font-mono text-[11px]"
                  >
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <select
                    value={cur.broken ?? "any"}
                    onChange={(e) => {
                      setLiveActive(false);
                      const val = e.target.value;
                      setFilters((prev) => ({
                        ...prev,
                        [k]: {
                          ...prev[k],
                          broken: val === "any" ? undefined : (val as "yes" | "no"),
                        },
                      }));
                    }}
                    className="rounded border border-border bg-zinc-900 px-1.5 py-0.5 font-mono text-[11px]"
                  >
                    <option value="any">Brk: Any</option>
                    <option value="yes">Broken</option>
                    <option value="no">Held</option>
                  </select>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-faint">WHERE</span>
          <input
            value={whereDsl}
            onChange={(e) => setWhereDsl(e.target.value)}
            placeholder="Optional EdgeStats DSL filter, e.g. NOT eventDay('FOMC') AND dayOfWeek = Tue"
            className="w-full rounded-lg border border-border bg-white/[0.03] px-3 py-1.5 font-mono text-xs placeholder:text-faint"
          />
        </div>
      </div>

      {/* Sub-tabs + Sample Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-lg border border-border bg-white/[0.02] p-1">
          {(
            [
              ["outcomes", "Outcomes & Range"],
              ["timing", "Timing Histograms"],
              ["levels", "20 Level Touches"],
              ["price-model", "Composite Price Model"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                tab === id ? "bg-white/[0.09] text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {suite && (
          <div className="flex items-center gap-3 font-mono text-xs">
            <span>N = {suite.n}</span>
            {suite.guards.lowSample && (
              <span className="rounded bg-amber-500/20 px-2 py-0.5 text-amber-300">
                Low N (&lt;{suite.guards.warnFloor})
              </span>
            )}
            <span className="text-[11px] text-faint">{suite.disclaimer}</span>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
          {error}
        </div>
      )}

      {loading && !suite && (
        <div className="p-8 text-center text-sm text-muted-foreground">Computing Daily Profiler…</div>
      )}

      {/* TAB 1: Outcomes & Range Distributions */}
      {suite && tab === "outcomes" && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {suite.outcomes.map((o) => {
              const color =
                o.status.startsWith("L")
                  ? "text-emerald-400"
                  : o.status.startsWith("S")
                    ? "text-rose-400"
                    : "text-zinc-300";
              const barColor = o.status.startsWith("L")
                ? "bg-emerald-500/60"
                : o.status.startsWith("S")
                  ? "bg-rose-500/60"
                  : "bg-zinc-500/50";
              return (
                <div key={o.status} className="rounded-xl border border-border bg-white/[0.02] p-4">
                  <div className="flex items-center justify-between">
                    <span className={cn("font-mono text-sm font-semibold", color)}>{o.status}</span>
                    <span className="font-mono text-[11px] text-faint">n={o.n}</span>
                  </div>
                  <div className="mt-2 font-mono text-2xl font-semibold">{fmtPct(o.estimate)}</div>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]">
                    <div className={cn("h-full", barColor)} style={{ width: `${(o.estimate ?? 0) * 100}%` }} />
                  </div>
                  <div className="mt-1.5 font-mono text-[11px] text-muted-foreground">
                    95% CI {fmtCi(o.ci95)}
                  </div>
                  <div className="mt-2 border-t border-border/60 pt-2 font-mono text-[11px] text-muted-foreground">
                    Broken: <span className="text-foreground">{fmtPct(o.brokenRate)}</span> ({o.brokenK}/{o.brokenN})
                  </div>
                </div>
              );
            })}
          </div>

          {/* Range Distribution Histograms (0.1% bins, expandable) */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <SimpleHistogramCard
              title="Daily High Distribution (0.1% bins)"
              subtitle={`N=${suite.n}`}
              medianLabel={fmtUnit(suite.dailyHighDist?.median, unit)}
              bars={highRangeBars}
              color="rgba(16,185,129,0.72)"
              hoverColor="#34d399"
            />
            <SimpleHistogramCard
              title="Daily Low Distribution (0.1% bins)"
              subtitle={`N=${suite.n}`}
              medianLabel={fmtUnit(suite.dailyLowDist?.median, unit)}
              bars={lowRangeBars}
              color="rgba(244,63,94,0.72)"
              hoverColor="#fb7185"
            />
          </div>

          {/* Percentile Summary Table */}
          <div className="overflow-x-auto rounded-xl border border-border bg-white/[0.02]">
            <table className="w-full text-left font-mono text-xs">
              <thead className="border-b border-border text-[11px] text-faint">
                <tr>
                  <th className="px-4 py-2.5">Daily Distribution ({unit})</th>
                  <th className="px-3 py-2.5">P10</th>
                  <th className="px-3 py-2.5">P30</th>
                  <th className="px-3 py-2.5">P50 (Med)</th>
                  <th className="px-3 py-2.5">P70</th>
                  <th className="px-3 py-2.5">P90</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { label: "Daily High vs Open", dist: suite.dailyHighDist },
                  { label: "Daily Low vs Open", dist: suite.dailyLowDist },
                  { label: "Daily Total Range", dist: suite.dailyRangeDist },
                ].map((r) => (
                  <tr key={r.label} className="border-b border-border/50">
                    <td className="px-4 py-2 font-sans text-xs">{r.label}</td>
                    <td className="px-3 py-2">{fmtUnit(r.dist?.p10, unit)}</td>
                    <td className="px-3 py-2">{fmtUnit(r.dist?.p30, unit)}</td>
                    <td className="px-3 py-2 font-semibold">{fmtUnit(r.dist?.median, unit)}</td>
                    <td className="px-3 py-2">{fmtUnit(r.dist?.p70, unit)}</td>
                    <td className="px-3 py-2">{fmtUnit(r.dist?.p90, unit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: Timing Histograms (HOD/LOD + False Moves + Session Breaks + Session Contribution) */}
      {suite && tab === "timing" && (
        <div className="space-y-6">
          <HodLodHistogram
            buckets={suite.timeBuckets}
            n={suite.n}
            bucketMinutes={bucketMinutes}
            onBucketChange={setBucketMinutes}
          />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <SimpleHistogramCard
              title={`${suite.targetSession.toUpperCase()} False Move Timing (ET)`}
              subtitle={`Granularity ${bucketMinutes}m`}
              medianLabel={fmtOffsetMin(suite.medianFalseMin)}
              bars={falseBars}
              color="rgba(239,68,68,0.72)"
              hoverColor="#f87171"
            />
            <SimpleHistogramCard
              title={`${suite.targetSession.toUpperCase()} Session Break Timing (ET)`}
              subtitle={`Granularity ${bucketMinutes}m`}
              medianLabel={fmtOffsetMin(suite.medianBrokenMin)}
              bars={brokenBars}
              color="rgba(245,158,11,0.75)"
              hoverColor="#fbbf24"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
            {suite.sessionShares.map((s) => (
              <div key={s.session} className="rounded-xl border border-border bg-white/[0.02] p-3 font-mono text-xs">
                <div className="text-[11px] uppercase text-faint">{s.session}</div>
                <div className="mt-1.5 text-emerald-400">HOD {fmtPct(s.hodRate)} ({s.hodCount})</div>
                <div className="text-[10px] text-muted-foreground">{fmtCi(s.hodCi95)}</div>
                <div className="mt-1.5 text-rose-400">LOD {fmtPct(s.lodRate)} ({s.lodCount})</div>
                <div className="text-[10px] text-muted-foreground">{fmtCi(s.lodCi95)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 3: 20 Reference Level Touches */}
      {suite && tab === "levels" && (
        <div className="overflow-x-auto rounded-xl border border-border bg-white/[0.02]">
          <table className="w-full text-left font-mono text-xs">
            <thead className="border-b border-border text-[11px] text-faint">
              <tr>
                <th className="px-4 py-2.5">Level</th>
                <th className="px-3 py-2.5">Touch Rate</th>
                <th className="px-3 py-2.5 w-40">Bar</th>
                <th className="px-3 py-2.5">Hits / N</th>
                <th className="px-3 py-2.5">95% CI</th>
                <th className="px-3 py-2.5">Median Touch Time</th>
              </tr>
            </thead>
            <tbody>
              {[...suite.levelTouches]
                .sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))
                .map((lv) => (
                  <tr key={lv.level} className="border-b border-border/50">
                    <td className="px-4 py-2 uppercase text-foreground">{lv.level.replace(/_/g, " ")}</td>
                    <td className="px-3 py-2 font-semibold">{fmtPct(lv.rate)}</td>
                    <td className="px-3 py-2">
                      <div className="h-2 w-36 overflow-hidden rounded-full bg-white/[0.07]">
                        <div className="h-full bg-blue-400/75" style={{ width: `${(lv.rate ?? 0) * 100}%` }} />
                      </div>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {lv.touched} / {lv.n}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{fmtCi(lv.ci95)}</td>
                    <td className="px-3 py-2">{fmtOffsetMin(lv.medianTouchMin)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {/* TAB 4: 5m Composite Price Model */}
      {tab === "price-model" && priceModel && (
        <PriceModelCard data={priceModel} unit={unit} anchor={anchor} onAnchorChange={setAnchor} />
      )}
    </div>
  );
}
