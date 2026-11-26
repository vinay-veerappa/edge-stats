// Populate or incrementally refresh daily_context, daily_paths_5m, and cs_candles
// via crates/spine_wasm without re-deriving all ~74 intraday session_features keys.
//
// Usage (from third_party/edge-stats):
//   pnpm exec tsx scripts/derive-daily.mts --symbols NQ1,ES1 [--full]

import {
  Store,
  deriveDailyForSymbol,
  externalBarSources,
  loadConfig,
  resolveEconomicDb,
} from "../packages/core/src/index.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const full = process.argv.includes("--full");
const symFilter = arg("symbols")
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const loaded = loadConfig(process.env.EDGESTATS_DIR);
const store = await Store.open(loaded.dataDir, {
  external: externalBarSources(loaded.config, loaded.rootDir),
  economicDb: resolveEconomicDb(loaded.config, loaded.rootDir),
});

const started = Date.now();
try {
  const targets = symFilter
    ? loaded.config.symbols.filter((s) => symFilter.includes(s.symbol))
    : loaded.config.symbols;

  for (const sym of targets) {
    const t0 = Date.now();
    const res = await deriveDailyForSymbol(store, sym, {
      full,
      log: (m) => console.log(`  ${m}`),
    });
    console.log(
      `${res.symbol.padEnd(6)} days=${res.days} paths=${res.paths} cs=${res.csCandles} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );
  }
  console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} finally {
  await store.close();
}
