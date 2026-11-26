/*
  Daily Profiler Workbench (/profiler).
  Sequential Asia -> London -> NY1 -> NY2 causal conditioning backed by
  crates/spine_wasm -> daily_context + daily_paths_5m. Every metric displays N,
  Wilson 95% CI, stability split, and the honest disclaimer.
*/
import { useEffect, useMemo, useState } from "react";
import type {
  ProfilerPriceModelResult,
  ProfilerSessionFilter,
  ProfilerSuiteResult,
  ProfilerTargetSession,
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

type PriorKey =
  | "prev_ny1"
  | "prev_ny2"
  | "asia"
  | "london"
  | "ny1"
  | "ny2";

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

function PriceModelSvg({
  data,
  unit,
}: {
  data: ProfilerPriceModelResult;
  unit: "bps" | "%";
}) {
  if (data.points.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-white/[0.02] p-6 text-center text-sm text-muted-foreground">
        No 5-minute composite path data matched these filters.
      </div>
    );
  }
  const W = 900;
  const H = 260;
  const pad = { t: 18, r: 20, b: 28, l: 56 };
  const pts = data.points;
  const ys = pts.flatMap((p) => [p.p25CloseBps, p.p75CloseBps, p.medianHighBps, p.medianLowBps]);
  const yMin = Math.min(...ys, -10);
  const yMax = Math.max(...ys, 10);
  const xOf = (bidx: number) => pad.l + (bidx / 275) * (W - pad.l - pad.r);
  const yOf = (val: number) =>
    pad.t + ((yMax - val) / Math.max(1e-6, yMax - yMin)) * (H - pad.t - pad.b);

  const linePath = (getter: (p: (typeof pts)[number]) => number) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${xOf(p.bucketIdx).toFixed(1)},${yOf(getter(p)).toFixed(1)}`).join(" ");

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
  ];

  return (
    <div className="rounded-xl border border-border bg-white/[0.02] p-4">
      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          Composite Median Close + IQR (P25-P75) · N={data.n} · Anchor: {data.anchor}
        </span>
        <span className="font-mono text-[11px] text-faint">{data.disclaimer}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-64 w-full">
        {/* Zero line */}
        <line
          x1={pad.l}
          x2={W - pad.r}
          y1={yOf(0)}
          y2={yOf(0)}
          stroke="rgba(255,255,255,0.2)"
          strokeDasharray="3,3"
        />
        {/* Session markers */}
        {markers.map((m) => (
          <g key={m.label}>
            <line
              x1={xOf(m.bidx)}
              x2={xOf(m.bidx)}
              y1={pad.t}
              y2={H - pad.b}
              stroke="rgba(255,255,255,0.08)"
              strokeDasharray="2,4"
            />
            <text
              x={xOf(m.bidx)}
              y={H - 8}
              textAnchor="middle"
              fill="rgba(255,255,255,0.45)"
              fontSize="10"
              fontFamily="monospace"
            >
              {m.label}
            </text>
          </g>
        ))}
        {/* Y-axis ticks */}
        {[yMax, 0, yMin].map((v, i) => (
          <text
            key={i}
            x={pad.l - 6}
            y={yOf(v) + 3}
            textAnchor="end"
            fill="rgba(255,255,255,0.45)"
            fontSize="10"
            fontFamily="monospace"
          >
            {fmtUnit(v, unit)}
          </text>
        ))}
        <path d={bandPath} fill="rgba(59,130,246,0.16)" />
        <path d={linePath((p) => p.medianHighBps)} fill="none" stroke="rgba(16,185,129,0.55)" strokeWidth="1" />
        <path d={linePath((p) => p.medianLowBps)} fill="none" stroke="rgba(239,68,68,0.55)" strokeWidth="1" />
        <path d={linePath((p) => p.medianCloseBps)} fill="none" stroke="#60a5fa" strokeWidth="2" />
      </svg>
    </div>
  );
}

export function ProfilerPage() {
  const symbolsQuery = useCachedAsync("symbols", (signal) => api.symbols(signal));
  const symbols = symbolsQuery.data?.symbols ?? [];
  const [symbol, setSymbol] = useState<string>("");
  const [targetSession, setTargetSession] = useState<ProfilerTargetSession>("ny2");
  const [filters, setFilters] = useState<Partial<Record<PriorKey, ProfilerSessionFilter>>>({});
  const [p12Scenario, setP12Scenario] = useState<string>("Any");
  const [brokenBroken, setBrokenBroken] = useState<"any" | "yes" | "no">("any");
  const [whereDsl, setWhereDsl] = useState<string>("");
  const [bucketMinutes, setBucketMinutes] = useState<5 | 15 | 30 | 60>(30);
  const [unit, setUnit] = useState<"bps" | "%">("%");
  const [tab, setTab] = useState<"outcomes" | "timing" | "levels" | "price-model">("outcomes");

  const [suite, setSuite] = useState<ProfilerSuiteResult | null>(null);
  const [priceModel, setPriceModel] = useState<ProfilerPriceModelResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol && symbols.length > 0) {
      const nq = symbols.find((s) => s.symbol === "NQ1");
      setSymbol(nq ? nq.symbol : symbols[0]!.symbol);
    }
  }, [symbol, symbols]);

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
        ? api.profilerPriceModel({ ...payload, bucketMinutes: bucketMinutes === 60 ? 30 : bucketMinutes }, ac.signal)
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
  }, [symbol, payload, tab, bucketMinutes]);

  const syncLiveContext = async () => {
    if (!symbol) return;
    try {
      const live = await api.liveContext(symbol);
      const d = live.daily;
      if (!d) return;
      const next: Partial<Record<PriorKey, ProfilerSessionFilter>> = {};
      const mapField = (k: PriorKey, stKey: string, brkKey: string) => {
        const st = typeof d[stKey] === "string" ? (d[stKey] as string) : undefined;
        const brk = typeof d[brkKey] === "boolean" ? (d[brkKey] ? "yes" : "no") : undefined;
        if (st || brk) next[k] = { status: st, broken: brk };
      };
      mapField("asia", "asiaStatus", "asiaBroken");
      mapField("london", "londonStatus", "londonBroken");
      mapField("ny1", "ny1Status", "ny1Broken");
      mapField("prev_ny1", "prevNy1Status", "prevNy1Broken");
      mapField("prev_ny2", "prevNy2Status", "prevNy2Broken");
      setFilters(next);
      if (typeof d.p12Scenario === "string") setP12Scenario(d.p12Scenario);
    } catch {
      // ignore if live context unavailable
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Daily Profiler</h1>
          <p className="text-sm text-muted-foreground">
            Causal Spine sequential session conditioning (Asia → London → NY1 → NY2) with Wilson 95% CIs.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
            onClick={() => void syncLiveContext()}
            className="rounded-lg border border-border bg-white/[0.04] px-3 py-1.5 text-xs font-medium hover:bg-white/[0.08]"
          >
            Sync Latest Context
          </button>
          <button
            type="button"
            onClick={() => {
              setFilters({});
              setP12Scenario("Any");
              setBrokenBroken("any");
              setWhereDsl("");
            }}
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
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
        </div>
      </div>

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
              onChange={(e) => setP12Scenario(e.target.value)}
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
              onChange={(e) => setBrokenBroken(e.target.value as "any" | "yes" | "no")}
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
                    onChange={(e) =>
                      setFilters((prev) => ({
                        ...prev,
                        [k]: { ...prev[k], status: e.target.value },
                      }))
                    }
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
              ["timing", "HOD / LOD Timing"],
              ["levels", "20 Level Touches"],
              ["price-model", "Composite Price Model"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                tab === id
                  ? "bg-white/[0.08] text-foreground"
                  : "text-muted-foreground hover:text-foreground",
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
            <span className="hidden text-[11px] text-faint md:inline">{suite.disclaimer}</span>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
          {error}
        </div>
      )}

      {loading && !suite && (
        <div className="p-8 text-center text-sm text-muted-foreground">Querying DuckDB…</div>
      )}

      {suite && tab === "outcomes" && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {suite.outcomes.map((o) => (
              <div
                key={o.status}
                className="rounded-xl border border-border bg-white/[0.02] p-4"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm font-semibold">{o.status}</span>
                  <span className="font-mono text-xs text-faint">n={o.n}</span>
                </div>
                <div className="mt-2 font-mono text-2xl font-semibold">
                  {fmtPct(o.estimate)}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  95% CI {fmtCi(o.ci95)}
                </div>
                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className="h-full bg-blue-400"
                    style={{ width: `${Math.min(100, (o.estimate ?? 0) * 100)}%` }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>Broken: {fmtPct(o.brokenRate)}</span>
                  <span>
                    {o.stability?.agree === true
                      ? "Stable"
                      : o.stability?.agree === false
                        ? "Drifted"
                        : "—"}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {(
              [
                ["Daily High vs 18:00 Open", suite.dailyHighDist],
                ["Daily Low vs 18:00 Open", suite.dailyLowDist],
                ["Full Globex Range", suite.dailyRangeDist],
              ] as const
            ).map(([label, dist]) => (
              <div key={label} className="rounded-xl border border-border bg-white/[0.02] p-4">
                <div className="text-xs font-medium text-muted-foreground">{label}</div>
                {dist ? (
                  <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-xs">
                    <div>
                      <div className="text-[10px] text-faint">P30</div>
                      <div>{fmtUnit(dist.p30, unit)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-faint">Median</div>
                      <div className="font-semibold text-blue-300">
                        {fmtUnit(dist.median, unit)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-faint">P70</div>
                      <div>{fmtUnit(dist.p70, unit)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-faint">P10</div>
                      <div className="text-muted-foreground">{fmtUnit(dist.p10, unit)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-faint">P90</div>
                      <div className="text-muted-foreground">{fmtUnit(dist.p90, unit)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-faint">Mean</div>
                      <div className="text-muted-foreground">{fmtUnit(dist.mean, unit)}</div>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 text-xs text-faint">No data</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {suite && tab === "timing" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">HOD / LOD Session Attribution & Time Buckets</h2>
            <div className="flex items-center gap-1">
              {([5, 15, 30, 60] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => setBucketMinutes(b)}
                  className={cn(
                    "rounded px-2 py-0.5 font-mono text-xs",
                    bucketMinutes === b
                      ? "bg-white/[0.1] text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {b}m
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-border bg-white/[0.02]">
            <table className="w-full text-left font-mono text-xs">
              <thead className="border-b border-border text-[11px] text-faint">
                <tr>
                  <th className="px-4 py-2">Session</th>
                  <th className="px-4 py-2">HOD Share</th>
                  <th className="px-4 py-2">HOD 95% CI</th>
                  <th className="px-4 py-2">LOD Share</th>
                  <th className="px-4 py-2">LOD 95% CI</th>
                </tr>
              </thead>
              <tbody>
                {suite.sessionShares.map((s) => (
                  <tr key={s.session} className="border-b border-border/50">
                    <td className="px-4 py-2 font-medium uppercase">{s.session}</td>
                    <td className="px-4 py-2 text-emerald-300">
                      {fmtPct(s.hodRate)} ({s.hodCount})
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{fmtCi(s.hodCi95)}</td>
                    <td className="px-4 py-2 text-rose-300">
                      {fmtPct(s.lodRate)} ({s.lodCount})
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{fmtCi(s.lodCi95)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-6">
            {suite.timeBuckets
              .filter((b) => b.hodCount > 0 || b.lodCount > 0)
              .map((b) => (
                <div
                  key={b.bucketMin}
                  className="rounded-lg border border-border/60 bg-white/[0.02] p-2 font-mono text-[11px]"
                >
                  <div className="text-faint">{b.etLabel} ET</div>
                  <div className="mt-1 flex justify-between">
                    <span className="text-emerald-300">H {fmtPct(b.hodRate)}</span>
                    <span className="text-rose-300">L {fmtPct(b.lodRate)}</span>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {suite && tab === "levels" && (
        <div className="overflow-x-auto rounded-xl border border-border bg-white/[0.02]">
          <table className="w-full text-left font-mono text-xs">
            <thead className="border-b border-border text-[11px] text-faint">
              <tr>
                <th className="px-4 py-2.5">Level</th>
                <th className="px-4 py-2.5">Touched</th>
                <th className="px-4 py-2.5">Rate</th>
                <th className="px-4 py-2.5">Wilson 95% CI</th>
                <th className="px-4 py-2.5">Median First Touch</th>
              </tr>
            </thead>
            <tbody>
              {suite.levelTouches.map((lv) => (
                <tr key={lv.level} className="border-b border-border/50">
                  <td className="px-4 py-2 font-medium uppercase">{lv.level}</td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {lv.touched} / {lv.n}
                  </td>
                  <td className="px-4 py-2 font-semibold">{fmtPct(lv.rate)}</td>
                  <td className="px-4 py-2 text-muted-foreground">{fmtCi(lv.ci95)}</td>
                  <td className="px-4 py-2">{fmtOffsetMin(lv.medianTouchMin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "price-model" && priceModel && <PriceModelSvg data={priceModel} unit={unit} />}
    </div>
  );
}
