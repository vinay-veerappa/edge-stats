/*
  Thin Node.js adapter over crates/spine_wasm (ADR-039 single causal engine).
  All Profiler (Asia->London->NY1->NY2, ALN, P12, 20 level touches, 5m paths)
  and Candle Science (16-dim C1->C2->C3, after=1 roll mask) classifications
  come directly from the compiled Rust spine.
*/
import { createRequire } from "node:module";

export const LEVEL_KEYS = [
  "pdh",
  "pdm",
  "pdl",
  "p12h",
  "p12m",
  "p12l",
  "ny_p12h",
  "ny_p12m",
  "ny_p12l",
  "daily_open",
  "midnight_open",
  "open_0730",
  "asia_mid",
  "london_mid",
  "ny1_mid",
  "ny2_mid",
  "prev_asia_mid",
  "prev_london_mid",
  "prev_ny1_mid",
  "prev_ny2_mid",
] as const;

export type LevelKey = (typeof LEVEL_KEYS)[number];

export const CS_DIM_NAMES = [
  "c1_bull",
  "c2_bull",
  "c2h_gt_c1h",
  "c2h_gt_c1o",
  "c2l_gt_c1l",
  "c2l_gt_c1o",
  "c2c_gt_c1h",
  "c2c_gt_c1l",
  "c2c_gt_c1c",
  "c2c_gt_c1o",
  "c2o_gt_c1c",
  "c2o_gt_c1o",
  "c3o_gt_c2h",
  "c3o_gt_c2l",
  "c3o_gt_c2c",
  "c3o_gt_c2o",
] as const;

export type CsDimName = (typeof CS_DIM_NAMES)[number];

/** Bit index (0..15) in cs_candles.sig_mask for each structural dimension. */
export const CS_DIM_BIT: Record<CsDimName, number> = Object.fromEntries(
  CS_DIM_NAMES.map((name, idx) => [name, idx]),
) as Record<CsDimName, number>;

/** Friendly aliases accepted in DSL csDim("...") calls. */
export const CS_DIM_ALIASES: Record<string, CsDimName> = {
  c1_bull: "c1_bull",
  c2_bull: "c2_bull",
  "c2H>c1H": "c2h_gt_c1h",
  "c2H>c1O": "c2h_gt_c1o",
  "c2L>c1L": "c2l_gt_c1l",
  "c2L>c1O": "c2l_gt_c1o",
  "c2C>c1H": "c2c_gt_c1h",
  "c2C>c1L": "c2c_gt_c1l",
  "c2C>c1C": "c2c_gt_c1c",
  "c2C>c1O": "c2c_gt_c1o",
  "c2O>c1C": "c2o_gt_c1c",
  "c2O>c1O": "c2o_gt_c1o",
  "c3O>c2H": "c3o_gt_c2h",
  "c3O>c2L": "c3o_gt_c2l",
  "c3O>c2C": "c3o_gt_c2c",
  "c3O>c2O": "c3o_gt_c2o",
};

/** Reconciled canonical Candle Science v17.5 preset dimension tiers. */
export const CS_PRESET_DIMS: Record<"minimal" | "standard" | "detailed" | "full", readonly CsDimName[]> = {
  minimal: ["c1_bull", "c2_bull"],
  standard: [
    "c1_bull",
    "c2_bull",
    "c2h_gt_c1h",
    "c2l_gt_c1l",
    "c2c_gt_c1h",
    "c2c_gt_c1l",
    "c2c_gt_c1c",
    "c3o_gt_c2c",
  ],
  detailed: [
    "c1_bull",
    "c2_bull",
    "c2h_gt_c1h",
    "c2l_gt_c1l",
    "c2c_gt_c1h",
    "c2c_gt_c1l",
    "c2c_gt_c1c",
    "c2c_gt_c1o",
    "c3o_gt_c2c",
    "c3o_gt_c2o",
  ],
  full: CS_DIM_NAMES,
};

export interface SpineSessionState {
  box_open: number | null;
  box_high: number | null;
  box_low: number | null;
  box_mid: number | null;
  box_range_bps: number | null;
  status: string | null;
  dir: number | null;
  false_break: boolean | null;
  status_at_min: number | null;
  broken: boolean | null;
  broken_at_min: number | null;
  eval_high_bps: number | null;
  eval_low_bps: number | null;
}

export interface SpineLevelTouch {
  touched: boolean;
  first_min: number | null;
  mask: number;
}

export interface SpineDailyContextRow {
  trade_date: string;
  trade_date_days: number;
  prev_trade_date: string | null;
  dow: number;
  month: number;
  year: number;
  week_of_month: number;
  complete: boolean;
  is_roll_day: boolean;
  roll_adjacent: boolean;
  daily_open: number;
  daily_high: number;
  daily_low: number;
  daily_close: number;
  prev_close: number | null;
  daily_high_bps: number;
  daily_low_bps: number;
  daily_range_bps: number;
  hod_min: number;
  lod_min: number;
  hod_session: string;
  lod_session: string;
  asia: SpineSessionState;
  london: SpineSessionState;
  ny1: SpineSessionState;
  ny2: SpineSessionState;
  prev_asia_status: string | null;
  prev_asia_broken: boolean | null;
  prev_london_status: string | null;
  prev_london_broken: boolean | null;
  prev_ny1_status: string | null;
  prev_ny1_broken: boolean | null;
  prev_ny2_status: string | null;
  prev_ny2_broken: boolean | null;
  p12_high: number | null;
  p12_low: number | null;
  p12_mid: number | null;
  p12_scenario: string | null;
  ny_p12_high: number | null;
  ny_p12_low: number | null;
  ny_p12_mid: number | null;
  asia_london_aligned: boolean | null;
  asia_london_pattern: string | null;
  broken_broken: boolean | null;
  aln_pattern: string | null;
  aln_bias: number | null;
  aln_chop: boolean | null;
  rth_gap: string | null;
  touches: SpineLevelTouch[];
}

export interface SpineDailyPath5mRow {
  trade_date: string;
  bucket_idx: number;
  high_bps_prev_close: number | null;
  low_bps_prev_close: number | null;
  close_bps_prev_close: number | null;
  high_bps_daily_open: number;
  low_bps_daily_open: number;
  close_bps_daily_open: number;
}

export interface SpineDailyProfilerBatchOut {
  days: SpineDailyContextRow[];
  paths: SpineDailyPath5mRow[];
}

export interface SpineCsCandleRow {
  bar_ts_s: number;
  trade_date: string;
  dow: number;
  month: number;
  year: number;
  complete: boolean;
  roll_safe: boolean;
  c1_o: number;
  c1_h: number;
  c1_l: number;
  c1_c: number;
  c2_o: number;
  c2_h: number;
  c2_l: number;
  c2_c: number;
  c3_o: number;
  c3_h: number;
  c3_l: number;
  c3_c: number;
  sig_mask: number;
  c1_dir: string;
  c2_dir: string;
  c2_rel: string;
  c3o_zone: string;
  c3_bull: boolean;
  c3h_gt_c2h: boolean;
  c3l_lt_c2l: boolean;
  c3c_gt_c2h: boolean;
  c3c_gt_c2o: boolean;
  c3c_gt_c2c: boolean;
  c3c_gt_c2l: boolean;
  c3h_lte_c2h: boolean;
  c3l_gte_c2l: boolean;
  dist_c3h_c2h_bps: number;
  dist_c3l_c2l_bps: number;
  dist_c3h_c2c_bps: number;
  dist_c3l_c2c_bps: number;
  dist_c3h_c2o_bps: number;
  dist_c3l_c2o_bps: number;
  dist_c3h_c2l_bps: number;
  dist_c3l_c2h_bps: number;
  mfe_long_c3o_bps: number;
  mfe_short_c3o_bps: number;
}

export interface SpineCsLiveSignature {
  sig_mask: number;
  c1_dir: string;
  c2_dir: string;
  c2_rel: string;
  c3o_zone: string;
  dims: boolean[];
}

interface SpineWasmExports {
  daily_profiler_batch(
    ts_open_s: Float64Array,
    open: Float64Array,
    high: Float64Array,
    low: Float64Array,
    close: Float64Array,
    volume: Float64Array,
    is_roll: Uint8Array,
  ): string;
  candle_science_batch(
    bar_ts_s: Float64Array,
    trade_date_days: Int32Array,
    open: Float64Array,
    high: Float64Array,
    low: Float64Array,
    close: Float64Array,
    is_roll: Uint8Array,
  ): string;
  candle_science_live(
    c1_o: number,
    c1_h: number,
    c1_l: number,
    c1_c: number,
    c2_o: number,
    c2_h: number,
    c2_l: number,
    c2_c: number,
    c3_o: number,
  ): string;
}

let cachedWasm: SpineWasmExports | null = null;

function loadSpineWasm(): SpineWasmExports {
  if (cachedWasm) return cachedWasm;
  const req = createRequire(import.meta.url);
  cachedWasm = req("../spine-wasm/spine_wasm.js") as SpineWasmExports;
  return cachedWasm;
}

export function runDailyProfilerBatch(
  tsOpenS: Float64Array,
  open: Float64Array,
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  volume: Float64Array,
  isRoll: Uint8Array,
): SpineDailyProfilerBatchOut {
  const wasm = loadSpineWasm();
  const raw = wasm.daily_profiler_batch(tsOpenS, open, high, low, close, volume, isRoll);
  const parsed = JSON.parse(raw) as SpineDailyProfilerBatchOut | { error: string };
  if ("error" in parsed) {
    throw new Error(`spine_wasm daily_profiler_batch failed: ${parsed.error}`);
  }
  return parsed;
}

export function runCandleScienceBatch(
  barTsS: Float64Array,
  tradeDateDays: Int32Array,
  open: Float64Array,
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  isRoll: Uint8Array,
): SpineCsCandleRow[] {
  const wasm = loadSpineWasm();
  const raw = wasm.candle_science_batch(
    barTsS,
    tradeDateDays,
    open,
    high,
    low,
    close,
    isRoll,
  );
  const parsed = JSON.parse(raw) as SpineCsCandleRow[] | { error: string };
  if (!Array.isArray(parsed) && "error" in parsed) {
    throw new Error(`spine_wasm candle_science_batch failed: ${parsed.error}`);
  }
  return parsed as SpineCsCandleRow[];
}

export function classifyCandleScienceLive(
  c1: { open: number; high: number; low: number; close: number },
  c2: { open: number; high: number; low: number; close: number },
  c3Open: number,
): SpineCsLiveSignature {
  const wasm = loadSpineWasm();
  const raw = wasm.candle_science_live(
    c1.open,
    c1.high,
    c1.low,
    c1.close,
    c2.open,
    c2.high,
    c2.low,
    c2.close,
    c3Open,
  );
  return JSON.parse(raw) as SpineCsLiveSignature;
}
