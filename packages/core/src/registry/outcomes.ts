import { sqlNum, sqlStr } from "../util/sql";
import { fields } from "./fields";
import type { OutcomeDef } from "./types";
import { QueryError, requireWindow } from "./types";

const DIRS = ["up", "down", "any"] as const;

function orCol(minutes: number, col: string): string {
  return `f.or${minutes}_${col}`;
}

const numericFieldNames = fields.filter((f) => f.valueType === "number").map((f) => f.name);

function numericFieldSql(name: string): string {
  const def = fields.find((f) => f.name === name && f.valueType === "number");
  if (!def) {
    throw new QueryError(
      `hit() needs a numeric field, got '${name}'`,
      `numeric fields: ${numericFieldNames.join(", ")}`,
    );
  }
  return def.sql;
}

const CMPS: Record<string, string> = { gte: ">=", gt: ">", lte: "<=", lt: "<" };

export const outcomes: OutcomeDef[] = [
  {
    kind: "outcome",
    name: "gapFill",
    title: "Gap fill",
    doc: "Of the sessions that opened with a gap, how often price traded back to the prior session's close. Roll days are excluded by construction: a gap across a futures roll is a roll, not a gap.",
    args: [],
    eligibility: () => `f.gap_dir IN ('up', 'down')`,
    success: () => "f.gap_filled",
    value: {
      sql: () => "f.gap_fill_min",
      unit: "minutes",
      doc: "Minutes from the open to the fill, among filled sessions.",
    },
    examples: [
      "gapFill",
      "gapFill WHERE gapPct BETWEEN 0.2% AND 0.6% AND dayOfWeek = Tue",
      "gapFill WHERE fvgPresent(open, below) AND NOT eventDay('FOMC')",
    ],
    library: [
      { kind: "concept", slug: "gap-fill" },
      { kind: "indicator", slug: "session-gap-fill" },
    ],
  },
  {
    kind: "outcome",
    name: "gapHold",
    title: "Gap holds (gap-and-go)",
    doc: "Of the sessions that opened with a gap, how often the gap NEVER filled and the session closed beyond its open in the gap's direction: the gap-and-go continuation, measured directly instead of as the complement of the fill rate.",
    args: [
      {
        name: "dir",
        type: "enum",
        values: ["up", "down", "any"] as const,
        default: "any",
        doc: "Gap direction to count",
      },
    ],
    eligibility: (a) => {
      const dir = a.dir as string;
      if (dir === "any") return `f.gap_dir IN ('up', 'down')`;
      return `f.gap_dir = '${dir}'`;
    },
    success: () =>
      `(NOT coalesce(f.gap_filled, FALSE) AND ((f.gap_dir = 'up' AND f.green) OR (f.gap_dir = 'down' AND f.close < f.open)))`,
    examples: ["gapHold", "gapHold(up) WHERE gapBucket = l"],
    library: [
      { kind: "concept", slug: "gap-and-go" },
      { kind: "concept", slug: "gap-fill" },
    ],
  },
  {
    kind: "outcome",
    name: "gapReversal",
    title: "Reversal after gap fill",
    doc: "Of the sessions that filled their opening gap, how often the session then closed beyond the prior close against the gap's direction (fill-and-reverse).",
    args: [],
    eligibility: () => `f.gap_filled`,
    success: () => "f.gap_reversed",
    library: [
      { kind: "concept", slug: "gap-fill" },
      { kind: "indicator", slug: "session-gap-fill" },
    ],
  },
  {
    kind: "outcome",
    name: "closeGreen",
    title: "Session closes green",
    doc: "How often the session closed above its open, under whatever conditions you compose.",
    args: [],
    eligibility: () => "TRUE",
    success: () => "f.green",
    value: {
      sql: () => "f.ret_oc_pct",
      unit: "%",
      doc: "Open→close return distribution across eligible sessions.",
    },
    examples: ["closeGreen WHERE streak(red, 3)", "closeGreen WHERE insideDay"],
    library: [{ kind: "concept", slug: "session-open-close-behaviors" }],
  },
  {
    kind: "outcome",
    name: "nextCloseGreen",
    title: "Next session closes green",
    doc: "How often the NEXT session closed green given today's conditions: the day-after family of questions as one outcome.",
    args: [],
    eligibility: () => "f.next_green IS NOT NULL",
    success: () => "f.next_green",
    value: {
      sql: () => "f.next_ret_oc_pct",
      unit: "%",
      doc: "Next session's open→close return distribution.",
    },
    examples: ["nextCloseGreen WHERE insideDay", "nextCloseGreen WHERE nr7"],
  },
  {
    kind: "outcome",
    name: "orbBreak",
    title: "Opening range break",
    doc: "Of the sessions with a formed opening range, how often the range broke in the given direction.",
    args: [
      { name: "window", type: "duration", required: true, doc: "Opening-range window, e.g. 15m" },
      { name: "dir", type: "enum", values: DIRS, default: "any", doc: "Break direction to count" },
    ],
    eligibility: (a, ctx) => `${orCol(requireWindow(a.window as number, ctx), "high")} IS NOT NULL`,
    success: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const dir = a.dir as string;
      if (dir === "any") return `${orCol(w, "first_break")} IN ('up', 'down')`;
      return `${orCol(w, "first_break")} = '${dir}'`;
    },
    value: {
      sql: (a, ctx) => orCol(requireWindow(a.window as number, ctx), "break_min"),
      unit: "minutes",
      doc: "Minutes from the open to the first break, among breaking sessions.",
    },
    examples: ["orbBreak(15m, up)", "orbBreak(30m) WHERE gapUp"],
    library: [{ kind: "indicator", slug: "ultimate-opening-range-breakout" }],
  },
  {
    kind: "outcome",
    name: "orbFalseBreak",
    title: "Opening range false break",
    doc: "Of the sessions whose opening range first broke in the given direction, how often that break failed (closed back inside the range or beyond the opposite side).",
    args: [
      { name: "window", type: "duration", required: true, doc: "Opening-range window" },
      {
        name: "dir",
        type: "enum",
        values: DIRS,
        default: "any",
        doc: "Direction of the first break",
      },
    ],
    eligibility: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const dir = a.dir as string;
      if (dir === "any") return `${orCol(w, "first_break")} IN ('up', 'down')`;
      return `${orCol(w, "first_break")} = '${dir}'`;
    },
    success: (a, ctx) => `${orCol(requireWindow(a.window as number, ctx), "false_break")}`,
    library: [{ kind: "indicator", slug: "ultimate-opening-range-breakout" }],
  },
  {
    kind: "outcome",
    name: "orbTargetHit",
    title: "Opening range extension target hit",
    doc: "Of the sessions whose opening range first broke in the given direction, how often price extended at least r × the range beyond the broken side. Run a ladder of r values for target hit-rates.",
    args: [
      { name: "window", type: "duration", required: true, doc: "Opening-range window" },
      {
        name: "r",
        type: "number",
        required: true,
        doc: "Extension target in range multiples (e.g. 1 = one full range beyond the break)",
      },
      {
        name: "dir",
        type: "enum",
        values: DIRS,
        default: "any",
        doc: "Direction of the first break",
      },
    ],
    eligibility: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const dir = a.dir as string;
      if (dir === "any") return `${orCol(w, "first_break")} IN ('up', 'down')`;
      return `${orCol(w, "first_break")} = '${dir}'`;
    },
    success: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const r = sqlNum(a.r as number);
      return `(CASE ${orCol(w, "first_break")}
        WHEN 'up' THEN ${orCol(w, "ext_up_r")} >= ${r}
        WHEN 'down' THEN ${orCol(w, "ext_dn_r")} >= ${r}
        ELSE FALSE END)`;
    },
    value: {
      sql: (a, ctx) => {
        const w = requireWindow(a.window as number, ctx);
        return `(CASE ${orCol(w, "first_break")}
          WHEN 'up' THEN ${orCol(w, "ext_up_r")}
          WHEN 'down' THEN ${orCol(w, "ext_dn_r")}
          ELSE NULL END)`;
      },
      unit: "r",
      doc: "Extension beyond the broken side, in range multiples.",
    },
    examples: ["orbTargetHit(15m, 1)", "orbTargetHit(30m, 2, up)"],
    library: [{ kind: "indicator", slug: "ultimate-opening-range-breakout" }],
  },
  {
    kind: "outcome",
    name: "orbCloseBreak",
    title: "Opening range close-confirmed break",
    doc: "Of the sessions with a formed opening range, how often a bar CLOSED beyond the boundary in the given direction. Compare with orbBreak, which counts a mere touch.",
    args: [
      { name: "window", type: "duration", required: true, doc: "Opening-range window, e.g. 30m" },
      { name: "dir", type: "enum", values: DIRS, default: "any", doc: "Close-break direction" },
    ],
    eligibility: (a, ctx) => `${orCol(requireWindow(a.window as number, ctx), "high")} IS NOT NULL`,
    success: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const dir = a.dir as string;
      if (dir === "any") return `${orCol(w, "first_close_break")} IN ('up', 'down')`;
      return `${orCol(w, "first_close_break")} = ${sqlStr(dir)}`;
    },
    examples: ["orbCloseBreak(30m, up)"],
    library: [{ kind: "indicator", slug: "ultimate-opening-range-breakout" }],
  },
  {
    kind: "outcome",
    name: "orbCloseContinuation",
    title: "Opening range continuation held to the close",
    doc: "Of the sessions whose first CLOSE-confirmed break went in the given direction, how often the session's final close was still beyond that boundary. The close-confirmed counterpart of orbFalseBreak, and the honest test of continuation.",
    args: [
      { name: "window", type: "duration", required: true, doc: "Opening-range window, e.g. 30m" },
      { name: "dir", type: "enum", values: DIRS, default: "any", doc: "Direction of the first close break" },
    ],
    eligibility: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const dir = a.dir as string;
      if (dir === "any") return `${orCol(w, "first_close_break")} IN ('up', 'down')`;
      return `${orCol(w, "first_close_break")} = ${sqlStr(dir)}`;
    },
    success: (a, ctx) => `coalesce(NOT ${orCol(requireWindow(a.window as number, ctx), "false_close_break")}, FALSE)`,
    examples: ["orbCloseContinuation(30m, up)"],
    library: [{ kind: "indicator", slug: "ultimate-opening-range-breakout" }],
  },
  {
    kind: "outcome",
    name: "orbClosePos",
    title: "Where the session closed inside the range",
    doc: "Of the sessions whose first close-confirmed break went in the given direction, the distribution of the session's final close expressed in 0..1 range space (0 = range low, 1 = range high, beyond 0..1 = closed outside). Success = the close was still beyond the broken boundary.",
    args: [
      { name: "window", type: "duration", required: true, doc: "Opening-range window, e.g. 30m" },
      { name: "dir", type: "enum", values: DIRS, default: "any", doc: "Direction of the first close break" },
    ],
    eligibility: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const dir = a.dir as string;
      if (dir === "any") return `${orCol(w, "first_close_break")} IN ('up', 'down')`;
      return `${orCol(w, "first_close_break")} = ${sqlStr(dir)}`;
    },
    success: (a, ctx) => `coalesce(NOT ${orCol(requireWindow(a.window as number, ctx), "false_close_break")}, FALSE)`,
    value: {
      sql: (a, ctx) => orCol(requireWindow(a.window as number, ctx), "close_pos"),
      unit: "ratio",
      doc: "Session close position within the opening range; 0 = low, 1 = high.",
    },
    examples: ["orbClosePos(30m, up) WHERE eventDay('NEWS_0945')"],
    library: [{ kind: "indicator", slug: "ultimate-opening-range-breakout" }],
  },
  {
    kind: "outcome",
    name: "orbMidTestMin",
    title: "Minutes to the mid-band retest",
    doc: "Of the sessions that broke in the given direction, how often and how soon a bar close traded back into the mid band. The value distribution is the full time-of-retest profile.",
    args: [
      { name: "window", type: "duration", required: true, doc: "Opening-range window, e.g. 30m" },
      { name: "dir", type: "enum", values: DIRS, default: "any", doc: "Break direction" },
    ],
    eligibility: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const dir = a.dir as string;
      if (dir === "any") return `${orCol(w, "first_break")} IN ('up', 'down')`;
      return `${orCol(w, "first_break")} = ${sqlStr(dir)}`;
    },
    success: (a, ctx) => {
      const w = requireWindow(a.window as number, ctx);
      const dir = a.dir as string;
      if (dir === "up") return `${orCol(w, "up_band_enter_min")} IS NOT NULL`;
      if (dir === "down") return `${orCol(w, "dn_band_enter_min")} IS NOT NULL`;
      return `(CASE ${orCol(w, "first_break")}
        WHEN 'up' THEN ${orCol(w, "up_band_enter_min")}
        WHEN 'down' THEN ${orCol(w, "dn_band_enter_min")}
        ELSE NULL END) IS NOT NULL`;
    },
    value: {
      sql: (a, ctx) => {
        const w = requireWindow(a.window as number, ctx);
        return `(CASE ${orCol(w, "first_break")}
          WHEN 'up' THEN ${orCol(w, "up_band_enter_min")}
          WHEN 'down' THEN ${orCol(w, "dn_band_enter_min")}
          ELSE NULL END)`;
      },
      unit: "minutes",
      doc: "Minutes from the session open to the first close back inside the mid band.",
    },
    examples: ["orbMidTestMin(30m, up) WHERE eventDay('NEWS_0945')"],
    library: [{ kind: "indicator", slug: "ultimate-opening-range-breakout" }],
  },
  {
    kind: "outcome",
    name: "orbSecondBreakMin",
    title: "Minutes to the second side breaking",
    doc: "Of the sessions that broke BOTH sides of the range, when the second side was taken. The value distribution is the double-break timing profile.",
    args: [{ name: "window", type: "duration", required: true, doc: "Opening-range window, e.g. 30m" }],
    eligibility: (a, ctx) => `${orCol(requireWindow(a.window as number, ctx), "broke_both")}`,
    success: () => `TRUE`,
    value: {
      sql: (a, ctx) => orCol(requireWindow(a.window as number, ctx), "break2_min"),
      unit: "minutes",
      doc: "Minutes from the session open to the second side's first break.",
    },
    examples: ["orbSecondBreakMin(30m) WHERE eventDay('NEWS_1000')"],
    library: [{ kind: "indicator", slug: "ultimate-opening-range-breakout" }],
  },
  {
    kind: "outcome",
    name: "ibExtension",
    title: "Initial balance extension",
    doc: "Of the sessions that broke their initial balance in the given direction, how often price extended at least r × the IB range beyond the broken side.",
    args: [
      { name: "r", type: "number", required: true, doc: "Extension target in IB-range multiples" },
      { name: "dir", type: "enum", values: DIRS, default: "any", doc: "Break side" },
    ],
    eligibility: (a) => {
      const dir = a.dir as string;
      if (dir === "any") return `f.ib_break <> 'none' AND f.ib_break IS NOT NULL`;
      return `f.ib_break IN ('single_${dir}', 'double')`;
    },
    success: (a, ctx) => {
      const w = ctx.ibWindow;
      const r = sqlNum(a.r as number);
      const dir = a.dir as string;
      if (dir === "up") return `coalesce(${orCol(w, "ext_up_r")}, 0) >= ${r}`;
      if (dir === "down") return `coalesce(${orCol(w, "ext_dn_r")}, 0) >= ${r}`;
      return `(coalesce(${orCol(w, "ext_up_r")}, 0) >= ${r} OR coalesce(${orCol(w, "ext_dn_r")}, 0) >= ${r})`;
    },
    library: [
      { kind: "concept", slug: "initial-balance" },
      { kind: "indicator", slug: "initial-balance-breakout-signals" },
    ],
  },
  {
    kind: "outcome",
    name: "touchPrevHigh",
    title: "Touches prior high",
    doc: "How often the session traded at or above the prior session's high.",
    args: [],
    eligibility: () => "f.prev_high IS NOT NULL",
    success: () => "f.touched_prev_high",
    value: {
      sql: () => "f.touch_prev_high_min",
      unit: "minutes",
      doc: "Minutes from the open to the touch, among touching sessions.",
    },
    examples: ["touchPrevHigh WHERE openPosInPrevRange >= 0.5"],
    library: [{ kind: "indicator", slug: "session-levels-predictor" }],
  },
  {
    kind: "outcome",
    name: "touchPrevLow",
    title: "Touches prior low",
    doc: "How often the session traded at or below the prior session's low.",
    args: [],
    eligibility: () => "f.prev_low IS NOT NULL",
    success: () => "f.touched_prev_low",
    value: {
      sql: () => "f.touch_prev_low_min",
      unit: "minutes",
      doc: "Minutes from the open to the touch, among touching sessions.",
    },
    library: [{ kind: "indicator", slug: "session-levels-predictor" }],
  },
  {
    kind: "outcome",
    name: "breakHoldPrevHigh",
    title: "Breaks and holds prior high",
    doc: "Of the sessions that touched the prior high, how often they also closed above it.",
    args: [],
    eligibility: () => "f.touched_prev_high",
    success: () => "f.closed_above_prev_high",
    library: [{ kind: "indicator", slug: "session-levels-predictor" }],
  },
  {
    kind: "outcome",
    name: "breakHoldPrevLow",
    title: "Breaks and holds prior low",
    doc: "Of the sessions that touched the prior low, how often they also closed below it.",
    args: [],
    eligibility: () => "f.touched_prev_low",
    success: () => "f.closed_below_prev_low",
  },
  {
    kind: "outcome",
    name: "timeOfHighBefore",
    title: "Session high prints early",
    doc: "How often the session high printed within the first m minutes. The value distribution is the full time-of-high profile.",
    args: [
      { name: "within", type: "duration", required: true, doc: "Window from the open, e.g. 60m" },
    ],
    eligibility: () => "f.high_time_min IS NOT NULL",
    success: (a) => `f.high_time_min < ${sqlNum(a.within as number)}`,
    value: {
      sql: () => "f.high_time_min",
      unit: "minutes",
      doc: "Minutes from the open to the session high, across eligible sessions.",
    },
    library: [{ kind: "concept", slug: "session-high-low-statistics" }],
  },
  {
    kind: "outcome",
    name: "timeOfLowBefore",
    title: "Session low prints early",
    doc: "How often the session low printed within the first m minutes. The value distribution is the full time-of-low profile.",
    args: [{ name: "within", type: "duration", required: true, doc: "Window from the open" }],
    eligibility: () => "f.low_time_min IS NOT NULL",
    success: (a) => `f.low_time_min < ${sqlNum(a.within as number)}`,
    value: {
      sql: () => "f.low_time_min",
      unit: "minutes",
      doc: "Minutes from the open to the session low, across eligible sessions.",
    },
    library: [{ kind: "concept", slug: "session-high-low-statistics" }],
  },
  {
    kind: "outcome",
    name: "hit",
    title: "Threshold hit (generic)",
    doc: "The escape hatch: P(field ⋈ value) for any numeric field in the registry. Composable with any conditions: if the stat you want is not a named outcome, it is probably one hit() away.",
    args: [
      {
        name: "field",
        type: "string",
        required: true,
        doc: `Numeric field name (${numericFieldNames.slice(0, 6).join(", ")}, …)`,
      },
      {
        name: "cmp",
        type: "enum",
        values: ["gte", "gt", "lte", "lt"] as const,
        required: true,
        doc: "Comparison",
      },
      { name: "value", type: "number", required: true, doc: "Threshold" },
    ],
    eligibility: (a) => `${numericFieldSql(String(a.field))} IS NOT NULL`,
    success: (a) => {
      const cmp = CMPS[String(a.cmp)];
      if (!cmp) throw new QueryError(`unknown comparison '${String(a.cmp)}'`);
      return `${numericFieldSql(String(a.field))} ${cmp} ${sqlNum(a.value as number)}`;
    },
    value: {
      sql: (a) => numericFieldSql(String(a.field)),
      unit: "field",
      doc: "Distribution of the field itself across eligible sessions.",
    },
    examples: ["hit(retOcPct, gte, 0.5) WHERE gapUp", "hit(rangeVsAtr, gte, 1.5) WHERE nr7"],
  },
  {
    kind: "outcome",
    name: "eventOccurs",
    title: "Event occurs on the session",
    doc: "How often the session's trade date appears in the named events calendar. Every session is eligible, so this is the event's frequency under your conditions. Built for trade tags (TRADED, TRADED_WIN, TRADED_LOSS from `edgestats trades import`): eventOccurs('TRADED_WIN') WHERE <setup> is your realized day-win rate on that setup, comparable against the same query unconditioned.",
    args: [
      {
        name: "event",
        type: "string",
        required: true,
        doc: "Event name as listed in the events data (macro calendars or trade tags)",
      },
    ],
    eligibility: () => "TRUE",
    success: (a) =>
      `EXISTS (SELECT 1 FROM events e WHERE e.date = f.trade_date AND e.event = ${sqlStr(String(a.event))})`,
    examples: [
      "eventOccurs('TRADED_WIN') WHERE eventDay('TRADED')",
      "eventOccurs('TRADED') WHERE eventDay('FOMC')",
    ],
  },
  {
    kind: "outcome",
    name: "pmBreakSingle",
    title: "PM opening range single break",
    doc: "How often the PM opening range (13:30-14:00) broke on exactly one side between 14:00 and 16:00.",
    args: [],
    eligibility: () => "f.pm_or_single_break IS NOT NULL",
    success: () => "f.pm_or_single_break",
    examples: ["pmBreakSingle WHERE lunchSweptAm", "pmBreakSingle WHERE lunchSweptAmHigh"],
  },
  {
    kind: "outcome",
    name: "pmBreakDouble",
    title: "PM opening range double break",
    doc: "How often the PM opening range (13:30-14:00) broke on both sides between 14:00 and 16:00.",
    args: [],
    eligibility: () => "f.pm_or_double_break IS NOT NULL",
    success: () => "f.pm_or_double_break",
    examples: ["pmBreakDouble WHERE lunchSweptAm"],
  },
  {
    kind: "outcome",
    name: "newsSweptBothSides",
    title: "08:30 news candle swept both sides in RTH",
    doc: "How often price during RTH swept both the high and low of the 08:30 ET news candle.",
    args: [],
    eligibility: () => "f.news_830_high IS NOT NULL AND f.news_830_low IS NOT NULL",
    success: () => "f.news_wick_both_sides",
    examples: ["newsSweptBothSides WHERE gapUp", "newsSweptBothSides WHERE nr7"],
  },
  {
    kind: "outcome",
    name: "orgRetraced30m",
    title: "Price retraced into 50% ORG in first 30m",
    doc: "How often price retraced into 50% of the opening range gap during the first 30 minutes of the session.",
    args: [],
    eligibility: () => "f.org_into_30m IS NOT NULL",
    success: () => "f.org_into_30m",
    examples: ["orgRetraced30m WHERE gapUp"],
  },
  {
    kind: "outcome",
    name: "weeklyOpenRetrace",
    title: "Weekly open retraced",
    doc: "How often the session trades through the current ISO week's opening price (roll-masked).",
    args: [],
    eligibility: () => "f.weekly_open_retrace IS NOT NULL",
    success: () => "f.weekly_open_retrace",
    examples: ["weeklyOpenRetrace GROUP BY dayOfWeek"],
  },
  {
    kind: "outcome",
    name: "priorWeekHighBreak",
    title: "Prior week high broken",
    doc: "How often the session breaks above the prior completed ISO week's high (roll-masked).",
    args: [],
    eligibility: () => "f.prior_week_high_broken IS NOT NULL",
    success: () => "f.prior_week_high_broken",
    examples: ["priorWeekHighBreak GROUP BY dayOfWeek"],
  },
  {
    kind: "outcome",
    name: "priorWeekLowBreak",
    title: "Prior week low broken",
    doc: "How often the session breaks below the prior completed ISO week's low (roll-masked).",
    args: [],
    eligibility: () => "f.prior_week_low_broken IS NOT NULL",
    success: () => "f.prior_week_low_broken",
    examples: ["priorWeekLowBreak GROUP BY dayOfWeek"],
  },
  {
    kind: "outcome",
    name: "fvg1mHeld",
    title: "Post-OR30 1m FVG held on retest",
    doc: "How often a retested post-OR30 1m FVG held without closing through its far boundary.",
    args: [],
    eligibility: () => "f.fvg1m_held IS NOT NULL",
    success: () => "f.fvg1m_held",
    value: {
      sql: () => "f.fvg1m_fill_depth_pct",
      unit: "%",
      doc: "Distribution of FVG fill depth (%) across retested 1m FVGs.",
    },
    examples: ["fvg1mHeld GROUP BY dayOfWeek"],
  },
  {
    kind: "outcome",
    name: "fvg1mRetestWin",
    title: "Post-OR30 1m FVG retest CTQ win",
    doc: "Win rate and realized PnL distribution (bps) of Cover-the-Queen (12 SL / +10 Q / +25 R) on the first post-OR30 1m FVG retest.",
    args: [],
    eligibility: () => "f.fvg1m_ret_ctq12_bps IS NOT NULL",
    success: () => "f.fvg1m_ret_ctq12_bps > 0",
    value: {
      sql: () => "f.fvg1m_ret_ctq12_bps",
      unit: "bps",
      doc: "Realized CTQ 12/10/25 PnL in bps across retested 1m FVGs.",
    },
    examples: ["fvg1mRetestWin WHERE or30RangeBps >= 20", "fvg1mRetestWin GROUP BY dayOfWeek"],
  },
  {
    kind: "outcome",
    name: "fvg5mRetestWin",
    title: "Post-OR30 5m FVG retest CTQ win",
    doc: "Win rate and realized PnL distribution (bps) of Cover-the-Queen (12 SL / +10 Q / +25 R) on the first post-OR30 5m FVG retest.",
    args: [],
    eligibility: () => "f.fvg5m_ret_ctq12_bps IS NOT NULL",
    success: () => "f.fvg5m_ret_ctq12_bps > 0",
    value: {
      sql: () => "f.fvg5m_ret_ctq12_bps",
      unit: "bps",
      doc: "Realized CTQ 12/10/25 PnL in bps across retested 5m FVGs.",
    },
    examples: ["fvg5mRetestWin WHERE or30RangeBps >= 35"],
  },
  {
    kind: "outcome",
    name: "p3b5mWin",
    title: "Post-OR30 5m P3B sweep fade CTQ win",
    doc: "Win rate and realized PnL distribution (bps) of Cover-the-Queen (12 SL / +10 Q / +25 R) on the first post-OR30 5m FVG sweep fade.",
    args: [],
    eligibility: () => "f.p3b5m_ctq12_bps IS NOT NULL",
    success: () => "f.p3b5m_ctq12_bps > 0",
    value: {
      sql: () => "f.p3b5m_ctq12_bps",
      unit: "bps",
      doc: "Realized CTQ 12/10/25 PnL in bps across 5m sweep fades.",
    },
    examples: ["p3b5mWin GROUP BY dayOfWeek"],
  },
  // ── Daily Profiler outcomes ─────────────────────────────────────────────────
  {
    kind: "outcome",
    name: "profilerOutcome",
    title: "Profiler session outcome",
    doc: "Frequency of a target Profiler session ending in LT, LF, ST, SF, None, or grouped True/False/Long/Short, conditioned on any prior session sequence.",
    args: [
      {
        name: "session",
        type: "enum",
        values: ["asia", "london", "ny1", "ny2"] as const,
        required: true,
        doc: "Target Profiler session",
      },
      {
        name: "target",
        type: "enum",
        values: ["LT", "LF", "ST", "SF", "None", "True", "False", "Long", "Short"] as const,
        required: true,
        doc: "Target outcome",
      },
    ],
    eligibility: (a) => `d.${String(a.session)}_status IS NOT NULL`,
    success: (a) => {
      const col = `d.${String(a.session)}_status`;
      const t = String(a.target);
      if (t === "True") return `${col} IN ('LT', 'ST')`;
      if (t === "False") return `${col} IN ('LF', 'SF')`;
      if (t === "Long") return `${col} IN ('LT', 'LF')`;
      if (t === "Short") return `${col} IN ('ST', 'SF')`;
      return `${col} = ${sqlStr(t)}`;
    },
    value: {
      sql: (a) => {
        const s = String(a.session);
        const t = String(a.target);
        return t === "ST" || t === "SF" || t === "Short"
          ? `d.${s}_eval_low_bps`
          : `d.${s}_eval_high_bps`;
      },
      unit: "bps",
      doc: "Evaluation-window directional excursion from box open in bps.",
    },
    examples: [
      "profilerOutcome(ny2, LT) WHERE sessionStatus(asia, LT) AND sessionStatus(london, LT) AND sessionStatus(ny1, ST)",
    ],
  },
  {
    kind: "outcome",
    name: "profilerBroken",
    title: "Profiler session mid broken",
    doc: "Frequency that a Profiler session's midpoint is touched during its broken window (excludes unresolved NY2 days).",
    args: [
      {
        name: "session",
        type: "enum",
        values: ["asia", "london", "ny1", "ny2"] as const,
        required: true,
        doc: "Target Profiler session",
      },
    ],
    eligibility: (a) => `d.${String(a.session)}_broken IS NOT NULL`,
    success: (a) => `d.${String(a.session)}_broken = TRUE`,
    value: {
      sql: (a) => `d.${String(a.session)}_broken_at_min`,
      unit: "minutes",
      doc: "Minutes from 18:00 ET when the midpoint was first touched.",
    },
    examples: ["profilerBroken(ny1) WHERE sessionStatus(ny1, LT)"],
  },
  {
    kind: "outcome",
    name: "levelTouch",
    title: "Reference level touch rate",
    doc: "Probability that one of the 20 Profiler reference levels is touched after its formation window.",
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
    ],
    eligibility: (a) => `d.touch_${String(a.level)} IS NOT NULL`,
    success: (a) => `d.touch_${String(a.level)} = TRUE`,
    value: {
      sql: (a) => `d.touch_${String(a.level)}_min`,
      unit: "minutes",
      doc: "Minutes from 18:00 ET to first touch of the level.",
    },
    examples: ["levelTouch(p12m) WHERE p12ScenarioIs(2)"],
  },
  {
    kind: "outcome",
    name: "sessionMadeHod",
    title: "Session printed daily HOD",
    doc: "Probability that the specified Globex session printed the day's high.",
    args: [
      {
        name: "session",
        type: "enum",
        values: ["asia", "london", "ny1", "ny2", "post_ny2"] as const,
        required: true,
        doc: "Session name",
      },
    ],
    eligibility: () => "d.hod_session IS NOT NULL",
    success: (a) => `d.hod_session = ${sqlStr(String(a.session))}`,
    value: {
      sql: () => "d.daily_high_bps",
      unit: "bps",
      doc: "Daily high excursion above 18:00 open in bps.",
    },
    examples: ["sessionMadeHod(ny2) WHERE overnightAligned(long)"],
  },
  {
    kind: "outcome",
    name: "sessionMadeLod",
    title: "Session printed daily LOD",
    doc: "Probability that the specified Globex session printed the day's low.",
    args: [
      {
        name: "session",
        type: "enum",
        values: ["asia", "london", "ny1", "ny2", "post_ny2"] as const,
        required: true,
        doc: "Session name",
      },
    ],
    eligibility: () => "d.lod_session IS NOT NULL",
    success: (a) => `d.lod_session = ${sqlStr(String(a.session))}`,
    value: {
      sql: () => "d.daily_low_bps",
      unit: "bps",
      doc: "Daily low excursion below 18:00 open in bps.",
    },
    examples: ["sessionMadeLod(london) WHERE sessionStatus(asia, ST)"],
  },
  // ── Candle Science v17.5 outcomes ───────────────────────────────────────────
  {
    kind: "outcome",
    name: "csBull",
    title: "Candle Science C3 closes bullish",
    doc: "Probability that C3 closes above C3 open (roll-safe C1->C2->C3 triplets).",
    args: [],
    eligibility: () => "cs.roll_safe = TRUE",
    success: () => "cs.c3_bull = TRUE",
    value: {
      sql: () => "cs.mfe_long_c3o_bps",
      unit: "bps",
      doc: "C3 high minus C3 open in bps of C3 open.",
    },
    examples: ["csBull WHERE csC1Dir = bull AND csC2Dir = bull"],
  },
  {
    kind: "outcome",
    name: "csBreakHigh",
    title: "Candle Science C3 breaks C2 high",
    doc: "Probability that C3 high strictly exceeds C2 high, with breakout excursion distribution (bps of C2 close).",
    args: [],
    eligibility: () => "cs.roll_safe = TRUE",
    success: () => "cs.c3h_gt_c2h = TRUE",
    value: {
      sql: () => "CASE WHEN cs.c3h_gt_c2h THEN cs.dist_c3h_c2h_bps ELSE NULL END",
      unit: "bps",
      doc: "(C3H - C2H) / C2C in bps among sessions breaking C2H (P30/P50/P70 target box).",
    },
    examples: ["csBreakHigh WHERE csDim(c2c_gt_c1h, yes)"],
  },
  {
    kind: "outcome",
    name: "csBreakLow",
    title: "Candle Science C3 breaks C2 low",
    doc: "Probability that C3 low strictly breaks below C2 low, with downside excursion distribution (bps of C2 close).",
    args: [],
    eligibility: () => "cs.roll_safe = TRUE",
    success: () => "cs.c3l_lt_c2l = TRUE",
    value: {
      sql: () => "CASE WHEN cs.c3l_lt_c2l THEN abs(cs.dist_c3l_c2l_bps) ELSE NULL END",
      unit: "bps",
      doc: "|C3L - C2L| / C2C in bps among sessions breaking C2L (P30/P50/P70 target box).",
    },
    examples: ["csBreakLow WHERE csDim(c2c_gt_c1l, no)"],
  },
  {
    kind: "outcome",
    name: "csCloseAbove",
    title: "Candle Science C3 closes above C2 reference",
    doc: "Probability that C3 close finishes above C2H, C2O, C2C, or C2L.",
    args: [
      {
        name: "ref",
        type: "enum",
        values: ["c2h", "c2o", "c2c", "c2l"] as const,
        required: true,
        doc: "C2 reference level",
      },
    ],
    eligibility: () => "cs.roll_safe = TRUE",
    success: (a) => `cs.c3c_gt_${String(a.ref)} = TRUE`,
    examples: ["csCloseAbove(c2h) WHERE csDim(c2c_gt_c1h, yes)"],
  },
];
