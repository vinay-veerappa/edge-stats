// Re-derive session_features for a SUBSET of symbols and session keys.
//
// `edgestats sync` pulls bars from adapters and, whenever the feature table
// shape changed, re-derives every symbol. Each symbol carries ~90 session
// keys, so a full pass is ~90 x N derives and will exceed any sane timeout.
// When you have only added feature columns, you usually need one session key
// for two symbols -- which takes under a minute.
//
// The store is single-writer: stop `edgestats serve` first.
//
// Usage:
//   node --import tsx scripts/derive-scoped.mts --symbols NQ1,ES1 --sessions ny_am_0930_1100
//   node --import tsx scripts/derive-scoped.mts --symbols NQ1            # all session keys
//
// Adding columns is additive (ALTER TABLE ADD COLUMN), so symbols you do not
// re-derive keep their history and simply have NULL in the new columns.

import { Store, loadConfig, externalBarSources, resolveEconomicDb } from "../packages/core/src/index.ts";
import { deriveFeatures } from "../packages/core/src/features/derive.ts";
import { makeSessionResolver } from "../packages/core/src/calendar/index.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const symbols = arg("symbols")?.split(",").map((s) => s.trim()).filter(Boolean);
const sessionKeys = arg("sessions")?.split(",").map((s) => s.trim()).filter(Boolean);

if (!symbols || symbols.length === 0) {
  console.error("usage: derive-scoped.mts --symbols NQ1,ES1 [--sessions ny_am_0930_1100]");
  process.exit(2);
}

const loaded = loadConfig(process.env.EDGESTATS_DIR);
const store = await Store.open(loaded.dataDir, {
  external: externalBarSources(loaded.config, loaded.rootDir),
  economicDb: resolveEconomicDb(loaded.config, loaded.rootDir),
});

const started = Date.now();
try {
  const resolver = makeSessionResolver(loaded.config, store.dataDir);
  const summary = await deriveFeatures(store, loaded.config, resolver, {
    symbols,
    sessionKeys,
    log: (m) => console.log(`  ${m}`),
  });

  const total = summary.reduce((n, s) => n + s.sessions, 0);
  for (const s of summary) {
    console.log(`${s.symbol.padEnd(6)} ${s.sessionKey.padEnd(26)} ${s.sessions} sessions`);
  }
  console.log(`\nderived ${total} sessions in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} finally {
  await store.close();
}
