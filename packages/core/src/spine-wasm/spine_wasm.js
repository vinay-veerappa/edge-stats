/* @ts-self-types="./spine_wasm.d.ts" */

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
class AnalyticHandle {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AnalyticHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_analytichandle_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    describe() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.analytichandle_describe(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export3(deferred1_0, deferred1_1, 1);
        }
    }
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
     * @param {string} symbol
     * @param {string} bar_json
     * @returns {string}
     */
    feed_companion_bar(symbol, bar_json) {
        let deferred3_0;
        let deferred3_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(symbol, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(bar_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            wasm.analytichandle_feed_companion_bar(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred3_0 = r0;
            deferred3_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export3(deferred3_0, deferred3_1, 1);
        }
    }
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
     * @param {string} roll_marks_json
     * @param {string} companions_json
     * @returns {string}
     */
    feed_setup(roll_marks_json, companions_json) {
        let deferred3_0;
        let deferred3_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(roll_marks_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(companions_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            wasm.analytichandle_feed_setup(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred3_0 = r0;
            deferred3_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export3(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * @param {string} key
     * @param {string} params_json
     * @param {number} minutes
     */
    constructor(key, params_json, minutes) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(params_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.analytichandle_new(ptr0, len0, ptr1, len1, minutes);
        this.__wbg_ptr = ret;
        AnalyticHandleFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
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
     * @param {string} bars_json
     * @returns {string}
     */
    on_bars(bars_json) {
        let deferred2_0;
        let deferred2_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(bars_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.analytichandle_on_bars(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred2_0 = r0;
            deferred2_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export3(deferred2_0, deferred2_1, 1);
        }
    }
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
     * @param {Uint8Array} bytes
     * @returns {string}
     */
    restore(bytes) {
        let deferred2_0;
        let deferred2_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.analytichandle_restore(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred2_0 = r0;
            deferred2_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export3(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * The versioned envelope (`SPNA`): the analytic's own bytes plus the
     * live feed's cursor when one is set up, so a restore can resume
     * instead of failing closed. A snapshot taken while a RESUME is pending
     * (a restore carried a cursor, `feed_setup` not yet run) re-emits that
     * pending cursor without consuming it, so snapshot -> restore -> snapshot
     * round trips. Empty for a broken (bad-config) handle.
     * @returns {Uint8Array}
     */
    snapshot() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.analytichandle_snapshot(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) AnalyticHandle.prototype[Symbol.dispose] = AnalyticHandle.prototype.free;
exports.AnalyticHandle = AnalyticHandle;

/**
 * The path-based Renko engine (`spine::renko`, RENKO_BARS_DESIGN §7a) for the
 * Vela `renko:` provider. No bar rule here: `RenkoEngine`'s JSON facade does
 * the work, so this binding, `spine_ffi` and the Nautilus host return the
 * same bytes for the same trades (`spine/tests/renko_golden.rs`).
 *
 * A bad config does not throw: the handle is created broken and every call
 * returns the `{"error": ...}` envelope, like the rest of this crate.
 */
class RenkoHandle {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RenkoHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_renkohandle_free(ptr, 0);
    }
    /**
     * `config_json`: `{"tick_size":0.25,"trend_ticks":4,"reversal_ticks":12,"session":"GlobexDay"}`.
     * @param {string} config_json
     */
    constructor(config_json) {
        const ptr0 = passStringToWasm0(config_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.renkohandle_new(ptr0, len0);
        this.__wbg_ptr = ret;
        RenkoHandleFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Bars JSON in (`[{"ts_ns":"<epoch ns>","open":..,"high":..,"low":..,"close":..,"volume":..}]`),
     * completed bricks JSON out. The bar -> trades step is the engine's
     * (`RenkoEngine::on_bars_json`, RENKO_BARS_DESIGN C1), not this binding's.
     * @param {string} bars_json
     * @returns {string}
     */
    on_bars(bars_json) {
        let deferred2_0;
        let deferred2_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(bars_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.renkohandle_on_bars(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred2_0 = r0;
            deferred2_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export3(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Bars in as six columns (Vela's history feed), completed bricks out as
     * `RKB1` bytes. `ts_ms` is each bar's epoch MILLISECONDS as a JS number
     * (exact below 2^53); the engine's clock is nanoseconds and this binding
     * converts. Same validation, same intrabar path and same all-or-nothing
     * batch as `on_bars`; a refusal throws the engine's text as a JS string.
     * @param {Float64Array} ts_ms
     * @param {Float64Array} open
     * @param {Float64Array} high
     * @param {Float64Array} low
     * @param {Float64Array} close
     * @param {Float64Array} volume
     * @returns {Uint8Array}
     */
    on_bars_binary(ts_ms, open, high, low, close, volume) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArrayF64ToWasm0(ts_ms, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArrayF64ToWasm0(open, wasm.__wbindgen_export);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArrayF64ToWasm0(high, wasm.__wbindgen_export);
            const len2 = WASM_VECTOR_LEN;
            const ptr3 = passArrayF64ToWasm0(low, wasm.__wbindgen_export);
            const len3 = WASM_VECTOR_LEN;
            const ptr4 = passArrayF64ToWasm0(close, wasm.__wbindgen_export);
            const len4 = WASM_VECTOR_LEN;
            const ptr5 = passArrayF64ToWasm0(volume, wasm.__wbindgen_export);
            const len5 = WASM_VECTOR_LEN;
            wasm.renkohandle_on_bars_binary(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v7 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v7;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Trades JSON in (`[{"ts_ns":"<epoch ns>","price":..,"size":..}]`; `ts_ns` a
     * string or an integer), completed bars JSON out (`[]` when none).
     * @param {string} trades_json
     * @returns {string}
     */
    on_trades(trades_json) {
        let deferred2_0;
        let deferred2_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(trades_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.renkohandle_on_trades(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred2_0 = r0;
            deferred2_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export3(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Where the next bar completes: `{"prior_close","high","low","trend",...}`
     * (`RenkoEngine::projection`), `null` before the first trade.
     * @returns {string}
     */
    projection() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.renkohandle_projection(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export3(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Empty string on success, the error envelope otherwise.
     * @param {Uint8Array} bytes
     * @returns {string}
     */
    restore(bytes) {
        let deferred2_0;
        let deferred2_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.renkohandle_restore(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred2_0 = r0;
            deferred2_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export3(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @returns {Uint8Array}
     */
    snapshot() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.renkohandle_snapshot(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) RenkoHandle.prototype[Symbol.dispose] = RenkoHandle.prototype.free;
exports.RenkoHandle = RenkoHandle;

/**
 * The percent / ATR Renko engine (`spine::renko_sized`, RENKO_BARS_DESIGN D3,
 * D6): the same engine as [`RenkoHandle`], sized per session by a rule instead
 * of a fixed T and R. A fixed `renko:T,R` chart keeps using `RenkoHandle`.
 *
 * `config_json`: `{"tick_size":0.25,"rule":{"kind":"percent","pct":0.005,"reversal_ratio":3}}`
 * or `{"tick_size":0.25,"rule":{"kind":"atr","len":14,"mult":1,"reversal_ratio":3},"warmup_daily":[{"high":..,"low":..,"close":..}]}`.
 * A bad config does not throw: every call returns the `{"error": ...}` envelope.
 */
class SizedRenkoHandle {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SizedRenkoHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_sizedrenkohandle_free(ptr, 0);
    }
    /**
     * @param {string} config_json
     */
    constructor(config_json) {
        const ptr0 = passStringToWasm0(config_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sizedrenkohandle_new(ptr0, len0);
        this.__wbg_ptr = ret;
        SizedRenkoHandleFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Bars in (as [`RenkoHandle::on_bars`]), completed bricks out.
     * @param {string} bars_json
     * @returns {string}
     */
    on_bars(bars_json) {
        let deferred2_0;
        let deferred2_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(bars_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.sizedrenkohandle_on_bars(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred2_0 = r0;
            deferred2_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export3(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * As [`RenkoHandle::on_bars_binary`], under the session's frozen size.
     * @param {Float64Array} ts_ms
     * @param {Float64Array} open
     * @param {Float64Array} high
     * @param {Float64Array} low
     * @param {Float64Array} close
     * @param {Float64Array} volume
     * @returns {Uint8Array}
     */
    on_bars_binary(ts_ms, open, high, low, close, volume) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArrayF64ToWasm0(ts_ms, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArrayF64ToWasm0(open, wasm.__wbindgen_export);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArrayF64ToWasm0(high, wasm.__wbindgen_export);
            const len2 = WASM_VECTOR_LEN;
            const ptr3 = passArrayF64ToWasm0(low, wasm.__wbindgen_export);
            const len3 = WASM_VECTOR_LEN;
            const ptr4 = passArrayF64ToWasm0(close, wasm.__wbindgen_export);
            const len4 = WASM_VECTOR_LEN;
            const ptr5 = passArrayF64ToWasm0(volume, wasm.__wbindgen_export);
            const len5 = WASM_VECTOR_LEN;
            wasm.sizedrenkohandle_on_bars_binary(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v7 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v7;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * As [`RenkoHandle::projection`], under the session's frozen size.
     * @returns {string}
     */
    projection() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.sizedrenkohandle_projection(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export3(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Empty string on success, the error envelope otherwise.
     * @param {Uint8Array} bytes
     * @returns {string}
     */
    restore(bytes) {
        let deferred2_0;
        let deferred2_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.sizedrenkohandle_restore(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred2_0 = r0;
            deferred2_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export3(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * The size chosen for every session so far, as JSON
     * (`[{"session":..,"ts_ns":"<epoch ns>","trend_ticks":..,"reversal_ticks":..}]`).
     * @returns {string}
     */
    sizes() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.sizedrenkohandle_sizes(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export3(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {Uint8Array}
     */
    snapshot() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.sizedrenkohandle_snapshot(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) SizedRenkoHandle.prototype[Symbol.dispose] = SizedRenkoHandle.prototype.free;
exports.SizedRenkoHandle = SizedRenkoHandle;

/**
 * Returns the JSON schema for an analytic's params by its key, or an error envelope if unknown.
 * @param {string} key
 * @returns {string}
 */
function analytic_params_schema(key) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        wasm.analytic_params_schema(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred2_0 = r0;
        deferred2_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred2_0, deferred2_1, 1);
    }
}
exports.analytic_params_schema = analytic_params_schema;

/**
 * Batch causal Candle Science v17.5 16-dim computation over parallel typed arrays of sorted bars
 * (`1d` settlements or MTF `4h/1h/15m`). Returns JSON array of `CsCandleRow` or `{"error": ...}`.
 * @param {Float64Array} bar_ts_s
 * @param {Int32Array} trade_date_days
 * @param {Float64Array} open
 * @param {Float64Array} high
 * @param {Float64Array} low
 * @param {Float64Array} close
 * @param {Uint8Array} is_roll
 * @returns {string}
 */
function candle_science_batch(bar_ts_s, trade_date_days, open, high, low, close, is_roll) {
    let deferred8_0;
    let deferred8_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayF64ToWasm0(bar_ts_s, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(trade_date_days, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayF64ToWasm0(open, wasm.__wbindgen_export);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF64ToWasm0(high, wasm.__wbindgen_export);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArrayF64ToWasm0(low, wasm.__wbindgen_export);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArrayF64ToWasm0(close, wasm.__wbindgen_export);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passArray8ToWasm0(is_roll, wasm.__wbindgen_export);
        const len6 = WASM_VECTOR_LEN;
        wasm.candle_science_batch(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred8_0 = r0;
        deferred8_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred8_0, deferred8_1, 1);
    }
}
exports.candle_science_batch = candle_science_batch;

/**
 * Classify a live forming C3 candle using completed C1, completed C2, and C3 open (zero lookahead).
 * @param {number} c1_o
 * @param {number} c1_h
 * @param {number} c1_l
 * @param {number} c1_c
 * @param {number} c2_o
 * @param {number} c2_h
 * @param {number} c2_l
 * @param {number} c2_c
 * @param {number} c3_o
 * @returns {string}
 */
function candle_science_live(c1_o, c1_h, c1_l, c1_c, c2_o, c2_h, c2_l, c2_c, c3_o) {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.candle_science_live(retptr, c1_o, c1_h, c1_l, c1_c, c2_o, c2_h, c2_l, c2_c, c3_o);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred1_0, deferred1_1, 1);
    }
}
exports.candle_science_live = candle_science_live;

/**
 * Batch causal Daily Profiler computation over parallel typed arrays of sorted 1m bars
 * (open-timestamped in UTC seconds). Returns JSON `{ "days": [...], "paths": [...] }`
 * or `{"error": ...}`.
 * @param {Float64Array} ts_open_s
 * @param {Float64Array} open
 * @param {Float64Array} high
 * @param {Float64Array} low
 * @param {Float64Array} close
 * @param {Float64Array} volume
 * @param {Uint8Array} is_roll
 * @returns {string}
 */
function daily_profiler_batch(ts_open_s, open, high, low, close, volume, is_roll) {
    let deferred8_0;
    let deferred8_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayF64ToWasm0(ts_open_s, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(open, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayF64ToWasm0(high, wasm.__wbindgen_export);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF64ToWasm0(low, wasm.__wbindgen_export);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArrayF64ToWasm0(close, wasm.__wbindgen_export);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArrayF64ToWasm0(volume, wasm.__wbindgen_export);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passArray8ToWasm0(is_roll, wasm.__wbindgen_export);
        const len6 = WASM_VECTOR_LEN;
        wasm.daily_profiler_batch(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred8_0 = r0;
        deferred8_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred8_0, deferred8_1, 1);
    }
}
exports.daily_profiler_batch = daily_profiler_batch;

/**
 * Evaluate one 1m bar for IB Play 1. `bar_time` is ET `YYYY-MM-DD HH:MM:SS`;
 * `ib_high`/`ib_low` carry `NaN` when the window hasn't formed (same
 * contract as the C ABI). Returns the canonical decision JSON.
 * @param {string} bar_time
 * @param {number} minute
 * @param {number} open
 * @param {number} high
 * @param {number} low
 * @param {number} close
 * @param {number} ib_high
 * @param {number} ib_low
 * @param {boolean} long_taken
 * @param {boolean} short_taken
 * @returns {string}
 */
function play1_evaluate(bar_time, minute, open, high, low, close, ib_high, ib_low, long_taken, short_taken) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(bar_time, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        wasm.play1_evaluate(retptr, ptr0, len0, minute, open, high, low, close, ib_high, ib_low, long_taken, short_taken);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred2_0 = r0;
        deferred2_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred2_0, deferred2_1, 1);
    }
}
exports.play1_evaluate = play1_evaluate;

/**
 * Derive the chart overlay for a decision. `decision_json` is the exact
 * bytes [`play1_evaluate`] returned (canonical round-trip); `ib_high` /
 * `ib_low` are the formed range, or `NaN` for no zone. Returns overlay JSON.
 * @param {string} decision_json
 * @param {number} ib_high
 * @param {number} ib_low
 * @returns {string}
 */
function play1_overlay(decision_json, ib_high, ib_low) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(decision_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        wasm.play1_overlay(retptr, ptr0, len0, ib_high, ib_low);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred2_0 = r0;
        deferred2_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred2_0, deferred2_1, 1);
    }
}
exports.play1_overlay = play1_overlay;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_bb96b2010945f0bc: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return addHeapObject(ret);
        },
    };
    return {
        __proto__: null,
        "./spine_wasm_bg.js": import0,
    };
}

const AnalyticHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_analytichandle_free(ptr, 1));
const RenkoHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_renkohandle_free(ptr, 1));
const SizedRenkoHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sizedrenkohandle_free(ptr, 1));

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function dropObject(idx) {
    if (idx < 1028) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getObject(idx) { return heap[idx]; }

let heap = new Array(1024).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
function decodeText(ptr, len) {
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

const wasmPath = `${__dirname}/spine_wasm_bg.wasm`;
const wasmBytes = require('fs').readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
let wasmInstance = new WebAssembly.Instance(wasmModule, __wbg_get_imports());
let wasm = wasmInstance.exports;
