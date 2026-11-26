import { describe, expect, it } from "vitest";
import { type Bar1m, computePostOr30FvgMetrics, simCtqBps } from "../src/features/fvgRetest";

const M = 60_000;

describe("fvgRetest", () => {
  it("detects a bullish 1m FVG beyond OR30, retests within 10 bars, and locks BE on Queen hit", () => {
    const t0 = 1_700_000_000_000;
    const endTs = t0 + 120 * M;
    const orHigh = 10000;
    const orLow = 9980;
    // c2: H=10001, c1: displacement, c0: L=10004 (3 bps gap > 1.0 bps) C=10006 (> orHigh)
    // retest at bar 3 touching 10004 (zoneHigh), then hits Queen (+10 bps = 10014.004) at bar 4,
    // then pulls back to BE (10004) at bar 5 -> PnL = +5 bps (0.5 * 10)
    const bars: Bar1m[] = [
      { ts: t0 + 1 * M, open: 9999, high: 10001, low: 9998, close: 10000.5 },
      { ts: t0 + 2 * M, open: 10000.5, high: 10005, low: 10000.5, close: 10004.5 },
      { ts: t0 + 3 * M, open: 10004.5, high: 10007, low: 10004, close: 10006 },
      { ts: t0 + 4 * M, open: 10006, high: 10006, low: 10003.5, close: 10005 }, // retest
      { ts: t0 + 5 * M, open: 10005, high: 10016, low: 10005, close: 10015 }, // hits +10 bps Queen
      { ts: t0 + 6 * M, open: 10015, high: 10015, low: 10003, close: 10004 }, // BE stop
    ];

    const m = computePostOr30FvgMetrics(bars, orHigh, orLow, endTs);
    expect(m.fvg1m_dir).toBe("up");
    expect(m.fvg1m_retested).toBe(true);
    expect(m.fvg1m_retest_min).toBe(1);
    expect(m.fvg1m_held).toBe(true);
    expect(m.fvg1m_ret_ctq12_bps).toBe(5);
    expect(m.fvg1m_ret_ctq15_bps).toBe(5);
    expect(m.fvg1m_ret_mfe_bps).toBeGreaterThan(11);
  });

  it("applies worst-case SL first inside an ambiguous bar in simCtqBps", () => {
    const t0 = 1_700_000_000_000;
    const bars: Bar1m[] = [
      { ts: t0 + M, open: 10000, high: 10050, low: 9980, close: 10020 }, // hits both -15 SL and +30 R
    ];
    const r = simCtqBps(bars, 0, t0 + 10 * M, 10000, true, 15, 10, 30);
    expect(r.pnl).toBe(-15);
  });
});
