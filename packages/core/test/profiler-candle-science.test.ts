/*
  End-to-end integration & parity test for Daily Profiler (spine_wasm -> daily_context
  + daily_paths_5m) and Candle Science v17.5 (cs_candles + after=1 roll mask + P30/P50/P70).
*/
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Store,
  configSchema,
  runCandleScienceSuite,
  runProfilerPriceModel,
  runProfilerSuite,
  runQuery,
  syncSymbols,
  type EdgeStatsConfig,
} from "../src/index";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function etMs(isoDate: string, hh: number, mm: number): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return DateTime.fromObject({ year: y, month: m, day: d, hour: hh, minute: mm }, { zone: "America/New_York" })
    .toMillis();
}

describe("Daily Profiler & Candle Science native integration (spine_wasm)", () => {
  let tmpDir: string;
  let store: Store;
  let config: EdgeStatsConfig;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "edge-stats-prof-cs-"));
    mkdirSync(join(tmpDir, "calendar"), { recursive: true });
    mkdirSync(join(tmpDir, "events"), { recursive: true });
    copyFileSync(join(repoRoot, "data", "holidays", "cme.json"), join(tmpDir, "calendar", "cme.json"));
    copyFileSync(join(repoRoot, "data", "holidays", "nyse.json"), join(tmpDir, "calendar", "nyse.json"));

    // Build 6 Globex trading days (Mon-Fri + Mon) of 1m bars with deterministic Asia/London/NY1/NY2
    // boxes, and a futures contract roll on day 4 (2025-01-09 -> NQH5).
    const csvPath = join(tmpDir, "nq-1m.csv");
    const lines = ["ts,open,high,low,close,volume,contract"];

    const days = [
      { prevCal: "2025-01-05", cal: "2025-01-06", base: 20000, contract: "NQZ4", up: true },
      { prevCal: "2025-01-06", cal: "2025-01-07", base: 20100, contract: "NQZ4", up: true },
      { prevCal: "2025-01-07", cal: "2025-01-08", base: 20200, contract: "NQZ4", up: true },
      { prevCal: "2025-01-08", cal: "2025-01-09", base: 20300, contract: "NQH5", up: true }, // roll day
      { prevCal: "2025-01-09", cal: "2025-01-10", base: 20400, contract: "NQH5", up: false },
      { prevCal: "2025-01-12", cal: "2025-01-13", base: 20350, contract: "NQH5", up: true },
    ];

    for (const d of days) {
      const b = d.base;
      const add = (cal: string, hh: number, mm: number, o: number, h: number, l: number, c: number) => {
        lines.push(`${etMs(cal, hh, mm)},${o},${h},${l},${c},100,${d.contract}`);
      };
      // Asia class 18:00 (box b..b+20, mid=b+10)
      add(d.prevCal, 18, 0, b + 10, b + 20, b, b + 12);
      // Asia eval 20:00 -> breaks high b+30 > b+20 -> LT
      add(d.prevCal, 20, 0, b + 14, b + 30, b + 12, b + 25);
      // Midnight open 00:00
      add(d.cal, 0, 0, b + 24, b + 26, b + 22, b + 25);
      // London class 02:30 -> touches Asia mid (b+10) -> asia_broken=true! Box b+8..b+18
      add(d.cal, 2, 30, b + 12, b + 18, b + 8, b + 15);
      // London eval 04:00 -> breaks high b+28 > b+18 -> LT
      add(d.cal, 4, 0, b + 16, b + 28, b + 15, b + 26);
      // P12 06:30 test
      add(d.cal, 6, 30, b + 25, b + 32, b + 20, b + 28);
      // NY1 class 07:30 -> box b+20..b+30
      add(d.cal, 7, 30, b + 25, b + 30, b + 20, b + 26);
      // NY1 eval 09:30 -> RTH open, breaks high if d.up else low
      if (d.up) {
        add(d.cal, 9, 30, b + 26, b + 50, b + 24, b + 45);
        // NY2 class 11:30 -> box b+40..b+55
        add(d.cal, 11, 30, b + 45, b + 55, b + 40, b + 50);
        // NY2 eval 13:00 -> breaks high b+80 > b+55 -> LT
        add(d.cal, 13, 0, b + 52, b + 80, b + 50, b + 75);
        add(d.cal, 15, 59, b + 74, b + 78, b + 70, b + 76);
      } else {
        add(d.cal, 9, 30, b + 24, b + 26, b - 10, b - 5);
        add(d.cal, 11, 30, b - 5, b, b - 15, b - 10);
        add(d.cal, 13, 0, b - 10, b - 5, b - 40, b - 35);
        add(d.cal, 15, 59, b - 34, b - 30, b - 38, b - 32);
      }
      add(d.cal, 16, 30, d.up ? b + 75 : b - 32, d.up ? b + 76 : b - 30, d.up ? b + 72 : b - 35, d.up ? b + 74 : b - 33);
    }

    writeFileSync(csvPath, lines.join("\n"));

    config = configSchema.parse({
      dataDir: tmpDir,
      minN: { warn: 3, refuse: 1 },
      symbols: [
        {
          symbol: "TEST_NQ",
          adapter: "csv",
          assetClass: "future",
          defaultSession: "rth",
          tf: "1m",
          orWindows: [5, 15, 30],
          ibWindow: 60,
          adapterOptions: {
            path: csvPath,
            tsUnit: "ms",
            mapping: {
              ts: "ts",
              open: "open",
              high: "high",
              low: "low",
              close: "close",
              volume: "volume",
              contract: "contract",
            },
          },
        },
      ],
    });

    store = await Store.open(tmpDir);
    await syncSymbols(store, config, { untilMs: Date.UTC(2025, 2, 1) });
  }, 60_000);

  afterAll(async () => {
    await store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("populates daily_context, daily_paths_5m, and cs_candles via spine_wasm", async () => {
    const dc = await store.one(`SELECT count(*)::INT AS n FROM daily_context WHERE symbol = 'TEST_NQ'`);
    const dp = await store.one(`SELECT count(*)::INT AS n FROM daily_paths_5m WHERE symbol = 'TEST_NQ'`);
    const cs = await store.one(`SELECT count(*)::INT AS n FROM cs_candles WHERE symbol = 'TEST_NQ' AND tf = '1d'`);
    expect(Number(dc?.n)).toBe(6);
    expect(Number(dp?.n)).toBeGreaterThan(20);
    // 6 daily bars -> 4 C1->C2->C3 triplets
    expect(Number(cs?.n)).toBe(4);
  });

  it("enforces after=1 roll masking on Candle Science triplets", async () => {
    const rows = await store.all(
      `SELECT CAST(trade_date AS VARCHAR) AS td, roll_safe FROM cs_candles WHERE symbol = 'TEST_NQ' AND tf = '1d' ORDER BY trade_date`,
    );
    // Day 3 (2025-01-08) is roll-free; Day 4 (2025-01-09, roll day), Day 5 (2025-01-10, C2=roll), Day 6 (2025-01-13, C1=roll) are NOT roll_safe!
    expect(rows.map((r) => [r.td, r.roll_safe])).toEqual([
      ["2025-01-08", true],
      ["2025-01-09", false],
      ["2025-01-10", false],
      ["2025-01-13", false],
    ]);
  });

  it("conditions NY2 & RTH queries on prior Asia + London + NY1 states in DSL", async () => {
    const ny2Res = await runQuery(store, config, {
      symbol: "TEST_NQ",
      sessionKey: "daily",
      dsl: "profilerOutcome(ny2, LT) WHERE sessionStatus(asia, LT) AND sessionBroken(asia, yes) AND sessionStatus(london, LT)",
    });
    expect(ny2Res.n).toBe(6);
    expect(ny2Res.successes).toBe(5);
    expect(ny2Res.distribution?.p30).toBeDefined();
    expect(ny2Res.distribution?.p70).toBeDefined();

    // Cross-session join: RTH closeGreen conditioned on daily_context asia_status
    const rthRes = await runQuery(store, config, {
      symbol: "TEST_NQ",
      sessionKey: "rth",
      dsl: "closeGreen WHERE sessionStatus(asia, LT) AND sessionStatus(ny1, LT)",
    });
    expect(rthRes.n).toBe(5);
    expect(rthRes.successes).toBe(5);
  });

  it("computes full Profiler suite, 20 level touches, and Composite Price Model", async () => {
    const suite = await runProfilerSuite(store, config, {
      symbol: "TEST_NQ",
      targetSession: "ny2",
      filters: { asia: { status: "LT", broken: "yes" }, london: { status: "LT" } },
      bucketMinutes: 30,
    });
    expect(suite.n).toBe(6);
    const lt = suite.outcomes.find((o) => o.status === "LT");
    expect(lt?.n).toBe(5);
    expect(lt?.ci95).not.toBeNull();
    expect(suite.levelTouches).toHaveLength(20);
    expect(suite.dailyHighDist?.p30).toBeDefined();
    expect(suite.dailyHighDist?.p70).toBeDefined();

    const pm = await runProfilerPriceModel(store, config, {
      symbol: "TEST_NQ",
      targetSession: "daily",
      bucketMinutes: 15,
    });
    expect(pm.n).toBe(6);
    expect(pm.points.length).toBeGreaterThan(0);
  });

  it("computes Candle Science v17.5 suite with 16-dim bitmask and P30/P50/P70 envelopes", async () => {
    const csRes = await runCandleScienceSuite(store, config, {
      symbol: "TEST_NQ",
      tf: "1d",
      dims: { c1_bull: true, c2_bull: true },
    });
    expect(csRes.n).toBe(1);
    expect(csRes.outcomes.find((o) => o.key === "c3_bull")?.k).toBe(1);
    expect(csRes.outcomes.find((o) => o.key === "c3h_gt_c2h")?.k).toBe(1);
    expect(csRes.excursions.find((e) => e.key === "brk_hi")?.distribution?.median).toBeGreaterThan(0);
    expect(csRes.excursions.find((e) => e.key === "brk_hi")?.distribution?.p30).toBeGreaterThan(0);
    expect(csRes.excursions.find((e) => e.key === "brk_hi")?.distribution?.p70).toBeGreaterThan(0);
    expect(csRes.latest).not.toBeNull();
  });
});
