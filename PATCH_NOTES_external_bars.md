# Patch notes: external bars (local/external-bars)

Branch `local/external-bars`, based on `local/serve-graceful-shutdown`. Local only: not pushed, no fork.
Feeds the FORKS.md row.

## What it does

A symbol can be configured with `"external": {"root": "<store>/bars/1m", "name": "NQ"}` instead of an
`adapter`. Its bars are the market-data store's `<root>/<name>/<YYYY>.parquet` (`ts_open` TIMESTAMPTZ,
open-stamped; `open high low close`; integer `volume`; `contract`). edge-stats reads them in place:

- the `bars` view is `UNION ALL` of the native Hive branch (external symbols excluded) and one branch per
  external symbol, projecting `epoch_ms(ts_open) AS ts, open, high, low, close, CAST(volume AS DOUBLE),
CAST(contract AS VARCHAR)`. Same columns as before, so derive.ts, export.ts and `fingerprint()` are unchanged.
- the per-session reader goes through `Store.barSource(symbol, tf, years, window?)`.
- `sync` pulls and appends nothing for an external symbol, then derives features as usual.
- dropping or ingesting into an external symbol throws.

Both sides are open-stamped: there is no timestamp shift. No bar is ever copied; nothing is written under
`<dataDir>/bars/symbol=<X>` for an external symbol.

## Files and line ranges (post-patch line numbers)

| File                                       | Lines              | Why                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/store/store.ts`         | 37-57              | `ExternalBarSource`, `StoreOptions` types.                                                                                                                                                                                                                                   |
|                                            | 78-93              | `EXTERNAL_PROJECTION` constant; `externals` map, constructor takes it.                                                                                                                                                                                                       |
|                                            | 96-118             | `Store.open(dataDir, opts)`; closes the db if open fails (a refused open must not keep the file locked).                                                                                                                                                                     |
|                                            | 122-133            | `refuseExternal` (throws), `isExternal`.                                                                                                                                                                                                                                     |
|                                            | 135-209            | `barSource(symbol, tf, years, window?)` replaces `barPartitionGlobs`. External: only existing year files, windowed on RAW `ts_open >= make_timestamptz(micros)` so row groups prune; native: the old Hive globs, same columns.                                               |
|                                            | 211-262            | `refreshBarsView`: UNION ALL branches; fails fast when an external directory has no parquet.                                                                                                                                                                                 |
|                                            | 278-279            | `ingestBars` refuses external symbols (guard, see "outside the list").                                                                                                                                                                                                       |
|                                            | 325-326            | `dropBars` refuses external symbols (the `store.ts:229` drop site).                                                                                                                                                                                                          |
| `packages/core/src/query/session-bars.ts`  | 22, 249-273        | Caller of `barSource`: passes the session window and the context window; null source means no bars. SQL predicates unchanged.                                                                                                                                                |
| `packages/core/src/sync.ts`                | 12-13, 72, 112-143 | `syncOne` returns early for `symbol.external`; `syncExternal` reads the watermark from the view, copies nothing, reports `adapter: "external"`.                                                                                                                              |
| `packages/core/src/config.ts`              | 4, 20-56, 165-179  | Config schema: `external {root, name}`; `adapter` optional only when `external` is set (adapter + external mismatch, or neither, is rejected); `externalBarSources(config, rootDir)` turns config into `Store.open` options (relative roots resolve against the config dir). |
| `packages/core/src/index.ts`               | 18                 | Export the two new types.                                                                                                                                                                                                                                                    |
| `packages/cli/src/context.ts`              | 4-7, 23-25         | Pass `externalBarSources(...)` to `Store.open` (see "outside the list").                                                                                                                                                                                                     |
| `packages/core/test/external-bars.test.ts` | new                | 18 tests: view + per-session read, windowed source, tz independence, golden values, sync copies nothing, drop/ingest refused, mixed native+external parity, config schema, fail-fast cases.                                                                                  |
| `fixtures/external-bars/`                  | new                | Golden-session bars as parquet in the market store's exact schema (ms UTC `ts_open`, dictionary encoding, `contract`), plus `gen_fixture.py` (pyarrow).                                                                                                                      |

Not touched: derive logic, sessions, statistics, CIs, presets, the query layer.

## Items slightly outside the permitted list (flagged)

1. `ingestBars` refusal guard (store.ts 278-279): belt and braces beside the `dropBars` refusal.
2. `externalBarSources()` helper in config.ts: the config-to-`Store.open` plumbing the schema change needs.
3. `packages/cli/src/context.ts`: without it the CLI cannot open an external symbol at all. Other
   `Store.open` callers (demo `init`, tests) are unchanged and open without externals; `sync` on an
   external symbol then throws a clear error instead of reading nothing.
4. Optional `adapter` via a schema transform (an external symbol reports adapter `"external"`).
5. The `window` parameter of `barSource` (needed for pruning, see below).
6. `Store.open` closes the connection when `ensureSchema`/`refreshBarsView` throws.

## Pruning finding (why `barSource` takes a window)

A filter on `epoch_ms(ts_open)` is applied as a scan filter but does NOT prune row groups. A filter on the
raw `ts_open >= make_timestamptz(micros)` is pushed down and prunes. `make_timestamptz` takes absolute
microseconds, so it is independent of the session TimeZone (a plain `epoch_ms()` literal cast to
TIMESTAMPTZ is shifted by it; tested under three zones). Hence the window is applied inside `barSource`
on the raw column; the unchanged `ts >= ... AND ts < ...` predicates stay in the caller's SQL.

## Performance (NQ, 6.58M 1m bars, 2006-2026; interleaved in one process, warm; other agents loading the box)

A1 = native store filled by the real CSV adapter (152 files, 50k-row appends). A2 = native store from one
consolidated COPY (best-case native layout). B = external over the current writer layout. B' = external over
the same bars rewritten with `ts_open` delta-encoded (Parquet V2), as a what-if.

| Measure                             | A1    | A2    | B           | B vs A1 | B vs A2 | B' vs A2       |
| ----------------------------------- | ----- | ----- | ----------- | ------- | ------- | -------------- |
| Full derive, median of 5 (ms)       | 28243 | 28150 | 30390       | +7.6 %  | +8.0 %  | -1.3 % (27793) |
| session-bars warm median (ms)       | 18.3  | 18.0  | 24.6 / 19.7 | +34 %   | +9 %    | -17 %          |
| session-bars first call median (ms) | 15.1  | 21.0  | 21.2 / 19.9 | +40 %   | -5 %    | -4 %           |
| gapFill preset median (ms)          | 45.2  | 36.2  | 39.5 / 39.3 | -13 %   | +8 %    | -27 %          |
| orbBreak preset median (ms)         | 45.8  | 37.8  | 38.9 / 40.5 | -15 %   | +7 %    | -28 %          |

(B cells with two numbers: the first is from the run against A1, the second from the run against A2.)
Recent slice (NQ 2024-2026, 2.7 y), B vs A2 interleaved: session-bars first call 34.0 vs 29.5 ms, warm 21.2 vs 20.4 ms
(+4 %); gapFill 20.8 vs 18.7 ms (+11 %), orbBreak 19.9 vs 19.1 ms (+4 %); derive A2 10.9 / 10.4 s vs B 15.3 / 10.7 s
(first rep includes the real `sync` path and a cold file cache). Cause of the residual: the writer dictionary-encodes `ts_open` (unique values), which makes
`fingerprint()` (a `count(*)`/`max(ts)` scan on every query and preset) and scans slower than a native
partition; the bar query itself is +0.3 to 0.45 ms and prunes correctly.

Gate status on the current layout: presets pass against the real native path (A1) and are 7-8 % slower
than the consolidated best case (A2); session reads are 9 % (A2) to 34 % (A1) slower; derive is about 8 %
slower and inside run-to-run noise (rep spread is 18-30 s). Not within 10 % everywhere on the current layout.

### Recommendation (our writer, not changed here)

Write `ts_open` without dictionary and with DELTA_BINARY_PACKED (parquet-rs `set_column_dictionary_enabled`
false + `set_column_encoding` DELTA_BINARY_PACKED for `ts_open`). With that layout B' is 17 % faster than A2
on session reads and 27-28 % faster on presets. Alternative without a writer change: memoise `fingerprint()`
on the store's file sizes/mtimes (outside the permitted sites, not done).

## Parity (full 2006-2026 NQ, 10667 sessions, 115 columns of session_features)

| Pair     | rows          | A minus B | B minus A |
| -------- | ------------- | --------- | --------- |
| A1 vs B  | 10667 / 10667 | 0         | 0         |
| A2 vs B  | 10667 / 10667 | 0         | 0         |
| A2 vs B' | 10667 / 10667 | 0         | 0         |

Preset outputs (gapFill, orbBreak): A1 vs B byte-identical. A2 differs only in `engine.storeFingerprint`,
because the A2 harness never ran `sync` and so never stored `calendar_version`; every other field is equal.
Session-bars signatures (8 sessions, counts, first/last bars, context) are identical across all variants.
