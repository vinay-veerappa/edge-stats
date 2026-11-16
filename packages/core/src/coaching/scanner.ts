import { DateTime } from "luxon";

export interface CoachingBar {
  tsMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface OrgState {
  priorClose: number | null;
  rthOpen: number;
  gapBps: number | null;
  gapDir: "UP" | "DOWN" | "FLAT" | "UNKNOWN";
  orgInto30m: boolean;
  orgAway30m: boolean;
  gapFilled: boolean;
}

export interface Orb30State {
  ready: boolean;
  high: number | null;
  low: number | null;
  mid: number | null;
  rangeBps: number | null;
  ext25Up: number | null;
  ext25Down: number | null;
  orb25ExtReject: "BULL_REJ" | "BEAR_REJ" | "NONE";
  extremeLockedEarly: boolean;
  orbMidTouchedAfter1000: boolean;
}

export interface Fvg10amState {
  status: "NONE" | "FORMED" | "HELD" | "VIOLATED";
  direction: "BULL" | "BEAR" | null;
  formedAtEt: string | null;
  zoneLow: number | null;
  zoneHigh: number | null;
  touched: boolean;
  maeBps: number | null;
  stopFit10bps: boolean | null;
}

export interface Q3AstraState {
  activeQuarter: "Q1" | "Q2" | "Q3" | "Q4" | "OUTSIDE";
  cycleLabel: string | null;
  lunchGated: boolean;
  tmso: number | null;
  nearestDttAnchor: string | null;
  ifvgConfirmed: "BULL" | "BEAR" | null;
}

export interface ChopTimerState {
  active: boolean;
  amRangeBps: number;
  minsSinceAmExtreme: number | null;
  phase:
    | "NONE"
    | "HIGH_CHOP_0_25M"
    | "DIGESTION_25_52M"
    | "EXPANSION_READY_52M_PLUS"
    | "BREAKOUT_WATCH_95M_PLUS";
}

export interface InstrumentCoachState {
  symbol: string;
  tradeDate: string;
  asOfEt: string;
  lastPrice: number;
  org: OrgState;
  orb30: Orb30State;
  fvg10am: Fvg10amState;
  q3Astra: Q3AstraState;
  noonGate: "NO_NOON_FADE" | "NEUTRAL";
  chopTimer: ChopTimerState;
  edgeStats?: Array<{
    label: string;
    n: number;
    estimate: number | null;
    ci95: [number, number] | null;
  }>;
}

export interface CrossInstrumentRoute {
  bestInstrument: string | null;
  avoidInstruments: string[];
  headline: string;
  reasons: string[];
}

export interface MarketCoachingSnapshot {
  tradeDate: string;
  evaluatedAtUtc: string;
  instruments: InstrumentCoachState[];
  routing: CrossInstrumentRoute;
}

interface EtBar extends CoachingBar {
  hhmm: number;
  etLabel: string;
}

const CYCLES = [
  { label: "09:00", q1: 540, q2: 563, q3: 585, q4: 608, end: 630, lunchGated: false },
  { label: "10:30", q1: 630, q2: 653, q3: 675, q4: 698, end: 720, lunchGated: false },
  { label: "12:00", q1: 720, q2: 743, q3: 765, q4: 788, end: 810, lunchGated: true },
  { label: "13:30", q1: 810, q2: 833, q3: 855, q4: 878, end: 900, lunchGated: false },
] as const;

const DTT_ANCHORS: Array<{ hhmm: number; label: string }> = [
  { hhmm: 9 * 60 + 53, label: "09:53" },
  { hhmm: 10 * 60 + 34, label: "10:34" },
  { hhmm: 11 * 60 + 10, label: "11:10" },
  { hhmm: 12 * 60 + 35, label: "12:35" },
  { hhmm: 13 * 60 + 30, label: "13:30" },
];

function toEtBars(bars: CoachingBar[]): EtBar[] {
  return bars
    .map((b) => {
      const dt = DateTime.fromMillis(b.tsMs, { zone: "America/New_York" });
      return {
        ...b,
        hhmm: dt.hour * 60 + dt.minute,
        etLabel: dt.toFormat("HH:mm"),
      };
    })
    .filter((b) => b.hhmm >= 9 * 60 && b.hhmm < 16 * 60)
    .sort((a, b) => a.tsMs - b.tsMs);
}

function build5mBars(bars: EtBar[], startHhmm: number, endHhmm: number): EtBar[] {
  const buckets = new Map<number, EtBar[]>();
  for (const b of bars) {
    if (b.hhmm < startHhmm || b.hhmm >= endHhmm) continue;
    const bucket = Math.floor(b.hhmm / 5) * 5;
    const arr = buckets.get(bucket) ?? [];
    arr.push(b);
    buckets.set(bucket, arr);
  }
  const out: EtBar[] = [];
  for (const bucket of [...buckets.keys()].sort((a, b) => a - b)) {
    const grp = buckets.get(bucket)!;
    if (grp.length < 5 && bucket + 5 <= (bars[bars.length - 1]?.hhmm ?? 0)) {
      // keep partial only if needed; require at least 1 bar
    }
    out.push({
      tsMs: grp[0]!.tsMs,
      open: grp[0]!.open,
      high: Math.max(...grp.map((x) => x.high)),
      low: Math.min(...grp.map((x) => x.low)),
      close: grp[grp.length - 1]!.close,
      hhmm: bucket,
      etLabel: grp[0]!.etLabel,
    });
  }
  return out;
}

function computeOrg(rthBars: EtBar[], priorClose: number | null): OrgState {
  const rthOpen = rthBars[0]!.open;
  if (priorClose == null || priorClose <= 0) {
    return {
      priorClose: null,
      rthOpen,
      gapBps: null,
      gapDir: "UNKNOWN",
      orgInto30m: false,
      orgAway30m: false,
      gapFilled: false,
    };
  }
  const gapBps = Number((((rthOpen - priorClose) / priorClose) * 10000).toFixed(1));
  const gapDir = gapBps > 2 ? "UP" : gapBps < -2 ? "DOWN" : "FLAT";
  const ce50 = priorClose + 0.5 * (rthOpen - priorClose);
  const first30 = rthBars.filter((b) => b.hhmm < 10 * 60);
  const orgInto30m =
    gapDir === "UP"
      ? first30.some((b) => b.low <= ce50)
      : gapDir === "DOWN"
        ? first30.some((b) => b.high >= ce50)
        : false;
  const gapFilled =
    gapDir === "UP"
      ? rthBars.some((b) => b.low <= priorClose)
      : gapDir === "DOWN"
        ? rthBars.some((b) => b.high >= priorClose)
        : false;
  return {
    priorClose,
    rthOpen,
    gapBps,
    gapDir,
    orgInto30m,
    orgAway30m: gapDir !== "FLAT" && !orgInto30m && first30.length >= 25,
    gapFilled,
  };
}

function computeOrb30(rthBars: EtBar[]): Orb30State {
  const orbBars = rthBars.filter((b) => b.hhmm >= 9 * 60 + 30 && b.hhmm < 10 * 60);
  const lastHhmm = rthBars[rthBars.length - 1]!.hhmm;
  if (orbBars.length === 0 || lastHhmm < 10 * 60) {
    return {
      ready: false,
      high: null,
      low: null,
      mid: null,
      rangeBps: null,
      ext25Up: null,
      ext25Down: null,
      orb25ExtReject: "NONE",
      extremeLockedEarly: false,
      orbMidTouchedAfter1000: false,
    };
  }
  const high = Math.max(...orbBars.map((b) => b.high));
  const low = Math.min(...orbBars.map((b) => b.low));
  const mid = (high + low) / 2;
  const span = high - low;
  const rangeBps = Number(((span / rthBars[0]!.open) * 10000).toFixed(1));
  const ext25Up = high + 0.25 * span;
  const ext30Up = high + 0.3 * span;
  const ext25Down = low - 0.25 * span;
  const ext30Down = low - 0.3 * span;

  const post = rthBars.filter((b) => b.hhmm >= 10 * 60);
  let orb25ExtReject: "BULL_REJ" | "BEAR_REJ" | "NONE" = "NONE";
  let taggedDown = false;
  let taggedUp = false;
  for (const b of post) {
    if (b.low <= ext25Down && b.close >= ext30Down) taggedDown = true;
    if (taggedDown && b.close > low) {
      orb25ExtReject = "BULL_REJ";
      break;
    }
    if (b.high >= ext25Up && b.close <= ext30Up) taggedUp = true;
    if (taggedUp && b.close < high) {
      orb25ExtReject = "BEAR_REJ";
      break;
    }
  }

  const sessHigh = Math.max(...rthBars.map((b) => b.high));
  const sessLow = Math.min(...rthBars.map((b) => b.low));
  const earlyBars = rthBars.filter((b) => b.hhmm < 9 * 60 + 45);
  const earlyHigh = Math.max(...earlyBars.map((b) => b.high));
  const earlyLow = Math.min(...earlyBars.map((b) => b.low));
  const extremeLockedEarly = earlyHigh >= sessHigh || earlyLow <= sessLow;
  const orbMidTouchedAfter1000 = post.some((b) => b.low <= mid && b.high >= mid);

  return {
    ready: true,
    high,
    low,
    mid,
    rangeBps,
    ext25Up,
    ext25Down,
    orb25ExtReject,
    extremeLockedEarly,
    orbMidTouchedAfter1000,
  };
}

function compute10amFvg(rthBars: EtBar[]): Fvg10amState {
  const fvgBars = build5mBars(rthBars, 10 * 60, 10 * 60 + 30);
  if (fvgBars.length < 3) {
    return {
      status: "NONE",
      direction: null,
      formedAtEt: null,
      zoneLow: null,
      zoneHigh: null,
      touched: false,
      maeBps: null,
      stopFit10bps: null,
    };
  }
  let dir: "BULL" | "BEAR" | null = null;
  let zoneLow = 0;
  let zoneHigh = 0;
  let formedHhmm = 0;
  let formedAtEt = "";
  for (let i = 2; i < fvgBars.length; i++) {
    const a = fvgBars[i - 2]!;
    const c = fvgBars[i]!;
    if (c.low > a.high) {
      dir = "BULL";
      zoneLow = a.high;
      zoneHigh = c.low;
      formedHhmm = c.hhmm + 5;
      formedAtEt = c.etLabel;
      break;
    }
    if (c.high < a.low) {
      dir = "BEAR";
      zoneLow = c.high;
      zoneHigh = a.low;
      formedHhmm = c.hhmm + 5;
      formedAtEt = c.etLabel;
      break;
    }
  }
  if (!dir) {
    return {
      status: "NONE",
      direction: null,
      formedAtEt: null,
      zoneLow: null,
      zoneHigh: null,
      touched: false,
      maeBps: null,
      stopFit10bps: null,
    };
  }

  const after = rthBars.filter((b) => b.hhmm >= formedHhmm);
  let touched = false;
  let violated = false;
  let maxAdverse = 0;
  for (const b of after) {
    if (dir === "BULL") {
      if (b.low <= zoneHigh) {
        touched = true;
        maxAdverse = Math.max(maxAdverse, ((zoneHigh - b.low) / zoneHigh) * 10000);
      }
      if (b.close < zoneLow) {
        violated = true;
        break;
      }
    } else {
      if (b.high >= zoneLow) {
        touched = true;
        maxAdverse = Math.max(maxAdverse, ((b.high - zoneLow) / zoneLow) * 10000);
      }
      if (b.close > zoneHigh) {
        violated = true;
        break;
      }
    }
  }
  const maeBps = touched ? Number(maxAdverse.toFixed(1)) : 0;
  const status = violated ? "VIOLATED" : touched ? "HELD" : "FORMED";
  return {
    status,
    direction: dir,
    formedAtEt,
    zoneLow,
    zoneHigh,
    touched,
    maeBps,
    stopFit10bps: maeBps <= 10.0,
  };
}

function computeQ3Astra(bars: EtBar[]): Q3AstraState {
  const last = bars[bars.length - 1]!;
  const hhmm = last.hhmm;
  const cycle = CYCLES.find((c) => hhmm >= c.q1 && hhmm < c.end) ?? null;
  let activeQuarter: Q3AstraState["activeQuarter"] = "OUTSIDE";
  let tmso: number | null = null;
  if (cycle) {
    if (hhmm < cycle.q2) activeQuarter = "Q1";
    else if (hhmm < cycle.q3) activeQuarter = "Q2";
    else if (hhmm < cycle.q4) activeQuarter = "Q3";
    else activeQuarter = "Q4";
    const q2Bar = bars.find((b) => b.hhmm >= cycle.q2);
    if (q2Bar) tmso = q2Bar.open;
  }

  let nearestDttAnchor: string | null = null;
  let bestDist = Infinity;
  for (const a of DTT_ANCHORS) {
    const d = Math.abs(hhmm - a.hhmm);
    if (d <= 15 && d < bestDist) {
      bestDist = d;
      nearestDttAnchor = a.label;
    }
  }

  let ifvgConfirmed: "BULL" | "BEAR" | null = null;
  if (cycle && hhmm >= cycle.q3) {
    const qBars = bars.filter((b) => b.hhmm >= cycle.q2 && b.hhmm < cycle.end);
    for (let i = 2; i < qBars.length - 1; i++) {
      const a = qBars[i - 2]!;
      const c = qBars[i]!;
      if (c.high < a.low) {
        const mid = (c.high + a.low) / 2;
        if (qBars.slice(i + 1).some((x) => x.hhmm >= cycle.q3 && x.close >= mid && x.close > a.low)) {
          ifvgConfirmed = "BULL";
        }
      } else if (c.low > a.high) {
        const mid = (a.high + c.low) / 2;
        if (qBars.slice(i + 1).some((x) => x.hhmm >= cycle.q3 && x.close <= mid && x.close < a.high)) {
          ifvgConfirmed = "BEAR";
        }
      }
    }
  }

  return {
    activeQuarter,
    cycleLabel: cycle?.label ?? null,
    lunchGated: cycle?.lunchGated ?? false,
    tmso,
    nearestDttAnchor,
    ifvgConfirmed,
  };
}

function computeChopTimer(rthBars: EtBar[]): ChopTimerState {
  const am = rthBars.filter((b) => b.hhmm < 11 * 60);
  if (am.length < 15) {
    return { active: false, amRangeBps: 0, minsSinceAmExtreme: null, phase: "NONE" };
  }
  const o0 = am[0]!.open;
  let amHigh = -Infinity;
  let amLow = Infinity;
  let hiHhmm = am[0]!.hhmm;
  let loHhmm = am[0]!.hhmm;
  for (const b of am) {
    if (b.high > amHigh) {
      amHigh = b.high;
      hiHhmm = b.hhmm;
    }
    if (b.low < amLow) {
      amLow = b.low;
      loHhmm = b.hhmm;
    }
  }
  const amRangeBps = Number((((amHigh - amLow) / o0) * 10000).toFixed(1));
  if (amRangeBps < 100) {
    return { active: false, amRangeBps, minsSinceAmExtreme: null, phase: "NONE" };
  }
  const extHhmm = Math.max(hiHhmm, loHhmm);
  const mins = Math.max(0, rthBars[rthBars.length - 1]!.hhmm - extHhmm);
  const phase: ChopTimerState["phase"] =
    mins < 25
      ? "HIGH_CHOP_0_25M"
      : mins < 52
        ? "DIGESTION_25_52M"
        : mins < 95
          ? "EXPANSION_READY_52M_PLUS"
          : "BREAKOUT_WATCH_95M_PLUS";
  return { active: true, amRangeBps, minsSinceAmExtreme: mins, phase };
}

export function evaluateInstrumentSession(
  symbol: string,
  tradeDate: string,
  bars: CoachingBar[],
  priorClose: number | null,
): InstrumentCoachState {
  const etBars = toEtBars(bars);
  const rthBars = etBars.filter((b) => b.hhmm >= 9 * 60 + 30);
  if (rthBars.length === 0) {
    if (bars.length === 0) {
      throw new Error(`No bars for ${symbol} on ${tradeDate}`);
    }
    const sorted = [...bars].sort((a, b) => a.tsMs - b.tsMs);
    const lastRaw = sorted[sorted.length - 1]!;
    const lastDt = DateTime.fromMillis(lastRaw.tsMs, { zone: "America/New_York" });
    const globexOpen = sorted[0]!.open;
    const gapBps =
      priorClose && priorClose > 0
        ? Number((((lastRaw.close - priorClose) / priorClose) * 10000).toFixed(1))
        : null;
    const gapDir =
      gapBps === null ? "UNKNOWN" : gapBps > 2 ? "UP" : gapBps < -2 ? "DOWN" : "FLAT";
    return {
      symbol,
      tradeDate,
      asOfEt: lastDt.toFormat("HH:mm"),
      lastPrice: lastRaw.close,
      org: {
        priorClose,
        rthOpen: globexOpen,
        gapBps,
        gapDir,
        orgInto30m: false,
        orgAway30m: false,
        gapFilled: false,
      },
      orb30: {
        ready: false,
        high: null,
        low: null,
        mid: null,
        rangeBps: null,
        ext25Up: null,
        ext25Down: null,
        orb25ExtReject: "NONE",
        extremeLockedEarly: false,
      },
      fvg10am: {
        status: "NONE",
        direction: null,
        fvgHigh: null,
        fvgLow: null,
        formedAtEt: null,
        maeBps: null,
        stopFit10bps: null,
      },
      q3Astra: {
        activeQuarter: "OUTSIDE",
        cycleLabel: "GLOBEX",
        lunchGated: false,
        nearestDttAnchor: null,
        ifvgConfirmed: null,
      },
      noonGate: "NEUTRAL",
      chopTimer: { active: false, amRangeBps: 0, minsSinceAmExtreme: null, phase: "NONE" },
    };
  }
  const last = rthBars[rthBars.length - 1]!;
  const org = computeOrg(rthBars, priorClose);
  const orb30 = computeOrb30(rthBars);
  const fvg10am = compute10amFvg(rthBars);
  const q3Astra = computeQ3Astra(etBars);
  const chopTimer = computeChopTimer(rthBars);

  const noonGate =
    orb30.ready &&
    orb30.extremeLockedEarly &&
    fvg10am.status === "HELD" &&
    !orb30.orbMidTouchedAfter1000
      ? "NO_NOON_FADE"
      : "NEUTRAL";

  return {
    symbol,
    tradeDate,
    asOfEt: last.etLabel,
    lastPrice: last.close,
    org,
    orb30,
    fvg10am,
    q3Astra,
    noonGate,
    chopTimer,
  };
}

export function buildCrossInstrumentPlan(
  instruments: InstrumentCoachState[],
): CrossInstrumentRoute {
  const scores = new Map<string, number>();
  const avoid: string[] = [];
  const reasons: string[] = [];

  for (const inst of instruments) {
    let score = 0;
    if (inst.fvg10am.status === "HELD") score += 3;
    if (inst.fvg10am.stopFit10bps === true) {
      score += 2;
    } else if (inst.fvg10am.stopFit10bps === false) {
      score -= 3;
      avoid.push(inst.symbol);
      reasons.push(
        `${inst.symbol} 10am 5m FVG MAE (${inst.fvg10am.maeBps} bps) exceeds 10 bps stop budget`,
      );
    }
    if (inst.orb30.orb25ExtReject !== "NONE") {
      score += 3;
      reasons.push(`${inst.symbol} fired ${inst.orb30.orb25ExtReject} at 25% ORB ext`);
    }
    if (inst.q3Astra.ifvgConfirmed && !inst.q3Astra.lunchGated) {
      score += 2;
      reasons.push(`${inst.symbol} Q3 ${inst.q3Astra.ifvgConfirmed} IFVG confirmed`);
    }
    if (inst.noonGate === "NO_NOON_FADE") {
      reasons.push(`${inst.symbol} NO_NOON_FADE active (09:30-09:45 extreme + ORB Mid untouched)`);
    }
    if (inst.chopTimer.phase === "HIGH_CHOP_0_25M") {
      score -= 2;
      reasons.push(
        `${inst.symbol} post-${inst.chopTimer.amRangeBps} bps AM impulse in 0-25m HIGH_CHOP (${inst.chopTimer.minsSinceAmExtreme}m)`,
      );
    }
    scores.set(inst.symbol, score);
  }

  const ranked = [...instruments].sort(
    (a, b) => (scores.get(b.symbol) ?? 0) - (scores.get(a.symbol) ?? 0),
  );
  const best = ranked[0]?.symbol ?? null;
  const headline =
    best && avoid.length > 0
      ? `Favor ${best} (fits 10 bps stop) — avoid ${avoid.join(", ")}`
      : best
        ? `Cleanest structure: ${best}`
        : "Waiting for RTH structure";

  return {
    bestInstrument: best,
    avoidInstruments: avoid,
    headline,
    reasons,
  };
}
