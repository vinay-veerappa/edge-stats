/*
  Side-by-side ORB / IB Window Matrix.
  Replaces the legacy Range Comparison & Range Analytics cards by querying
  EdgeStats live across RTH (5m, 15m, 30m, 60m) and PM (13:30-14:00 30m)
  with Wilson 95% CIs, sample size N, and post-OR30 FVG retest outcomes.
*/
import { useEffect, useState } from "react";
import { api, type QueryResult, type SymbolConfig } from "../lib/api";
import { useCachedAsync } from "../lib/hooks";
import { EmptyState, Labeled, Panel, PanelHeader, SelectInput, Skeleton, TextInput } from "../components/ui";

interface WindowSpec {
  id: string;
  label: string;
  sessionKey: string;
  window: number;
  hasFvgRetest: boolean;
}

const WINDOWS: WindowSpec[] = [
  { id: "rth-5", label: "RTH 5m OR (09:30–09:35)", sessionKey: "rth_0930_1600", window: 5, hasFvgRetest: false },
  { id: "rth-15", label: "RTH 15m OR (09:30–09:45)", sessionKey: "rth_0930_1600", window: 15, hasFvgRetest: false },
  { id: "rth-30", label: "RTH 30m OR (09:30–10:00)", sessionKey: "rth_0930_1600", window: 30, hasFvgRetest: true },
  { id: "rth-60", label: "RTH 60m IB (09:30–10:30)", sessionKey: "rth_0930_1600", window: 60, hasFvgRetest: false },
  { id: "pm-30", label: "PM 30m OR (13:30–14:00)", sessionKey: "ny_pm_1330_1600", window: 30, hasFvgRetest: true },
];

interface RowData {
  spec: WindowSpec;
  brk: QueryResult | null;
  falseBrk: QueryResult | null;
  ext1x: QueryResult | null;
  cont: QueryResult | null;
  fvg1m: QueryResult | null;
  fvg5m: QueryResult | null;
  error: string | null;
}

function pct(r: QueryResult | null): string {
  if (!r || r.estimate === null || r.guards.refused) return "—";
  return `${(r.estimate * 100).toFixed(1)}%`;
}

function ciText(r: QueryResult | null): string {
  if (!r || !r.ci95 || r.guards.refused) return "";
  return `n=${r.n} [${(r.ci95[0] * 100).toFixed(0)}–${(r.ci95[1] * 100).toFixed(0)}%]`;
}

function distMed(r: QueryResult | null, suffix: string): string {
  if (!r || !r.distribution) return "";
  return `p50 ${r.distribution.median.toFixed(1)}${suffix}`;
}

export function MatrixPage() {
  const symbols = useCachedAsync("symbols", (signal) => api.symbols(signal));
  const [symbol, setSymbol] = useState("NQ1");
  const [since, setSince] = useState("2022-01-01");
  const [whereClause, setWhereClause] = useState("");
  const [rows, setRows] = useState<RowData[]>([]);
  const [loading, setLoading] = useState(false);

  const symList: SymbolConfig[] = symbols.data?.symbols ?? [];

  useEffect(() => {
    const first = symList[0]?.symbol;
    if (first && !symList.some((s) => s.symbol === symbol)) {
      setSymbol(first);
    }
  }, [symList, symbol]);

  useEffect(() => {
    const controller = new AbortController();
    const cond = whereClause.trim();
    const withWhere = (dsl: string) => (cond ? `${dsl} WHERE ${cond}` : dsl);

    async function run() {
      setLoading(true);
      const next = await Promise.all(
        WINDOWS.map(async (spec): Promise<RowData> => {
          const safe = async (dsl: string): Promise<QueryResult | null> => {
            try {
              return await api.query(
                { symbol, sessionKey: spec.sessionKey, dsl, since: since || undefined, sessionsLimit: 0 },
                controller.signal,
              );
            } catch {
              return null;
            }
          };
          try {
            const [brk, falseBrk, ext1x, cont, fvg1m, fvg5m] = await Promise.all([
              safe(withWhere(`orbBreak(${spec.window})`)),
              safe(withWhere(`orbFalseBreak(${spec.window})`)),
              safe(withWhere(`orbTargetHit(${spec.window}, 1)`)),
              safe(withWhere(`orbCloseContinuation(${spec.window})`)),
              spec.hasFvgRetest ? safe(withWhere("fvg1mRetestWin")) : Promise.resolve(null),
              spec.hasFvgRetest ? safe(withWhere("fvg5mRetestWin")) : Promise.resolve(null),
            ]);
            return { spec, brk, falseBrk, ext1x, cont, fvg1m, fvg5m, error: null };
          } catch (e) {
            return {
              spec,
              brk: null,
              falseBrk: null,
              ext1x: null,
              cont: null,
              fvg1m: null,
              fvg5m: null,
              error: e instanceof Error ? e.message : "query failed",
            };
          }
        }),
      );
      if (!controller.signal.aborted) {
        setRows(next);
        setLoading(false);
      }
    }
    void run();
    return () => controller.abort();
  }, [symbol, since, whereClause]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">ORB / IB Window Matrix</h1>
        <p className="text-sm text-muted-foreground">
          Side-by-side comparison across RTH and PM opening ranges with sample sizes, 95% Wilson CIs, and post-OR30 FVG retest CTQ outcomes.
        </p>
      </div>

      <Panel className="p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="w-32">
            <Labeled label="Symbol">
              <SelectInput value={symbol} onChange={setSymbol} ariaLabel="Symbol">
                {symList.length === 0 ? (
                  <option value={symbol}>{symbol}</option>
                ) : (
                  symList.map((s) => (
                    <option key={s.symbol} value={s.symbol}>
                      {s.symbol}
                    </option>
                  ))
                )}
              </SelectInput>
            </Labeled>
          </div>

          <div className="w-40">
            <Labeled label="Since">
              <TextInput type="date" value={since} onChange={setSince} ariaLabel="Since date" />
            </Labeled>
          </div>

          <div className="min-w-[260px] flex-1">
            <Labeled label="Optional WHERE Condition (e.g. eventDay('FOMC'), dayOfWeek = Tue, or30BreakAvwapAligned)">
              <TextInput
                value={whereClause}
                onChange={setWhereClause}
                placeholder="Leave blank for all sessions"
                ariaLabel="Optional WHERE Condition"
                mono
              />
            </Labeled>
          </div>
        </div>
      </Panel>

      {loading && rows.length === 0 ? (
        <Panel className="space-y-3 p-4">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </Panel>
      ) : rows.length === 0 ? (
        <EmptyState title="No data">
          <p>Sync bars and run derivation for {symbol} first.</p>
        </EmptyState>
      ) : (
        <Panel accent="prism" className="overflow-x-auto">
          <PanelHeader right={<span className="font-mono text-[11px] text-faint">{symbol} · since {since || "all"}</span>}>
            RTH &amp; PM OPENING RANGE MATRIX
          </PanelHeader>
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-border text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3">Window</th>
                <th className="px-4 py-3">Break Rate</th>
                <th className="px-4 py-3">False Break</th>
                <th className="px-4 py-3">1.0x Ext Hit</th>
                <th className="px-4 py-3">Close Cont.</th>
                <th className="px-4 py-3">1m FVG Retest (CTQ 12)</th>
                <th className="px-4 py-3">5m FVG Retest (CTQ 12)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border font-mono">
              {rows.map((r) => (
                <tr key={r.spec.id} className="hover:bg-white/[0.02]">
                  <td className="px-4 py-3 font-sans font-medium text-foreground">{r.spec.label}</td>
                  <td className="px-4 py-3">
                    <div>{pct(r.brk)}</div>
                    <div className="text-[11px] text-faint">{ciText(r.brk)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{pct(r.falseBrk)}</div>
                    <div className="text-[11px] text-faint">{ciText(r.falseBrk)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{pct(r.ext1x)}</div>
                    <div className="text-[11px] text-faint">
                      {ciText(r.ext1x)} {distMed(r.ext1x, "R")}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{pct(r.cont)}</div>
                    <div className="text-[11px] text-faint">{ciText(r.cont)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{pct(r.fvg1m)}</div>
                    <div className="text-[11px] text-faint">
                      {ciText(r.fvg1m)} {distMed(r.fvg1m, "bps")}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{pct(r.fvg5m)}</div>
                    <div className="text-[11px] text-faint">
                      {ciText(r.fvg5m)} {distMed(r.fvg5m, "bps")}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}
