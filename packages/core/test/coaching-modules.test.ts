import { describe, expect, it } from "vitest";
import {
  evaluateCoachModules,
  evaluateInstrumentSession,
  setCoachModuleEnabled,
  type CoachModuleContext,
} from "../src/index";

function makeBaseCtx(): CoachModuleContext {
  const instEs = evaluateInstrumentSession("ES1", "2026-11-13", [
    { tsMs: 1794666600000, open: 6000, high: 6010, low: 5995, close: 6005, volume: 1000 },
  ]);
  const instNq = evaluateInstrumentSession("NQ1", "2026-11-13", [
    { tsMs: 1794666600000, open: 21000, high: 21020, low: 20980, close: 21010, volume: 1000 },
  ]);

  return {
    tradeDate: "2026-11-13",
    asOfEt: "10:15",
    instruments: [instEs, instNq],
    levelsBySymbol: {
      ES1: { pdh: 6008, pdl: 5950, sessionHigh: 6012, sessionLow: 5995 },
      NQ1: { pdh: 21050, pdl: 20800, sessionHigh: 21020, sessionLow: 20980 },
    },
    quotes: {
      ES1: { symbol: "ES1", last: 6005, netPct: 0.4, tsMs: 1 },
      NQ1: { symbol: "NQ1", last: 21010, netPct: 0.35, tsMs: 1 },
      VIX: { symbol: "VIX", last: 18, tsMs: 1 },
      VIX9D: { symbol: "VIX9D", last: 19, tsMs: 1 },
    },
    orderflow: {
      ES1: { symbol: "ES1", cvd: 100, cvdDelta5m: -900, tsMs: 1 },
    },
    basket: [
      { symbol: "META", last: 600, dayPct: 1.5, score: 0.75 },
      { symbol: "AMZN", last: 220, dayPct: 0.8, score: 0.4 },
      { symbol: "NVDA", last: 150, dayPct: 1.2, score: 0.6 },
      { symbol: "MSFT", last: 450, dayPct: 0.6, score: 0.3 },
      { symbol: "GOOGL", last: 190, dayPct: 0.5, score: 0.25 },
    ],
    gex: {
      ES1: { symbol: "ES1", gammaFlip: 6020, callWall: 6050, putWall: 5950, netGexTotal: -1000 },
      NQ1: { symbol: "NQ1", gammaFlip: 20900, callWall: 21200, putWall: 20800, netGexTotal: 1000 },
    },
  };
}

describe("coaching/modules", () => {
  it("evaluates all enabled modules independently and aggregates permission", () => {
    const res = evaluateCoachModules(makeBaseCtx());
    const codes = res.signals.map((s) => s.code);
    expect(codes).toContain("PDH_SWEPT_REJECT");
    expect(codes).toContain("SMT_BEAR_PDH");
    expect(codes).toContain("BASKET_LONG_ONLY");
    expect(codes).toContain("VOL_BACKWARDATION");
    expect(codes).toContain("CVD_BEAR_DIV");
    expect(codes).toContain("NEG_GAMMA");
    expect(codes).toContain("POS_GAMMA");
    expect(res.permission).toBe("LONG_ONLY");
  });

  it("can disable and re-enable individual modules without affecting others", () => {
    setCoachModuleEnabled("cvd-flow", false);
    const res = evaluateCoachModules(makeBaseCtx());
    expect(res.signals.some((s) => s.moduleId === "cvd-flow")).toBe(false);
    expect(res.signals.some((s) => s.moduleId === "pdx-sweeps")).toBe(true);
    setCoachModuleEnabled("cvd-flow", true);
  });
});
