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
];
