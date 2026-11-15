import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  buildCrossInstrumentPlan,
  evaluateInstrumentSession,
  type CoachingBar,
} from "../src/coaching/scanner";

function etBar(hm: string, open: number, high: number, low: number, close: number): CoachingBar {
  const [h, m] = hm.split(":").map(Number);
  const dt = DateTime.fromObject(
    { year: 2026, month: 11, day: 9, hour: h, minute: m },
    { zone: "America/New_York" },
  );
  return { tsMs: dt.toMillis(), open, high, low, close };
}

function makeRangeBars(
  startMin: number,
  endMin: number,
  fn: (hhmm: number, idx: number) => [number, number, number, number],
): CoachingBar[] {
  const out: CoachingBar[] = [];
  for (let m = startMin, i = 0; m < endMin; m++, i++) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    const [o, h, l, c] = fn(m, i);
    out.push(etBar(`${hh}:${mm}`, o, h, l, c));
  }
  return out;
}

describe("coaching/scanner", () => {
  it("flags NO_NOON_FADE when early extreme holds, 10am 5m FVG holds, and ORB mid stays untouched", () => {
    const bars: CoachingBar[] = [
      // 09:30-09:44: LOD locked at 100.0, ORB high 100.4 (mid 100.2)
      ...makeRangeBars(570, 585, (m) =>
        m === 571 ? [100.1, 100.3, 100.0, 100.25] : [100.25, 100.4, 100.2, 100.35],
      ),
      // 09:45-09:59: holds above ORB mid
      ...makeRangeBars(585, 600, () => [100.35, 100.4, 100.28, 100.38]),
      // 10:00-10:04: 5m bar A high=100.42
      ...makeRangeBars(600, 605, () => [100.38, 100.42, 100.36, 100.4]),
      // 10:05-10:09: 5m bar B impulse
      ...makeRangeBars(605, 610, () => [100.4, 100.6, 100.4, 100.58]),
      // 10:10-10:14: 5m bar C low=100.50 (> 100.42 -> bullish 5m FVG [100.42, 100.50])
      ...makeRangeBars(610, 615, () => [100.58, 100.65, 100.5, 100.62]),
      // 10:15-12:05: pullback touches 100.46 (4 bps MAE) and holds above 100.42 & ORB mid 100.2
      ...makeRangeBars(615, 725, (m) =>
        m === 620 ? [100.55, 100.56, 100.46, 100.52] : [100.55, 100.75, 100.52, 100.7],
      ),
    ];

    const state = evaluateInstrumentSession("ES1", "2026-11-09", bars, 99.5);
    expect(state.org.gapDir).toBe("UP");
    expect(state.org.orgAway30m).toBe(true);
    expect(state.fvg10am.status).toBe("HELD");
    expect(state.fvg10am.direction).toBe("BULL");
    expect(state.fvg10am.stopFit10bps).toBe(true);
    expect(state.noonGate).toBe("NO_NOON_FADE");
  });

  it("routes away from NQ when 10am 5m FVG MAE exceeds 10 bps while ES fits", () => {
    const makeDay = (pullbackLow: number) => [
      ...makeRangeBars(570, 600, () => [100.0, 100.2, 99.9, 100.1]),
      ...makeRangeBars(600, 605, () => [100.1, 100.15, 100.08, 100.12]),
      ...makeRangeBars(605, 610, () => [100.12, 100.45, 100.12, 100.42]),
      ...makeRangeBars(610, 615, () => [100.42, 100.5, 100.4, 100.48]), // FVG [100.15, 100.40]
      ...makeRangeBars(615, 630, (m) =>
        m === 620 ? [100.38, 100.4, pullbackLow, 100.35] : [100.35, 100.55, 100.34, 100.5],
      ),
    ];

    const es = evaluateInstrumentSession("ES1", "2026-11-13", makeDay(100.35), 100.0); // 5 bps MAE
    const nq = evaluateInstrumentSession("NQ1", "2026-11-13", makeDay(100.2), 100.0); // 20 bps MAE
    expect(es.fvg10am.stopFit10bps).toBe(true);
    expect(nq.fvg10am.stopFit10bps).toBe(false);

    const route = buildCrossInstrumentPlan([es, nq]);
    expect(route.bestInstrument).toBe("ES1");
    expect(route.avoidInstruments).toContain("NQ1");
  });

  it("tracks post-100bps AM impulse chop phases and 25% ORB extension rejection", () => {
    const bars: CoachingBar[] = [
      // ORB 100.0 - 101.0 (100 bps, 25% ext down = 99.75, 30% ext down = 99.70)
      ...makeRangeBars(570, 600, (m) =>
        m === 570 ? [100.8, 101.0, 100.5, 100.6] : [100.5, 100.6, 100.0, 100.2],
      ),
      // 10:00-10:10 flush to 99.72 (28% ORB ext) then close back > 100.0
      ...makeRangeBars(600, 612, (m) =>
        m === 603
          ? [100.0, 100.02, 99.72, 99.85]
          : m === 605
            ? [99.85, 100.15, 99.84, 100.1]
            : [100.1, 100.2, 100.05, 100.15],
      ),
    ];

    const state = evaluateInstrumentSession("YM1", "2026-11-12", bars, 100.8);
    expect(state.orb30.orb25ExtReject).toBe("BULL_REJ");
    expect(state.chopTimer.active).toBe(true);
    expect(state.chopTimer.phase).toBe("HIGH_CHOP_0_25M");
  });
});
