/*
  External bars: a symbol whose bars live in another store (the market-data
  store's `<root>/<name>/<YYYY>.parquet`, open-stamped `ts_open`) is read in
  place. The fixture parquet under fixtures/external-bars is the golden-session
  CSVs in that store's exact schema (timestamp ms UTC, dictionary-encoded
  columns, `contract`), so every expectation traces to the golden ledger.
*/
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Store,
  configSchema,
  externalBarSources,
  getSessionBars,
  runQuery,
  syncSymbols,
  type EdgeStatsConfig,
} from "../src/index";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const golden = join(repoRoot, "fixtures", "golden-sessions");
const extRoot = join(repoRoot, "fixtures", "external-bars", "bars", "1h");
const UNTIL = Date.UTC(2024, 1, 1);

const csvOptions = (file: string) => ({
  path: join(golden, file),
  tsUnit: "ms",
  mapping: {
    ts: "ts",
    open: "open",
    high: "high",
    low: "low",
    close: "close",
    volume: "volume",
  },
});
const common = { tf: "1h", orWindows: [60], ibWindow: 60 };

let dataDir: string;
let store: Store;
let config: EdgeStatsConfig;

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "edge-stats-external-"));
  mkdirSync(join(dir, "calendar"), { recursive: true });
  mkdirSync(join(dir, "events"), { recursive: true });
  for (const f of ["nyse.json", "cme.json"]) {
    copyFileSync(join(repoRoot, "data", "holidays", f), join(dir, "calendar", f));
  }
  copyFileSync(join(repoRoot, "data", "events", "opex.json"), join(dir, "events", "opex.json"));
  return dir;
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

beforeAll(async () => {
  dataDir = makeDataDir();
  // Mixed config: FIX_STK is native (csv adapter); FIX_FUT and EXT_STK are
  // external. EXT_STK reads the same bars as FIX_STK, which is the parity oracle.
  config = configSchema.parse({
    dataDir,
    minN: { warn: 5, refuse: 2 },
    symbols: [
      {
        symbol: "FIX_STK",
        adapter: "csv",
        assetClass: "equity",
        ...common,
        adapterOptions: csvOptions("fix-stk.csv"),
      },
      {
        symbol: "FIX_FUT",
        external: { root: extRoot, name: "FUT" },
        assetClass: "future",
        defaultSession: "rth",
        ...common,
      },
      {
        symbol: "EXT_STK",
        external: { root: extRoot, name: "STK" },
        assetClass: "equity",
        ...common,
      },
    ],
  });
  store = await Store.open(dataDir, { external: externalBarSources(config, dataDir) });
  await syncSymbols(store, config, { untilMs: UNTIL });
}, 120_000);

afterAll(async () => {
  await store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("fixture parquet", () => {
  it("is in the market store's exact schema", async () => {
    const mem = await (await DuckDBInstance.create(":memory:")).connect();
    const rows = async (sql: string) => (await mem.runAndReadAll(sql)).getRowObjects();
    for (const name of ["STK", "FUT"]) {
      const file = join(extRoot, name, "2024.parquet").replaceAll("\\", "/");
      const schema = (
        await rows(`SELECT name, type FROM parquet_schema('${file}') WHERE name <> 'schema'`)
      ).map((r) => [r.name, r.type]);
      expect(schema).toEqual([
        ["ts_open", "INT64"],
        ["open", "DOUBLE"],
        ["high", "DOUBLE"],
        ["low", "DOUBLE"],
        ["close", "DOUBLE"],
        ["volume", "INT64"],
        ["contract", "BYTE_ARRAY"],
      ]);
      const ts = await rows(
        `SELECT logical_type FROM parquet_schema('${file}') WHERE name = 'ts_open'`,
      );
      // timestamp, milliseconds, adjusted to UTC
      expect(String(ts[0]?.logical_type)).toContain("isAdjustedToUTC=1");
      expect(String(ts[0]?.logical_type)).toContain("MILLIS=MilliSeconds()");
      const enc = await rows(`SELECT DISTINCT encodings FROM parquet_metadata('${file}')`);
      expect(enc.map((r) => String(r.encodings))).toEqual(["PLAIN, RLE, RLE_DICTIONARY"]);
    }
    mem.closeSync();
  });
});

describe("external symbol, read in place", () => {
  it("is read through the bars view with the native projection", async () => {
    const rows = await store.all(`
      SELECT symbol, tf, ts, open, volume, contract FROM bars
      WHERE symbol = 'FIX_FUT' ORDER BY ts LIMIT 2`);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      symbol: "FIX_FUT",
      tf: "1h",
      open: 5000,
      contract: "FIX_FUTH24",
    });
    // epoch ms, exactly the csv's first timestamp: open-stamped on both sides, no shift
    expect(Number(rows[0]?.ts)).toBe(1704724200000);
    const lines = readFileSync(join(golden, "fix-fut.csv"), "utf8").trim().split("\n").length - 1;
    const total = await store.one(`SELECT count(*) AS n FROM bars WHERE symbol = 'FIX_FUT'`);
    expect(Number(total?.n)).toBe(lines);
  });

  it("is read through the per-session source, windowed on ts_open", async () => {
    const first = await store.one(`
      SELECT session_id FROM session_features
      WHERE symbol = 'FIX_FUT' AND session_key = 'rth' ORDER BY trade_date LIMIT 1`);
    const s = await getSessionBars(store, config, String(first?.session_id));
    expect(s.symbol).toBe("FIX_FUT");
    expect(s.bars).toHaveLength(7);
    expect(s.bars[0]).toMatchObject({ open: 5000, high: 5010, low: 4990, close: 5005 });
    const src = store.barSource("FIX_FUT", "1h", [2024], { fromMs: s.startTs, toMs: s.endTs });
    expect(src).toContain("ts_open >= make_timestamptz(");
    const direct = await store.all(`SELECT count(*) AS n FROM ${src}`);
    expect(Number(direct[0]?.n)).toBe(7);
  });

  it("returns no source for a year with no file", () => {
    expect(store.barSource("FIX_FUT", "1h", [2019])).toBeNull();
  });

  it("window literals do not depend on the session time zone", async () => {
    const win = { fromMs: 1704724200000, toMs: 1704724200000 + 3_600_000 };
    for (const tz of ["UTC", "America/New_York", "Asia/Kolkata"]) {
      await store.run(`SET TimeZone = '${tz}'`);
      const src = store.barSource("FIX_FUT", "1h", [2024], win);
      const r = await store.one(`SELECT count(*) AS n, min(ts) AS lo FROM ${src}`);
      expect([tz, Number(r?.n), Number(r?.lo)]).toEqual([tz, 1, 1704724200000]);
    }
    await store.run(`SET TimeZone = 'UTC'`);
  });

  it("derives the golden values", async () => {
    const expected = JSON.parse(
      readFileSync(join(golden, "expected-features.json"), "utf8"),
    ) as Record<string, Record<string, Record<string, unknown>>>;
    const rows = await store.all(`
      SELECT *, CAST(trade_date AS VARCHAR) AS td FROM session_features
      WHERE symbol = 'FIX_FUT' AND session_key = 'rth'`);
    const byDate = new Map(rows.map((r) => [String(r.td), r]));
    let checked = 0;
    for (const [date, fields] of Object.entries(expected.FIX_FUT ?? {})) {
      if (date === "_note") continue;
      for (const [field, want] of Object.entries(fields)) {
        const got = byDate.get(date)?.[field];
        const label = `${date} ${field}`;
        if (want === null) expect(got, label).toBeNull();
        else if (typeof want === "number") expect(got as number, label).toBeCloseTo(want, 6);
        else expect(got, label).toBe(want);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe("sync copies nothing for an external symbol", () => {
  it("writes no bar files for it and reports zero inserted", async () => {
    const summary = await syncSymbols(store, config, { untilMs: UNTIL, full: true });
    for (const name of ["FIX_FUT", "EXT_STK"]) {
      expect(filesUnder(join(dataDir, "bars", `symbol=${name}`))).toEqual([]);
      expect(existsSync(join(dataDir, "bars", `symbol=${name}`))).toBe(false);
      const s = summary.symbols.find((x) => x.symbol === name);
      expect(s).toMatchObject({ adapter: "external", barsInserted: 0, barsSkipped: 0 });
      expect(s?.watermark).toBeGreaterThan(0);
    }
    // the native symbol still wrote its own copy
    expect(filesUnder(join(dataDir, "bars", "symbol=FIX_STK")).length).toBeGreaterThan(0);
    // and the external symbols still derived features from the in-place bars
    const n = await store.one(
      `SELECT count(*) AS n FROM session_features WHERE symbol = 'FIX_FUT'`,
    );
    expect(Number(n?.n)).toBeGreaterThan(0);
  });

  it("is refused a drop or an ingest", async () => {
    await expect(store.dropBars("FIX_FUT", "1h")).rejects.toThrow(
      /refusing to drop bars of 'FIX_FUT'.*external/,
    );
    await expect(
      store.ingestBars(
        [
          {
            symbol: "FIX_FUT",
            tf: "1h",
            ts: 1,
            open: 1,
            high: 1,
            low: 1,
            close: 1,
            volume: 1,
            contract: null,
          },
        ],
        null,
      ),
    ).rejects.toThrow(/refusing to ingest bars into 'FIX_FUT'/);
    // the source files are untouched and still read
    expect(existsSync(join(extRoot, "FUT", "2024.parquet"))).toBe(true);
    const n = await store.one(`SELECT count(*) AS n FROM bars WHERE symbol = 'FIX_FUT'`);
    expect(Number(n?.n)).toBeGreaterThan(0);
  });

  it("still allows dropping a native symbol", async () => {
    expect(store.isExternal("FIX_STK")).toBe(false);
    expect(store.isExternal("FIX_FUT")).toBe(true);
    await store.dropBars("NO_SUCH_NATIVE", "1h");
  });
});

describe("mixed native and external config", () => {
  it("the external symbol matches the native one on the same bars, row for row", async () => {
    const cols = (
      await store.all(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'session_features' ORDER BY ordinal_position`,
      )
    )
      .map((r) => String(r.column_name))
      .filter((c) => c !== "symbol" && c !== "session_id");
    const list = cols.map((c) => `"${c}"`).join(", ");
    const q = (s: string) => `SELECT ${list} FROM session_features WHERE symbol = '${s}'`;
    const aMinusB = await store.one(
      `SELECT count(*) AS n FROM ((${q("FIX_STK")}) EXCEPT (${q("EXT_STK")}))`,
    );
    const bMinusA = await store.one(
      `SELECT count(*) AS n FROM ((${q("EXT_STK")}) EXCEPT (${q("FIX_STK")}))`,
    );
    const counts = await store.one(`
      SELECT (SELECT count(*) FROM session_features WHERE symbol = 'FIX_STK') AS a,
             (SELECT count(*) FROM session_features WHERE symbol = 'EXT_STK') AS b`);
    expect(Number(aMinusB?.n)).toBe(0);
    expect(Number(bMinusA?.n)).toBe(0);
    expect(Number(counts?.a)).toBe(9);
    expect(Number(counts?.b)).toBe(9);
  });

  it("answers queries identically for both", async () => {
    for (const dsl of [
      "gapFill",
      "orbBreak(60m, up)",
      "orbTargetHit(60m, 1, up)",
      "ibExtension(1)",
    ]) {
      const a = await runQuery(store, config, { dsl, symbol: "FIX_STK" });
      const b = await runQuery(store, config, { dsl, symbol: "EXT_STK" });
      expect([dsl, b.n, b.successes, b.estimate]).toEqual([dsl, a.n, a.successes, a.estimate]);
    }
  });

  it("per-session bars are identical for both", async () => {
    const a = await getSessionBars(store, config, "FIX_STK|rth|2024-01-10");
    const b = await getSessionBars(store, config, "EXT_STK|rth|2024-01-10");
    expect(a.bars.length).toBe(7);
    expect(b.bars).toEqual(a.bars);
    expect(b.context.bars).toEqual(a.context.bars);
  });
});

describe("config", () => {
  const base = { dataDir: "d" };
  it("accepts an external block without an adapter and reports it as external", () => {
    const c = configSchema.parse({
      ...base,
      symbols: [{ symbol: "NQ1", assetClass: "future", external: { root: "r", name: "NQ" } }],
    });
    expect(c.symbols[0]).toMatchObject({
      adapter: "external",
      external: { root: "r", name: "NQ" },
    });
  });

  it("rejects an external block with a different adapter", () => {
    expect(() =>
      configSchema.parse({
        ...base,
        symbols: [
          {
            symbol: "NQ1",
            adapter: "csv",
            assetClass: "future",
            external: { root: "r", name: "NQ" },
          },
        ],
      }),
    ).toThrow(/adapter must be omitted/);
  });

  it("still requires an adapter for a native symbol", () => {
    expect(() =>
      configSchema.parse({ ...base, symbols: [{ symbol: "NQ1", assetClass: "future" }] }),
    ).toThrow(/needs an adapter/);
  });

  it("resolves a relative root against the config directory", () => {
    const c = configSchema.parse({
      ...base,
      symbols: [
        { symbol: "NQ1", assetClass: "future", external: { root: "store/bars/1m", name: "NQ" } },
      ],
    });
    expect(externalBarSources(c, resolve("cfg"))[0]?.root).toBe(resolve("cfg", "store/bars/1m"));
  });
});

describe("a store opened without the external sources", () => {
  it("fails fast on sync rather than reading nothing", async () => {
    const dir = makeDataDir();
    const bare = await Store.open(dir);
    try {
      await expect(
        syncSymbols(bare, config, { untilMs: UNTIL, symbols: ["FIX_FUT"] }),
      ).rejects.toThrow(/opened without them/);
    } finally {
      await bare.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails fast on a missing external directory", async () => {
    const dir = makeDataDir();
    try {
      await expect(
        Store.open(dir, {
          external: [{ symbol: "X", tf: "1h", root: join(dir, "nowhere"), name: "X" }],
        }),
      ).rejects.toThrow(/no parquet files under/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
