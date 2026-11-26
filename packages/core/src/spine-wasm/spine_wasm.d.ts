/* tslint:disable */
/* eslint-disable */

/**
 * The generic analytic handle (`spine::analytic`, STRATEGY_WORKFLOW §15.4c).
 * Wraps any registered streaming analytic (e.g. "levels"), optionally over a
 * [`spine::analytic::Feed`] set up once by [`AnalyticHandle::feed_setup`]
 * (roll marks and companion streams, so a roll-reading or two-symbol analytic
 * is fed in `run_batch`'s order). A feed lives only while no bar has been
 * fed. `snapshot` emits the versioned envelope (`SPNA`): the analytic's own
 * bytes plus the live feed's cursor, so a restore RESUMES instead of failing
 * closed — a restore that carried a cursor makes the next `feed_setup` the
 * resume (`Feed::resume`, fingerprint-checked against the same marks and
 * companions), and `on_bars` refuses until it ran. A restore of bare legacy
 * bytes (or an envelope without a cursor) of a roll/companion analytic
 * refuses every bar as before (fail closed, user ruling 2026-10-13). A plain
 * analytic (no rolls, no companions, no feed) restores into a handle like a
 * fresh one.
 */
export class AnalyticHandle {
    free(): void;
    [Symbol.dispose](): void;
    describe(): string;
    /**
     * Append one companion bar LIVE (I4a): `symbol` is one the analytic
     * declared, `bar_json` one bar in the stream wire form
     * `[[ts_utc_close, open, high, low, close, volume]]`, to be read by the
     * NEXT `on_bars` whose bar closes at the same `ts_utc`. Refused with the
     * error envelope while no feed is set up — `feed_setup` must run first
     * (this is the host's once-only setup, empty streams included; the
     * resume a cursor-carrying restore allows counts, being the same
     * `feed_setup`) — then [`spine::analytic::Feed::feed_companion_bar`]'s
     * refusals apply (undeclared symbol; a LATE bar whose `ts_utc` is at or
     * before the last stepped primary bar; a declared symbol with no enqueued
     * stream; a bar not strictly later than the stream's last), each naming
     * what it refused and changing nothing. Empty string on success, as
     * `feed_setup` does.
     */
    feed_companion_bar(symbol: string, bar_json: string): string;
    /**
     * Set up the feed once, before the first bar: `roll_marks_json` is
     * `"null"` (no marks) or `[ts_utc, ...]` (UTC epoch seconds of the roll
     * opens, `[]` for a series with no roll); `companions_json` is `"null"`
     * or `{"symbol": [[ts_utc_close, open, high, low, close, volume], ...]}`
     * per declared companion symbol. Refused once any bar was fed — the feed
     * is a batch setup, not a live push. The one exception is a RESTORE that
     * carried a feed cursor (`snapshot`): after such a restore this call is
     * allowed once and RESUMES the feed at the cursor (`Feed::resume`), which
     * must be given the same marks and companions the snapshot's handle was
     * set up with — changed marks, or a companion bar before its cursor
     * changed, are refused (named); bars appended past a companion's cursor
     * are fine. Empty string on success, the error envelope otherwise, as
     * `restore` does.
     */
    feed_setup(roll_marks_json: string, companions_json: string): string;
    constructor(key: string, params_json: string, minutes: number);
    /**
     * Feed closed bars as JSON array of arrays: `[[ts_utc_close, open, high, low, close, volume], ...]`.
     * ts_utc is the bar CLOSE, UTC epoch seconds. When a feed is set up, every
     * bar goes through `Feed::step` (roll marks and companion bars in
     * `run_batch`'s order); without one, straight to `update` as before —
     * unless the analytic reads rolls or declares companions, which is
     * refused on the first bar with `Feed::new`'s text (a no-feed roll run
     * would be roll-blind, not refuse; see `feed_setup`).
     * `fed` is set only after the whole batch stepped OK, so a refused batch
     * leaves `feed_setup` available; on a restored roll/companion handle
     * (`needs_feed`) every batch is refused until `feed_setup` ran — a
     * cursor-carrying restore must resume there first
     * (`Feed::resume`), legacy bytes never can, so the host must rebuild
     * from the first bar.
     */
    on_bars(bars_json: string): string;
    /**
     * Empty string on success, the error envelope otherwise. The feed is
     * cleared ONLY when the restore succeeds; a failed restore leaves the
     * handle exactly as it was. A restore that CARRIED a feed cursor puts
     * the handle in resume pending: the next `feed_setup` RESUMES at the
     * cursor (`Feed::resume`, fingerprint-checked) and `on_bars` refuses
     * until it ran. A restore with NO cursor of an analytic that had a
     * feed, or reads rolls, or declares companions, behaves as before
     * (fail closed): `on_bars` refuses and `feed_setup` stays refused —
     * rebuild from the first bar. A plain analytic (no rolls, no
     * companions, no feed) restores into a handle like a fresh one.
     */
    restore(bytes: Uint8Array): string;
    /**
     * The versioned envelope (`SPNA`): the analytic's own bytes plus the
     * live feed's cursor when one is set up, so a restore can resume
     * instead of failing closed. A snapshot taken while a RESUME is pending
     * (a restore carried a cursor, `feed_setup` not yet run) re-emits that
     * pending cursor without consuming it, so snapshot -> restore -> snapshot
     * round trips. Empty for a broken (bad-config) handle.
     */
    snapshot(): Uint8Array;
}

/**
 * The path-based Renko engine (`spine::renko`, RENKO_BARS_DESIGN §7a) for the
 * Vela `renko:` provider. No bar rule here: `RenkoEngine`'s JSON facade does
 * the work, so this binding, `spine_ffi` and the Nautilus host return the
 * same bytes for the same trades (`spine/tests/renko_golden.rs`).
 *
 * A bad config does not throw: the handle is created broken and every call
 * returns the `{"error": ...}` envelope, like the rest of this crate.
 */
export class RenkoHandle {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `config_json`: `{"tick_size":0.25,"trend_ticks":4,"reversal_ticks":12,"session":"GlobexDay"}`.
     */
    constructor(config_json: string);
    /**
     * Bars JSON in (`[{"ts_ns":"<epoch ns>","open":..,"high":..,"low":..,"close":..,"volume":..}]`),
     * completed bricks JSON out. The bar -> trades step is the engine's
     * (`RenkoEngine::on_bars_json`, RENKO_BARS_DESIGN C1), not this binding's.
     */
    on_bars(bars_json: string): string;
    /**
     * Bars in as six columns (Vela's history feed), completed bricks out as
     * `RKB1` bytes. `ts_ms` is each bar's epoch MILLISECONDS as a JS number
     * (exact below 2^53); the engine's clock is nanoseconds and this binding
     * converts. Same validation, same intrabar path and same all-or-nothing
     * batch as `on_bars`; a refusal throws the engine's text as a JS string.
     */
    on_bars_binary(ts_ms: Float64Array, open: Float64Array, high: Float64Array, low: Float64Array, close: Float64Array, volume: Float64Array): Uint8Array;
    /**
     * Trades JSON in (`[{"ts_ns":"<epoch ns>","price":..,"size":..}]`; `ts_ns` a
     * string or an integer), completed bars JSON out (`[]` when none).
     */
    on_trades(trades_json: string): string;
    /**
     * Where the next bar completes: `{"prior_close","high","low","trend",...}`
     * (`RenkoEngine::projection`), `null` before the first trade.
     */
    projection(): string;
    /**
     * Empty string on success, the error envelope otherwise.
     */
    restore(bytes: Uint8Array): string;
    snapshot(): Uint8Array;
}

/**
 * The percent / ATR Renko engine (`spine::renko_sized`, RENKO_BARS_DESIGN D3,
 * D6): the same engine as [`RenkoHandle`], sized per session by a rule instead
 * of a fixed T and R. A fixed `renko:T,R` chart keeps using `RenkoHandle`.
 *
 * `config_json`: `{"tick_size":0.25,"rule":{"kind":"percent","pct":0.005,"reversal_ratio":3}}`
 * or `{"tick_size":0.25,"rule":{"kind":"atr","len":14,"mult":1,"reversal_ratio":3},"warmup_daily":[{"high":..,"low":..,"close":..}]}`.
 * A bad config does not throw: every call returns the `{"error": ...}` envelope.
 */
export class SizedRenkoHandle {
    free(): void;
    [Symbol.dispose](): void;
    constructor(config_json: string);
    /**
     * Bars in (as [`RenkoHandle::on_bars`]), completed bricks out.
     */
    on_bars(bars_json: string): string;
    /**
     * As [`RenkoHandle::on_bars_binary`], under the session's frozen size.
     */
    on_bars_binary(ts_ms: Float64Array, open: Float64Array, high: Float64Array, low: Float64Array, close: Float64Array, volume: Float64Array): Uint8Array;
    /**
     * As [`RenkoHandle::projection`], under the session's frozen size.
     */
    projection(): string;
    /**
     * Empty string on success, the error envelope otherwise.
     */
    restore(bytes: Uint8Array): string;
    /**
     * The size chosen for every session so far, as JSON
     * (`[{"session":..,"ts_ns":"<epoch ns>","trend_ticks":..,"reversal_ticks":..}]`).
     */
    sizes(): string;
    snapshot(): Uint8Array;
}

/**
 * Returns the JSON schema for an analytic's params by its key, or an error envelope if unknown.
 */
export function analytic_params_schema(key: string): string;

/**
 * Batch causal Candle Science v17.5 16-dim computation over parallel typed arrays of sorted bars
 * (`1d` settlements or MTF `4h/1h/15m`). Returns JSON array of `CsCandleRow` or `{"error": ...}`.
 */
export function candle_science_batch(bar_ts_s: Float64Array, trade_date_days: Int32Array, open: Float64Array, high: Float64Array, low: Float64Array, close: Float64Array, is_roll: Uint8Array): string;

/**
 * Classify a live forming C3 candle using completed C1, completed C2, and C3 open (zero lookahead).
 */
export function candle_science_live(c1_o: number, c1_h: number, c1_l: number, c1_c: number, c2_o: number, c2_h: number, c2_l: number, c2_c: number, c3_o: number): string;

/**
 * Batch causal Daily Profiler computation over parallel typed arrays of sorted 1m bars
 * (open-timestamped in UTC seconds). Returns JSON `{ "days": [...], "paths": [...] }`
 * or `{"error": ...}`.
 */
export function daily_profiler_batch(ts_open_s: Float64Array, open: Float64Array, high: Float64Array, low: Float64Array, close: Float64Array, volume: Float64Array, is_roll: Uint8Array): string;

/**
 * Evaluate one 1m bar for IB Play 1. `bar_time` is ET `YYYY-MM-DD HH:MM:SS`;
 * `ib_high`/`ib_low` carry `NaN` when the window hasn't formed (same
 * contract as the C ABI). Returns the canonical decision JSON.
 */
export function play1_evaluate(bar_time: string, minute: number, open: number, high: number, low: number, close: number, ib_high: number, ib_low: number, long_taken: boolean, short_taken: boolean): string;

/**
 * Derive the chart overlay for a decision. `decision_json` is the exact
 * bytes [`play1_evaluate`] returned (canonical round-trip); `ib_high` /
 * `ib_low` are the formed range, or `NaN` for no zone. Returns overlay JSON.
 */
export function play1_overlay(decision_json: string, ib_high: number, ib_low: number): string;
