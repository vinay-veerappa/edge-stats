import { describe, expect, it } from "vitest";
import { mergeDayNote, tagsForInstrument } from "../src/coaching/journalSync";
import type { InstrumentCoachState } from "../src/coaching/scanner";

const baseInst: InstrumentCoachState = {
  symbol: "YM1",
  tradeDate: "2026-11-13",
  asOfEt: "15:59",
  lastPrice: 52500,
  org: {
    priorClose: 52300,
    rthOpen: 52512,
    gapBps: 40.5,
    gapDir: "UP",
    orgInto30m: false,
    orgAway30m: true,
    gapFilled: false,
  },
  orb30: {
    ready: true,
    high: 52600,
    low: 52360,
    mid: 52480,
    rangeBps: 46,
    ext25Up: 52660,
    ext25Down: 52300,
    orb25ExtReject: "BULL_REJ",
    extremeLockedEarly: false,
    orbMidTouchedAfter1000: false,
  },
  fvg10am: {
    status: "HELD",
    direction: "BULL",
    formedAtEt: "10:15",
    zoneLow: 52400,
    zoneHigh: 52450,
    touched: true,
    maeBps: 3.4,
    stopFit10bps: true,
  },
  q3Astra: {
    activeQuarter: "OUTSIDE",
    cycleLabel: null,
    lunchGated: false,
    tmso: null,
    nearestDttAnchor: null,
    ifvgConfirmed: null,
  },
  noonGate: "NO_NOON_FADE",
  chopTimer: {
    active: true,
    amRangeBps: 140,
    minsSinceAmExtreme: 100,
    phase: "BREAKOUT_WATCH_95M_PLUS",
  },
};

describe("coaching/journalSync", () => {
  it("builds deterministic coach tags", () => {
    const tags = tagsForInstrument(baseInst, "YM1");
    expect(tags).toEqual([
      "coach:org_away_30m",
      "coach:orb25_ext_rej",
      "coach:10am_fvg_held",
      "coach:no_noon_fade",
      "coach:am_impulse_100bps",
      "coach:best_pick",
    ]);
  });

  it("preserves existing user notes while replacing only the Market Coach block", () => {
    const existing = "My own morning thoughts.\n\n<!-- MARKET_COACH_START -->\nOLD\n<!-- MARKET_COACH_END -->\n\nClosing thoughts.";
    const updated = mergeDayNote(existing, "<!-- MARKET_COACH_START -->\nNEW\n<!-- MARKET_COACH_END -->");
    expect(updated).toContain("My own morning thoughts.");
    expect(updated).toContain("Closing thoughts.");
    expect(updated).toContain("NEW");
    expect(updated).not.toContain("OLD");
  });
});
