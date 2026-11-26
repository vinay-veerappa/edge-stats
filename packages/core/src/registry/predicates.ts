import { sqlNum, sqlStr } from "../util/sql";
import type { PredicateDef, ResolvedArgs } from "./types";
import { requireWindow } from "./types";

const DIRS = ["up", "down", "any"] as const;

function orCol(minutes: number, col: string): string {
  return `f.or${minutes}_${col}`;
}

/**
 * Band edges as fractions of the range. Defaults to the 40-60% middle, but
 * every predicate that takes them accepts any pair, so a 45-55% or 30-70%
 * reading costs nothing extra.
 */
function band(a: ResolvedArgs): { lo: number; hi: number } {
  const lo = typeof a.lo === "number" ? a.lo : 0.4;
  const hi = typeof a.hi === "number" ? a.hi : 0.6;
  return { lo, hi };
}

export const predicates: PredicateDef[] = [
  {
    kind: "predicate",
    name: "gapUp",
    title: "Gapped up",
    doc: "The session opened above the prior session's close.",
    args: [],
    sql: () => "f.gap_dir = 'up'",
    library: [{ kind: "concept", slug: "gap-fill" }],
  },
  {
    kind: "predicate",
    name: "gapDown",
    title: "Gapped down",
    doc: "The session opened below the prior session's close.",
    args: [],
    sql: () => "f.gap_dir = 'down'",
  },
  {
    kind: "predicate",
    name: "noGap",
    title: "No gap",
    doc: "The session opened exactly at the prior session's close (or gap data is unavailable).",
    args: [],
    sql: () => "(f.gap_dir = 'none' OR f.gap_dir IS NULL)",
  },
  {
    kind: "predicate",
    name: "orbBroke",
    title: "Opening range broke",
    doc: "The session broke its opening range (first n minutes) in the given direction after the range formed.",
    args: [
      { name: "window", type: "duration", required: true, doc: "Opening-range window, e.g. 15m" },
      { name: "dir", type: "enum", values: DIRS, default: "any", doc: "Break direction" },
    ],
    sql: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const dir = a.dir as string;
      if (dir === "any") return `${orCol(w, "first_break")} IN ('up', 'down')`;
      return `${orCol(w, "first_break")} = ${sqlStr(dir)}`;
    },
    examples: ["closeGreen WHERE orbBroke(15m, up)"],
    library: [{ kind: "indicator", slug: "ultimate-opening-range-breakout" }],
  },
  {
    kind: "predicate",
    name: "orbFalseBroke",
    title: "Opening range false break (condition)",
    doc: "The first opening-range break failed: price closed back inside the range (or beyond the opposite side). Condition form of the orbFalseBreak outcome.",
    args: [
      { name: "window", type: "duration", required: true, doc: "Opening-range window, e.g. 15m" },
      {
        name: "dir",
        type: "enum",
        values: DIRS,
        default: "any",
        doc: "Direction of the failed break",
      },
    ],
    sql: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const dir = a.dir as string;
      const dirCond =
        dir === "any"
          ? `${orCol(w, "first_break")} IN ('up', 'down')`
          : `${orCol(w, "first_break")} = ${sqlStr(dir)}`;
      return `(${dirCond} AND ${orCol(w, "false_break")})`;
    },
  },
  {
    kind: "predicate",
    name: "orbCloseBroke",
    title: "Opening range broke on a bar close",
    doc: "A bar CLOSED beyond the opening-range boundary instead of merely wicking through it. The close-confirmed counterpart of orbBroke, which is touch-based.",
    args: [
      { name: "window", type: "duration", required: true, doc: "Opening-range window, e.g. 30m" },
      { name: "dir", type: "enum", values: DIRS, default: "any", doc: "Close-break direction" },
    ],
    sql: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const dir = a.dir as string;
      if (dir === "any") return `${orCol(w, "first_close_break")} IN ('up', 'down')`;
      return `${orCol(w, "first_close_break")} = ${sqlStr(dir)}`;
    },
    examples: ["orbBreak(30m, up) WHERE orbCloseBroke(30m, up)"],
    library: [{ kind: "indicator", slug: "ultimate-opening-range-breakout" }],
  },
  {
    kind: "predicate",
    name: "orbWickOnlyBroke",
    title: "Opening range broke by wick only",
    doc: "Price traded beyond the boundary at some point but no bar ever closed beyond it. The complement of orbCloseBroke, and the cleanest way to separate a stop-run from a real break.",
    args: [
      { name: "window", type: "duration", required: true, doc: "Opening-range window, e.g. 30m" },
      { name: "dir", type: "enum", values: DIRS, default: "any", doc: "Wick-break direction" },
    ],
    sql: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const dir = a.dir as string;
      const up = `${orCol(w, "up_wick_only")}`;
      const dn = `${orCol(w, "dn_wick_only")}`;
      if (dir === "up") return up;
      if (dir === "down") return dn;
      return `(${up} OR ${dn})`;
    },
  },
  {
    kind: "predicate",
    name: "orbHeldBand",
    title: "Opening range held the mid band",
    doc: "After the first break, no bar close ever gave back the band. For an up break that means every close stayed above the band's upper edge; for a down break, below its lower edge. The strict 'held' definition.",
    args: [
      { name: "window", type: "duration", required: true, doc: "Opening-range window, e.g. 30m" },
      { name: "dir", type: "enum", values: DIRS, default: "any", doc: "Break direction" },
      { name: "lo", type: "number", default: 0.4, doc: "Band lower edge as a fraction of the range" },
      { name: "hi", type: "number", default: 0.6, doc: "Band upper edge as a fraction of the range" },
    ],
    sql: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const { lo, hi } = band(a);
      const up = `(${orCol(w, "first_break")} = 'up' AND ${orCol(w, "up_min_close_pos")} > ${sqlNum(hi)})`;
      const dn = `(${orCol(w, "first_break")} = 'down' AND ${orCol(w, "dn_max_close_pos")} < ${sqlNum(lo)})`;
      const dir = a.dir as string;
      if (dir === "up") return up;
      if (dir === "down") return dn;
      return `(${up} OR ${dn})`;
    },
  },
  {
    kind: "predicate",
    name: "orbRetestedBand",
    title: "Opening range retested the mid band",
    doc: "After the first break, at least one bar close traded back to the band. A retest is not a failure — pair it with the close position to tell a held retest from a reversal.",
    args: [
      { name: "window", type: "duration", required: true, doc: "Opening-range window, e.g. 30m" },
      { name: "dir", type: "enum", values: DIRS, default: "any", doc: "Break direction" },
      { name: "lo", type: "number", default: 0.4, doc: "Band lower edge as a fraction of the range" },
      { name: "hi", type: "number", default: 0.6, doc: "Band upper edge as a fraction of the range" },
    ],
    sql: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const { lo, hi } = band(a);
      const up = `(${orCol(w, "first_break")} = 'up' AND ${orCol(w, "up_min_close_pos")} <= ${sqlNum(hi)})`;
      const dn = `(${orCol(w, "first_break")} = 'down' AND ${orCol(w, "dn_max_close_pos")} >= ${sqlNum(lo)})`;
      const dir = a.dir as string;
      if (dir === "up") return up;
      if (dir === "down") return dn;
      return `(${up} OR ${dn})`;
    },
  },
  {
    kind: "predicate",
    name: "orbClosedInBand",
    title: "Session closed in the mid band",
    doc: "The session's final close landed inside the band, measured in 0..1 range space. The 'gave it all back' definition of a failed continuation.",
    args: [
      { name: "window", type: "duration", required: true, doc: "Opening-range window, e.g. 30m" },
      { name: "dir", type: "enum", values: DIRS, default: "any", doc: "Restrict to breaks in this direction" },
      { name: "lo", type: "number", default: 0.4, doc: "Band lower edge as a fraction of the range" },
      { name: "hi", type: "number", default: 0.6, doc: "Band upper edge as a fraction of the range" },
    ],
    sql: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const { lo, hi } = band(a);
      const inside = `${orCol(w, "close_pos")} BETWEEN ${sqlNum(lo)} AND ${sqlNum(hi)}`;
      const dir = a.dir as string;
      if (dir === "any") return inside;
      return `(${orCol(w, "first_break")} = ${sqlStr(dir)} AND ${inside})`;
    },
  },
  {
    kind: "predicate",
    name: "orbMidTestedBy",
    title: "Opening range mid tested by N minutes",
    doc: "After the first break, a bar CLOSE traded back into the mid band by N minutes from the session open. Use cumulative thresholds 5, 10, 15... to build 5-minute buckets.",
    args: [
      { name: "window", type: "duration", required: true, doc: "Opening-range window, e.g. 30m" },
      { name: "dir", type: "enum", values: DIRS, default: "any", doc: "Break direction" },
      { name: "minutes", type: "number", required: true, doc: "Minutes from the session open" },
    ],
    sql: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const m = sqlNum(a.minutes as number);
      const up = `(${orCol(w, "first_break")} = 'up' AND ${orCol(w, "up_band_enter_min")} <= ${m})`;
      const dn = `(${orCol(w, "first_break")} = 'down' AND ${orCol(w, "dn_band_enter_min")} <= ${m})`;
      const dir = a.dir as string;
      if (dir === "up") return up;
      if (dir === "down") return dn;
      return `(${up} OR ${dn})`;
    },
  },
  {
    kind: "predicate",
    name: "orbMidNeverTested",
    title: "Opening range mid never retested",
    doc: "After the first break, no bar close ever traded back into the mid band. The cleanest 'held cleanly' condition.",
    args: [
      { name: "window", type: "duration", required: true, doc: "Opening-range window, e.g. 30m" },
      { name: "dir", type: "enum", values: DIRS, default: "any", doc: "Break direction" },
    ],
    sql: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const up = `(${orCol(w, "first_break")} = 'up' AND ${orCol(w, "up_band_enter_min")} IS NULL)`;
      const dn = `(${orCol(w, "first_break")} = 'down' AND ${orCol(w, "dn_band_enter_min")} IS NULL)`;
      const dir = a.dir as string;
      if (dir === "up") return up;
      if (dir === "down") return dn;
      return `(${up} OR ${dn})`;
    },
  },
  {
    kind: "predicate",
    name: "orbSecondBreakBy",
    title: "Second side broken by N minutes",
    doc: "Among double breaks, the second side was taken within N minutes of the session open. Cumulative thresholds give you the time distribution of double breaks.",
    args: [
      { name: "window", type: "duration", required: true, doc: "Opening-range window, e.g. 30m" },
      { name: "minutes", type: "number", required: true, doc: "Minutes from the session open" },
    ],
    sql: (a, ctx) => `${orCol(requireWindow(a.window as number, ctx), "break2_min")} <= ${sqlNum(a.minutes as number)}`,
  },
  {
    kind: "predicate",
    name: "orbBrokeBoth",
    title: "Opening range broke both sides",
    doc: "The session traded beyond both extremes of its opening range.",
    args: [{ name: "window", type: "duration", required: true, doc: "Opening-range window" }],
    sql: (a, ctx) => `${orCol(requireWindow(a.window as number, ctx), "broke_both")}`,
  },
  {
    kind: "predicate",
    name: "ibSingleBreak",
    title: "Initial balance single break",
    doc: "The session broke exactly one side of its initial balance.",
    args: [{ name: "dir", type: "enum", values: DIRS, default: "any", doc: "Which side broke" }],
    sql: (a) => {
      const dir = a.dir as string;
      if (dir === "any") return `f.ib_break IN ('single_up', 'single_down')`;
      return `f.ib_break = ${sqlStr(`single_${dir}`)}`;
    },
    library: [{ kind: "concept", slug: "initial-balance" }],
  },
  {
    kind: "predicate",
    name: "ibDoubleBreak",
    title: "Initial balance double break",
    doc: "The session broke both sides of its initial balance.",
    args: [],
    sql: () => `f.ib_break = 'double'`,
  },
  {
    kind: "predicate",
    name: "ibNoBreak",
    title: "Initial balance held",
    doc: "The session never traded beyond its initial balance.",
    args: [],
    sql: () => `f.ib_break = 'none'`,
  },
  {
    kind: "predicate",
    name: "lunchSweptAmHigh",
    title: "12:00-13:30 Lunch swept 09:30-12:00 AM High",
    doc: "Price during the 12:00-13:30 ET lunch session traded above the 09:30-12:00 ET morning session high.",
    args: [],
    sql: () => "f.lunch_swept_am_high",
    examples: ["closeGreen WHERE lunchSweptAmHigh"],
  },
  {
    kind: "predicate",
    name: "lunchSweptAmLow",
    title: "12:00-13:30 Lunch swept 09:30-12:00 AM Low",
    doc: "Price during the 12:00-13:30 ET lunch session traded below the 09:30-12:00 ET morning session low.",
    args: [],
    sql: () => "f.lunch_swept_am_low",
    examples: ["closeGreen WHERE lunchSweptAmLow"],
  },
  {
    kind: "predicate",
    name: "lunchSweptAm",
    title: "12:00-13:30 Lunch swept either AM High or Low",
    doc: "Price during the 12:00-13:30 ET lunch session swept either the morning session high or low.",
    args: [],
    sql: () => "f.lunch_swept_am",
    examples: ["pmOrDoubleBreak WHERE lunchSweptAm"],
  },
  {
    kind: "predicate",
    name: "pmOrSingleBreak",
    title: "PM opening range (13:30-14:00) single break",
    doc: "The PM opening range (13:30-14:00) broke on exactly one side between 14:00 and 16:00.",
    args: [{ name: "dir", type: "enum", values: DIRS, default: "any", doc: "Which side broke" }],
    sql: (a) => {
      const dir = a.dir as string;
      if (dir === "up") return `(f.pm_or_single_break AND f.or30_first_break = 'up')`;
      if (dir === "down") return `(f.pm_or_single_break AND f.or30_first_break = 'down')`;
      return `f.pm_or_single_break`;
    },
    examples: ["closeGreen WHERE pmOrSingleBreak", "pmOrSingleBreak('up') WHERE lunchSweptAmLow"],
  },
  {
    kind: "predicate",
    name: "pmOrDoubleBreak",
    title: "PM opening range (13:30-14:00) double break",
    doc: "The PM opening range (13:30-14:00) broke on both sides between 14:00 and 16:00.",
    args: [],
    sql: () => "f.pm_or_double_break",
    examples: ["pmOrDoubleBreak WHERE lunchSweptAm"],
  },
  {
    kind: "predicate",
    name: "orgInto30m",
    title: "Price entered 50% of Opening Range Gap (ORG) in first 30m",
    doc: "Price retraced into at least 50% (Consequent Encroachment) of the Opening Range Gap (between previous session close and session open) within the first 30 minutes of the session.",
    args: [],
    sql: () => "f.org_into_30m",
    examples: ["gapFill WHERE orgInto30m"],
  },
  {
    kind: "predicate",
    name: "orgAway30m",
    title: "Price moved away from ORG in first 30m",
    doc: "Price moved away from the Opening Range Gap without entering its 50% Consequent Encroachment in the first 30 minutes of the session.",
    args: [],
    sql: () => "f.org_away_30m",
    examples: ["gapHold WHERE orgAway30m", "gapFill WHERE orgAway30m"],
  },
  {
    kind: "predicate",
    name: "newsWickBothSides",
    title: "08:30 ET news candle high & low both swept in RTH",
    doc: "Price during regular trading hours (09:30-16:00 ET) swept both the high and the low of the 08:30-08:31 ET news candle.",
    args: [],
    sql: () => "f.news_wick_both_sides",
    examples: ["closeGreen WHERE newsWickBothSides", "gapFill WHERE newsWickBothSides"],
  },
  {
    kind: "predicate",
    name: "pdlSwept",
    title: "PDL swept & reclaimed (Turtle Soup Long)",
    doc: "Price traded below the prior session's low (C2 Low / PDL) and closed back above it.",
    args: [],
    sql: () => `f.pdl_swept`,
    examples: ["closeGreen WHERE pdlSwept", "ibSingleBreak('up') WHERE pdlSwept"],
  },
  {
    kind: "predicate",
    name: "pdhSwept",
    title: "PDH swept & reclaimed (Turtle Soup Short)",
    doc: "Price traded above the prior session's high (C2 High / PDH) and closed back below it.",
    args: [],
    sql: () => `f.pdh_swept`,
    examples: ["closeGreen WHERE pdhSwept"],
  },
  {
    kind: "predicate",
    name: "sweptLowFirst",
    title: "Swept prior low before high",
    doc: "Price traded below the prior session's low before touching the prior high.",
    args: [],
    sql: () => `f.swept_low_first`,
  },
  {
    kind: "predicate",
    name: "sweptHighFirst",
    title: "Swept prior high before low",
    doc: "Price traded above the prior session's high before touching the prior low.",
    args: [],
    sql: () => `f.swept_high_first`,
  },
  {
    kind: "predicate",
    name: "eventDay",
    title: "Macro event day",
    doc: "The trade date is in the events calendar under the given name (e.g. 'FOMC', 'CPI', 'NFP', 'OPEX'). Event dates ship as versioned data files with cited sources.",
    args: [
      {
        name: "event",
        type: "string",
        required: true,
        doc: "Event name as listed in the events data",
      },
    ],
    sql: (a) =>
      `EXISTS (SELECT 1 FROM events e WHERE e.date = f.trade_date AND e.event = ${sqlStr(String(a.event))})`,
    examples: ["gapFill WHERE NOT eventDay('FOMC')"],
  },
  {
    kind: "predicate",
    name: "dayBeforeEvent",
    title: "Trading day before event",
    doc: "The NEXT trading session for this symbol is an event day: trading-calendar aware, not calendar-day arithmetic.",
    args: [{ name: "event", type: "string", required: true, doc: "Event name" }],
    sql: (a) =>
      `EXISTS (SELECT 1 FROM events e WHERE e.event = ${sqlStr(String(a.event))} AND e.date = (
        SELECT min(f2.trade_date) FROM session_features f2
        WHERE f2.symbol = f.symbol AND f2.session_key = f.session_key AND f2.trade_date > f.trade_date
      ))`,
  },
  {
    kind: "predicate",
    name: "dayAfterEvent",
    title: "Trading day after event",
    doc: "The PREVIOUS trading session for this symbol was an event day.",
    args: [{ name: "event", type: "string", required: true, doc: "Event name" }],
    sql: (a) =>
      `EXISTS (SELECT 1 FROM events e WHERE e.event = ${sqlStr(String(a.event))} AND e.date = (
        SELECT max(f2.trade_date) FROM session_features f2
        WHERE f2.symbol = f.symbol AND f2.session_key = f.session_key AND f2.trade_date < f.trade_date
      ))`,
  },
  {
    kind: "predicate",
    name: "streak",
    title: "Consecutive-session streak",
    doc: "At least n consecutive sessions of the given color ended immediately before this session.",
    args: [
      {
        name: "dir",
        type: "enum",
        values: ["green", "red"] as const,
        required: true,
        doc: "Streak color",
      },
      { name: "n", type: "number", required: true, doc: "Minimum streak length" },
    ],
    sql: (a) =>
      a.dir === "green"
        ? `f.prev_green_streak >= ${sqlNum(a.n as number)}`
        : `f.prev_red_streak >= ${sqlNum(a.n as number)}`,
    examples: ["closeGreen WHERE streak(red, 3)"],
    library: [{ kind: "indicator", slug: "session-streaks" }],
  },
  {
    kind: "predicate",
    name: "fvgPresent",
    title: "Unfilled fair value gap present",
    doc: "An unfilled session-level FVG sat entirely on the given side of the open at session start. Zones form on prior sessions only: no lookahead.",
    args: [
      {
        name: "ref",
        type: "enum",
        values: ["open"] as const,
        default: "open",
        doc: "Reference price (v0.1: the session open)",
      },
      {
        name: "side",
        type: "enum",
        values: ["above", "below"] as const,
        required: true,
        doc: "Side of the reference",
      },
    ],
    sql: (a) => (a.side === "above" ? "f.fvg_above" : "f.fvg_below"),
    examples: ["gapFill WHERE fvgPresent(open, below) AND dayOfWeek = Tue"],
    library: [{ kind: "indicator", slug: "fvg-sessions" }],
  },
  {
    kind: "predicate",
    name: "weeklyOpenRetraced",
    title: "Weekly open retraced",
    doc: "Session traded through the current ISO week's opening price (roll-masked).",
    args: [],
    sql: () => "f.weekly_open_retrace",
    examples: ["closeGreen WHERE weeklyOpenRetraced"],
  },
  {
    kind: "predicate",
    name: "priorWeekHighBroken",
    title: "Prior week high broken",
    doc: "Session traded strictly above the prior completed ISO week's high (roll-masked).",
    args: [],
    sql: () => "f.prior_week_high_broken",
    examples: ["closeGreen WHERE priorWeekHighBroken"],
  },
  {
    kind: "predicate",
    name: "priorWeekLowBroken",
    title: "Prior week low broken",
    doc: "Session traded strictly below the prior completed ISO week's low (roll-masked).",
    args: [],
    sql: () => "f.prior_week_low_broken",
    examples: ["closeGreen WHERE priorWeekLowBroken"],
  },
  {
    kind: "predicate",
    name: "avwapCloseAbove",
    title: "Closed above session VWAP",
    doc: "Session closed strictly above its own volume-weighted average price.",
    args: [],
    sql: () => "f.avwap_close_above",
    examples: ["orbTargetHit(30, 1) WHERE avwapCloseAbove"],
  },
  {
    kind: "predicate",
    name: "or30BreakAvwapAligned",
    title: "30m OR break aligned with 30m AVWAP",
    doc: "30m OR broke up while the 30m close sat above 30m VWAP, or broke down while below 30m VWAP (causal at OR30 completion).",
    args: [],
    sql: () => "f.or30_break_avwap_aligned",
    examples: ["orbTargetHit(30, 1) WHERE or30BreakAvwapAligned"],
  },
  {
    kind: "predicate",
    name: "fvg1mFormed",
    title: "Post-OR30 1m FVG breakout formed",
    doc: "A >= 1.0 bps 1m FVG closed beyond OR30 before the entry cutoff.",
    args: [],
    sql: () => "f.fvg1m_dir IS NOT NULL",
    examples: ["fvg1mRetestWin WHERE fvg1mFormed"],
  },
  {
    kind: "predicate",
    name: "fvg1mRetested",
    title: "Post-OR30 1m FVG retested",
    doc: "Price retested the first post-OR30 1m FVG edge within 10 bars.",
    args: [],
    sql: () => "f.fvg1m_retested",
    examples: ["fvg1mHeld WHERE fvg1mRetested"],
  },
  {
    kind: "predicate",
    name: "fvg5mRetested",
    title: "Post-OR30 5m FVG retested",
    doc: "Price retested the first post-OR30 5m FVG edge within 15 bars.",
    args: [],
    sql: () => "f.fvg5m_retested",
    examples: ["fvg5mRetestWin WHERE fvg5mRetested"],
  },
  // ── Daily Profiler cross-session predicates ─────────────────────────────────
  {
    kind: "predicate",
    name: "sessionStatus",
    title: "Profiler session status",
    doc: "Filters by a Profiler session's causal status (LT, LF, ST, SF, None) on daily_context.",
    args: [
      {
        name: "session",
        type: "enum",
        values: [
          "asia",
          "london",
          "ny1",
          "ny2",
          "prev_asia",
          "prev_london",
          "prev_ny1",
          "prev_ny2",
        ] as const,
        required: true,
        doc: "Profiler session key",
      },
      {
        name: "status",
        type: "enum",
        values: ["LT", "LF", "ST", "SF", "None"] as const,
        required: true,
        doc: "Session status",
      },
    ],
    sql: (a) => `d.${String(a.session)}_status = ${sqlStr(String(a.status))}`,
    examples: [
      "profilerOutcome(ny2, LT) WHERE sessionStatus(asia, LT) AND sessionStatus(london, LT)",
    ],
  },
  {
    kind: "predicate",
    name: "sessionTrueFalse",
    title: "Profiler session True/False or Long/Short side",
    doc: "Matches LT|ST (true), LF|SF (false), LT|LF (long), or ST|SF (short) for a Profiler session.",
    args: [
      {
        name: "session",
        type: "enum",
        values: ["asia", "london", "ny1", "ny2", "prev_ny1", "prev_ny2"] as const,
        required: true,
        doc: "Profiler session",
      },
      {
        name: "side",
        type: "enum",
        values: ["true", "false", "long", "short"] as const,
        required: true,
        doc: "Grouped side",
      },
    ],
    sql: (a) => {
      const col = `d.${String(a.session)}_status`;
      if (a.side === "true") return `${col} IN ('LT', 'ST')`;
      if (a.side === "false") return `${col} IN ('LF', 'SF')`;
      if (a.side === "long") return `${col} IN ('LT', 'LF')`;
      return `${col} IN ('ST', 'SF')`;
    },
    examples: ["profilerOutcome(ny1, LT) WHERE sessionTrueFalse(asia, true)"],
  },
  {
    kind: "predicate",
    name: "sessionBroken",
    title: "Profiler session mid broken",
    doc: "Filters by whether a Profiler session's box midpoint was touched during its broken window.",
    args: [
      {
        name: "session",
        type: "enum",
        values: [
          "asia",
          "london",
          "ny1",
          "ny2",
          "prev_asia",
          "prev_london",
          "prev_ny1",
          "prev_ny2",
        ] as const,
        required: true,
        doc: "Profiler session",
      },
      {
        name: "broken",
        type: "enum",
        values: ["yes", "no"] as const,
        default: "yes",
        doc: "Broken status (yes or no)",
      },
    ],
    sql: (a) => `d.${String(a.session)}_broken = ${a.broken === "yes" ? "TRUE" : "FALSE"}`,
    examples: ["profilerOutcome(ny2, LT) WHERE sessionBroken(asia, no) AND sessionBroken(london, no)"],
  },
  {
    kind: "predicate",
    name: "overnightAligned",
    title: "Asia & London aligned overnight",
    doc: "Asia and London share directional bias without Broken-Broken contradiction.",
    args: [
      {
        name: "dir",
        type: "enum",
        values: ["any", "long", "short"] as const,
        default: "any",
        doc: "Direction (any, long, short)",
      },
    ],
    sql: (a) => {
      if (a.dir === "long") return `d.asia_london_pattern = 'AlignedLong'`;
      if (a.dir === "short") return `d.asia_london_pattern = 'AlignedShort'`;
      return `d.asia_london_aligned = TRUE`;
    },
    examples: ["closeGreen WHERE overnightAligned(long)"],
  },
  {
    kind: "predicate",
    name: "p12ScenarioIs",
    title: "P12 scenario equals",
    doc: "Matches P12 06:00-08:30 touch scenario (1..5).",
    args: [
      {
        name: "scenario",
        type: "enum",
        values: ["1", "2", "3", "4", "5"] as const,
        required: true,
        doc: "P12 scenario number",
      },
    ],
    sql: (a) => `d.p12_scenario = ${sqlStr(String(a.scenario))}`,
    examples: ["closeGreen WHERE p12ScenarioIs(2)"],
  },
  {
    kind: "predicate",
    name: "levelTouched",
    title: "Reference level touched",
    doc: "True when one of the 20 Profiler reference levels was touched (optionally in a specific session window).",
    args: [
      {
        name: "level",
        type: "enum",
        values: [
          "pdh",
          "pdm",
          "pdl",
          "p12h",
          "p12m",
          "p12l",
          "ny_p12h",
          "ny_p12m",
          "ny_p12l",
          "daily_open",
          "midnight_open",
          "open_0730",
          "asia_mid",
          "london_mid",
          "ny1_mid",
          "ny2_mid",
          "prev_asia_mid",
          "prev_london_mid",
          "prev_ny1_mid",
          "prev_ny2_mid",
        ] as const,
        required: true,
        doc: "Reference level key",
      },
      {
        name: "window",
        type: "enum",
        values: ["any", "asia", "london", "ny1", "ny2", "p12"] as const,
        default: "any",
        doc: "Session window filter",
      },
    ],
    sql: (a) => {
      const lv = String(a.level);
      const w = String(a.window);
      if (w === "any") return `d.touch_${lv} = TRUE`;
      const bit = w === "asia" ? 1 : w === "london" ? 2 : w === "ny1" ? 4 : w === "ny2" ? 8 : 16;
      return `(d.touch_${lv}_mask & ${bit}) <> 0`;
    },
    examples: ["closeGreen WHERE levelTouched(pdl, london)"],
  },
  // ── Candle Science v17.5 predicates ─────────────────────────────────────────
  {
    kind: "predicate",
    name: "csDim",
    title: "Candle Science structural dimension",
    doc: "Tests one of the 16 canonical Candle Science structural bits on cs_candles.sig_mask.",
    args: [
      {
        name: "dim",
        type: "enum",
        values: [
          "c1_bull",
          "c2_bull",
          "c2h_gt_c1h",
          "c2h_gt_c1o",
          "c2l_gt_c1l",
          "c2l_gt_c1o",
          "c2c_gt_c1h",
          "c2c_gt_c1l",
          "c2c_gt_c1c",
          "c2c_gt_c1o",
          "c2o_gt_c1c",
          "c2o_gt_c1o",
          "c3o_gt_c2h",
          "c3o_gt_c2l",
          "c3o_gt_c2c",
          "c3o_gt_c2o",
        ] as const,
        required: true,
        doc: "Structural dimension name",
      },
      {
        name: "value",
        type: "enum",
        values: ["yes", "no"] as const,
        default: "yes",
        doc: "Whether the structural condition holds (yes/no)",
      },
    ],
    sql: (a) => {
      const dims = [
        "c1_bull",
        "c2_bull",
        "c2h_gt_c1h",
        "c2h_gt_c1o",
        "c2l_gt_c1l",
        "c2l_gt_c1o",
        "c2c_gt_c1h",
        "c2c_gt_c1l",
        "c2c_gt_c1c",
        "c2c_gt_c1o",
        "c2o_gt_c1c",
        "c2o_gt_c1o",
        "c3o_gt_c2h",
        "c3o_gt_c2l",
        "c3o_gt_c2c",
        "c3o_gt_c2o",
      ];
      const bit = 1 << dims.indexOf(String(a.dim));
      return a.value === "yes"
        ? `(cs.roll_safe = TRUE AND (cs.sig_mask & ${bit}) <> 0)`
        : `(cs.roll_safe = TRUE AND (cs.sig_mask & ${bit}) = 0)`;
    },
    examples: ["csBreakHigh WHERE csDim(c2c_gt_c1h, yes) AND csDim(c3o_gt_c2c, yes)"],
  },
];
