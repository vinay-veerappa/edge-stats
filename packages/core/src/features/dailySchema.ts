/*
  Normalized daily rollup schemas for Daily Profiler (daily_context),
  Candle Science v17.5 (cs_candles), and 5m Composite Price Paths (daily_paths_5m).
*/
import type { Store } from "../store/store";
import type { ColumnSpec } from "./schema";
import { LEVEL_KEYS } from "./spineAdapter";

const PROFILER_SESSIONS = ["asia", "london", "ny1", "ny2"] as const;

export function dailyContextColumns(): ColumnSpec[] {
  const cols: ColumnSpec[] = [
    { name: "symbol", type: "VARCHAR" },
    { name: "trade_date", type: "DATE" },
    { name: "prev_trade_date", type: "DATE" },
    { name: "dow", type: "INTEGER" },
    { name: "month", type: "INTEGER" },
    { name: "year", type: "INTEGER" },
    { name: "week_of_month", type: "INTEGER" },
    { name: "complete", type: "BOOLEAN" },
    { name: "is_roll_day", type: "BOOLEAN" },
    { name: "roll_adjacent", type: "BOOLEAN" },
    { name: "daily_open", type: "DOUBLE" },
    { name: "daily_high", type: "DOUBLE" },
    { name: "daily_low", type: "DOUBLE" },
    { name: "daily_close", type: "DOUBLE" },
    { name: "prev_close", type: "DOUBLE" },
    { name: "daily_high_bps", type: "DOUBLE" },
    { name: "daily_low_bps", type: "DOUBLE" },
    { name: "daily_range_bps", type: "DOUBLE" },
    { name: "hod_min", type: "INTEGER" },
    { name: "lod_min", type: "INTEGER" },
    { name: "hod_session", type: "VARCHAR" },
    { name: "lod_session", type: "VARCHAR" },
  ];

  for (const s of PROFILER_SESSIONS) {
    cols.push(
      { name: `${s}_box_open`, type: "DOUBLE" },
      { name: `${s}_box_high`, type: "DOUBLE" },
      { name: `${s}_box_low`, type: "DOUBLE" },
      { name: `${s}_box_mid`, type: "DOUBLE" },
      { name: `${s}_box_range_bps`, type: "DOUBLE" },
      { name: `${s}_status`, type: "VARCHAR" },
      { name: `${s}_dir`, type: "INTEGER" },
      { name: `${s}_false_break`, type: "BOOLEAN" },
      { name: `${s}_status_at_min`, type: "INTEGER" },
      { name: `${s}_broken`, type: "BOOLEAN" },
      { name: `${s}_broken_at_min`, type: "INTEGER" },
      { name: `${s}_eval_high_bps`, type: "DOUBLE" },
      { name: `${s}_eval_low_bps`, type: "DOUBLE" },
    );
  }

  for (const s of PROFILER_SESSIONS) {
    cols.push(
      { name: `prev_${s}_status`, type: "VARCHAR" },
      { name: `prev_${s}_broken`, type: "BOOLEAN" },
    );
  }

  cols.push(
    { name: "p12_high", type: "DOUBLE" },
    { name: "p12_low", type: "DOUBLE" },
    { name: "p12_mid", type: "DOUBLE" },
    { name: "p12_scenario", type: "VARCHAR" },
    { name: "ny_p12_high", type: "DOUBLE" },
    { name: "ny_p12_low", type: "DOUBLE" },
    { name: "ny_p12_mid", type: "DOUBLE" },
    { name: "asia_london_aligned", type: "BOOLEAN" },
    { name: "asia_london_pattern", type: "VARCHAR" },
    { name: "broken_broken", type: "BOOLEAN" },
    { name: "aln_pattern", type: "VARCHAR" },
    { name: "aln_bias", type: "INTEGER" },
    { name: "aln_chop", type: "BOOLEAN" },
    { name: "rth_gap", type: "VARCHAR" },
  );

  for (const lv of LEVEL_KEYS) {
    cols.push(
      { name: `touch_${lv}`, type: "BOOLEAN" },
      { name: `touch_${lv}_min`, type: "INTEGER" },
      { name: `touch_${lv}_mask`, type: "INTEGER" },
    );
  }

  return cols;
}

export const CS_CANDLES_COLUMNS: ColumnSpec[] = [
  { name: "symbol", type: "VARCHAR" },
  { name: "tf", type: "VARCHAR" },
  { name: "bar_ts", type: "BIGINT" },
  { name: "trade_date", type: "DATE" },
  { name: "dow", type: "INTEGER" },
  { name: "month", type: "INTEGER" },
  { name: "year", type: "INTEGER" },
  { name: "complete", type: "BOOLEAN" },
  { name: "roll_safe", type: "BOOLEAN" },
  { name: "c1_o", type: "DOUBLE" },
  { name: "c1_h", type: "DOUBLE" },
  { name: "c1_l", type: "DOUBLE" },
  { name: "c1_c", type: "DOUBLE" },
  { name: "c2_o", type: "DOUBLE" },
  { name: "c2_h", type: "DOUBLE" },
  { name: "c2_l", type: "DOUBLE" },
  { name: "c2_c", type: "DOUBLE" },
  { name: "c3_o", type: "DOUBLE" },
  { name: "c3_h", type: "DOUBLE" },
  { name: "c3_l", type: "DOUBLE" },
  { name: "c3_c", type: "DOUBLE" },
  { name: "sig_mask", type: "UINTEGER" },
  { name: "c1_dir", type: "VARCHAR" },
  { name: "c2_dir", type: "VARCHAR" },
  { name: "c2_rel", type: "VARCHAR" },
  { name: "c3o_zone", type: "VARCHAR" },
  { name: "c3_bull", type: "BOOLEAN" },
  { name: "c3h_gt_c2h", type: "BOOLEAN" },
  { name: "c3l_lt_c2l", type: "BOOLEAN" },
  { name: "c3c_gt_c2h", type: "BOOLEAN" },
  { name: "c3c_gt_c2o", type: "BOOLEAN" },
  { name: "c3c_gt_c2c", type: "BOOLEAN" },
  { name: "c3c_gt_c2l", type: "BOOLEAN" },
  { name: "c3h_lte_c2h", type: "BOOLEAN" },
  { name: "c3l_gte_c2l", type: "BOOLEAN" },
  { name: "dist_c3h_c2h_bps", type: "DOUBLE" },
  { name: "dist_c3l_c2l_bps", type: "DOUBLE" },
  { name: "dist_c3h_c2c_bps", type: "DOUBLE" },
  { name: "dist_c3l_c2c_bps", type: "DOUBLE" },
  { name: "dist_c3h_c2o_bps", type: "DOUBLE" },
  { name: "dist_c3l_c2o_bps", type: "DOUBLE" },
  { name: "dist_c3h_c2l_bps", type: "DOUBLE" },
  { name: "dist_c3l_c2h_bps", type: "DOUBLE" },
  { name: "mfe_long_c3o_bps", type: "DOUBLE" },
  { name: "mfe_short_c3o_bps", type: "DOUBLE" },
];

export const DAILY_PATHS_5M_COLUMNS: ColumnSpec[] = [
  { name: "symbol", type: "VARCHAR" },
  { name: "trade_date", type: "DATE" },
  { name: "bucket_idx", type: "INTEGER" },
  { name: "high_bps_prev_close", type: "DOUBLE" },
  { name: "low_bps_prev_close", type: "DOUBLE" },
  { name: "close_bps_prev_close", type: "DOUBLE" },
  { name: "high_bps_daily_open", type: "DOUBLE" },
  { name: "low_bps_daily_open", type: "DOUBLE" },
  { name: "close_bps_daily_open", type: "DOUBLE" },
];

async function ensureTable(
  store: Store,
  tableName: string,
  cols: ColumnSpec[],
  primaryKey: string,
): Promise<void> {
  const existing = await store.all(
    `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableName}'`,
  );
  if (existing.length === 0) {
    const body = cols.map((c) => `  ${c.name} ${c.type}`).join(",\n");
    await store.run(
      `CREATE TABLE ${tableName} (\n${body},\n  PRIMARY KEY (${primaryKey})\n)`,
    );
    return;
  }
  const existingSet = new Set(existing.map((r) => String(r.column_name)));
  for (const col of cols) {
    if (!existingSet.has(col.name)) {
      await store.run(`ALTER TABLE ${tableName} ADD COLUMN ${col.name} ${col.type}`);
    }
  }
}

export async function ensureDailyTables(store: Store): Promise<void> {
  await ensureTable(store, "daily_context", dailyContextColumns(), "symbol, trade_date");
  await ensureTable(store, "cs_candles", CS_CANDLES_COLUMNS, "symbol, tf, bar_ts");
  await ensureTable(store, "daily_paths_5m", DAILY_PATHS_5M_COLUMNS, "symbol, trade_date, bucket_idx");
}
