import type { InstrumentCoachState, MarketCoachingSnapshot } from "./scanner";

const DEFAULT_JOURNAL_URL = "http://127.0.0.1:3300";
const START_MARKER = "<!-- MARKET_COACH_START -->";
const END_MARKER = "<!-- MARKET_COACH_END -->";

const SYMBOL_ROOTS: Record<string, string[]> = {
  ES1: ["ES", "MES"],
  NQ1: ["NQ", "MNQ"],
  YM1: ["YM", "MYM"],
};

export function tagsForInstrument(
  inst: InstrumentCoachState,
  bestInstrument: string | null,
): string[] {
  const tags: string[] = [];
  if (inst.org.orgInto30m) tags.push("coach:org_into_30m");
  if (inst.org.orgAway30m) tags.push("coach:org_away_30m");
  if (inst.orb30.orb25ExtReject !== "NONE") tags.push("coach:orb25_ext_rej");
  if (inst.fvg10am.status === "HELD") tags.push("coach:10am_fvg_held");
  if (inst.fvg10am.status === "VIOLATED") tags.push("coach:10am_fvg_violated");
  if (inst.noonGate === "NO_NOON_FADE") tags.push("coach:no_noon_fade");
  if (inst.chopTimer.active) tags.push("coach:am_impulse_100bps");
  if (bestInstrument === inst.symbol) tags.push("coach:best_pick");
  return tags;
}

export function formatJournalSummary(snapshot: MarketCoachingSnapshot): string {
  const lines = [
    START_MARKER,
    `### Market Coach Summary (${snapshot.tradeDate})`,
    `- **Routing:** ${snapshot.routing.headline}`,
  ];
  for (const inst of snapshot.instruments) {
    lines.push(
      `- **${inst.symbol}:** ORG ${inst.org.gapBps ?? "—"}bps (${inst.org.gapDir}) | ORB30 ${inst.orb30.rangeBps ?? "—"}bps (${inst.orb30.orb25ExtReject}) | 10am FVG ${inst.fvg10am.status} (MAE ${inst.fvg10am.maeBps ?? "—"}bps) | Noon ${inst.noonGate}`,
    );
  }
  lines.push(END_MARKER);
  return lines.join("\n");
}

export function mergeDayNote(existingNote: string, coachBlock: string): string {
  const start = existingNote.indexOf(START_MARKER);
  const end = existingNote.indexOf(END_MARKER);
  if (start !== -1 && end !== -1 && end > start) {
    const before = existingNote.slice(0, start).trimEnd();
    const after = existingNote.slice(end + END_MARKER.length).trimStart();
    return [before, coachBlock, after].filter(Boolean).join("\n\n");
  }
  return existingNote.trim() ? `${existingNote.trimEnd()}\n\n${coachBlock}` : coachBlock;
}

export interface JournalSyncResult {
  tradeDate: string;
  tradesMatched: number;
  tagsApplied: Record<string, number>;
  noteUpdated: boolean;
}

export async function syncCoachingToJournal(
  snapshot: MarketCoachingSnapshot,
  journalUrl = DEFAULT_JOURNAL_URL,
  fetchFn: typeof fetch = fetch,
): Promise<JournalSyncResult> {
  const res = await fetchFn(`${journalUrl}/api/journal/${snapshot.tradeDate}`);
  if (!res.ok) {
    throw new Error(`Journal GET ${res.status}`);
  }
  const dayData = (await res.json()) as {
    trades?: Array<{ key?: string; symbol?: string }>;
    note?: string;
  };
  const trades = dayData.trades ?? [];
  const tagsApplied: Record<string, number> = {};
  let tradesMatched = 0;

  for (const inst of snapshot.instruments) {
    const roots = SYMBOL_ROOTS[inst.symbol] ?? [inst.symbol];
    const keys = trades
      .filter((t) => t.key && t.symbol && roots.some((r) => t.symbol!.toUpperCase().startsWith(r)))
      .map((t) => t.key!);
    if (keys.length === 0) continue;
    tradesMatched += keys.length;
    for (const tag of tagsForInstrument(inst, snapshot.routing.bestInstrument)) {
      const tagRes = await fetchFn(`${journalUrl}/api/trades/bulk`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys, action: "tag", tag }),
      });
      if (tagRes.ok) {
        tagsApplied[tag] = (tagsApplied[tag] ?? 0) + keys.length;
      }
    }
  }

  const mergedNote = mergeDayNote(dayData.note ?? "", formatJournalSummary(snapshot));
  const noteRes = await fetchFn(`${journalUrl}/api/journal/${snapshot.tradeDate}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note: mergedNote }),
  });

  return {
    tradeDate: snapshot.tradeDate,
    tradesMatched,
    tagsApplied,
    noteUpdated: noteRes.ok,
  };
}
