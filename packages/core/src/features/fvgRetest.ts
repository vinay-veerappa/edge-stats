/*
  Post-OR30 FVG lifecycle & retest trade outcomes (bps-standardized).

  Computes, on a single session's post-OR30 1m bars (ts >= startTs + 30m):
    1. First 1m FVG breakout (>= 1.0 bps, close beyond OR30 H/L):
       - Lifecycle: size_bps, retested (within 10 bars), retest_min,
         fill_depth_pct (0..100), held (retested & never closed through far edge).
       - Retest trade: MFE/MAE in bps + Cover-the-Queen (CTQ) PnL in bps
         for (15/10/30), (12/10/25), and (10/8/20).
    2. First 5m FVG breakout (>= 1.5 bps, causally folded from 1m bars,
       retest within 15 1m bars): dir, retested, held, MFE/MAE/CTQ(12/10/25).
    3. First 5m Sweep Fade (P3B: swept OR30 H/L on c2/c1/c0, closed back
       inside with >= 1.5 bps 5m FVG): dir, MFE/MAE/CTQ(12/10/25).
*/

import { round } from "../util/values";

export interface Bar1m {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface FvgRetestMetrics {
  fvg1m_dir: "up" | "down" | null;
  fvg1m_size_bps: number | null;
  fvg1m_retested: boolean | null;
  fvg1m_retest_min: number | null;
  fvg1m_fill_depth_pct: number | null;
  fvg1m_held: boolean | null;
  fvg1m_ret_mfe_bps: number | null;
  fvg1m_ret_mae_bps: number | null;
  fvg1m_ret_ctq15_bps: number | null;
  fvg1m_ret_ctq12_bps: number | null;
  fvg1m_ret_ctq10_bps: number | null;

  fvg5m_dir: "up" | "down" | null;
  fvg5m_retested: boolean | null;
  fvg5m_held: boolean | null;
  fvg5m_ret_mfe_bps: number | null;
  fvg5m_ret_mae_bps: number | null;
  fvg5m_ret_ctq12_bps: number | null;

  p3b5m_dir: "up" | "down" | null;
  p3b5m_mfe_bps: number | null;
  p3b5m_mae_bps: number | null;
  p3b5m_ctq12_bps: number | null;
}

export function emptyFvgRetestMetrics(): FvgRetestMetrics {
  return {
    fvg1m_dir: null,
    fvg1m_size_bps: null,
    fvg1m_retested: null,
    fvg1m_retest_min: null,
    fvg1m_fill_depth_pct: null,
    fvg1m_held: null,
    fvg1m_ret_mfe_bps: null,
    fvg1m_ret_mae_bps: null,
    fvg1m_ret_ctq15_bps: null,
    fvg1m_ret_ctq12_bps: null,
    fvg1m_ret_ctq10_bps: null,
    fvg5m_dir: null,
    fvg5m_retested: null,
    fvg5m_held: null,
    fvg5m_ret_mfe_bps: null,
    fvg5m_ret_mae_bps: null,
    fvg5m_ret_ctq12_bps: null,
    p3b5m_dir: null,
    p3b5m_mfe_bps: null,
    p3b5m_mae_bps: null,
    p3b5m_ctq12_bps: null,
  };
}

/** Causal bar-by-bar Cover-the-Queen (worst-case SL first inside ambiguous bar) + raw MFE/MAE in bps. */
export function simCtqBps(
  bars: readonly Bar1m[],
  startIdx: number,
  exitTs: number,
  ep: number,
  isLong: boolean,
  slBps: number,
  qBps: number,
  rBps: number,
): { mfe: number; mae: number; pnl: number } {
  if (startIdx >= bars.length || ep <= 0) return { mfe: 0, mae: 0, pnl: 0 };

  let maxH = -Infinity;
  let minL = Infinity;
  let lastClose = ep;
  for (let k = startIdx; k < bars.length; k += 1) {
    const b = bars[k];
    if (!b || b.ts > exitTs) break;
    if (b.high > maxH) maxH = b.high;
    if (b.low < minL) minL = b.low;
    lastClose = b.close;
  }
  if (!Number.isFinite(maxH) || !Number.isFinite(minL)) {
    return { mfe: 0, mae: 0, pnl: 0 };
  }

  const mfe = isLong ? ((maxH - ep) / ep) * 10000 : ((ep - minL) / ep) * 10000;
  const mae = isLong ? ((ep - minL) / ep) * 10000 : ((maxH - ep) / ep) * 10000;

  let slPx = isLong ? ep * (1 - slBps / 10000) : ep * (1 + slBps / 10000);
  const qPx = isLong ? ep * (1 + qBps / 10000) : ep * (1 - qBps / 10000);
  const rPx = isLong ? ep * (1 + rBps / 10000) : ep * (1 - rBps / 10000);

  let qHit = false;
  for (let k = startIdx; k < bars.length; k += 1) {
    const b = bars[k];
    if (!b || b.ts > exitTs) break;
    if (isLong) {
      if (!qHit) {
        if (b.low <= slPx) return { mfe, mae, pnl: -slBps };
        if (b.high >= rPx) return { mfe, mae, pnl: 0.5 * qBps + 0.5 * rBps };
        if (b.high >= qPx) {
          qHit = true;
          slPx = ep;
        }
      } else {
        if (b.low <= slPx) return { mfe, mae, pnl: 0.5 * qBps };
        if (b.high >= rPx) return { mfe, mae, pnl: 0.5 * qBps + 0.5 * rBps };
      }
    } else {
      if (!qHit) {
        if (b.high >= slPx) return { mfe, mae, pnl: -slBps };
        if (b.low <= rPx) return { mfe, mae, pnl: 0.5 * qBps + 0.5 * rBps };
        if (b.low <= qPx) {
          qHit = true;
          slPx = ep;
        }
      } else {
        if (b.high >= slPx) return { mfe, mae, pnl: 0.5 * qBps };
        if (b.low <= rPx) return { mfe, mae, pnl: 0.5 * qBps + 0.5 * rBps };
      }
    }
  }

  const rem = isLong ? ((lastClose - ep) / ep) * 10000 : ((ep - lastClose) / ep) * 10000;
  return { mfe, mae, pnl: qHit ? 0.5 * qBps + 0.5 * rem : rem };
}

function trackFvgLifecycle(
  bars: readonly Bar1m[],
  fromIdx: number,
  exitTs: number,
  zoneLow: number,
  zoneHigh: number,
  isLong: boolean,
): { fillDepthPct: number; failed: boolean } {
  const width = zoneHigh - zoneLow;
  if (width <= 0) return { fillDepthPct: 0, failed: false };
  let maxDepth = 0;
  let failed = false;
  for (let k = fromIdx; k < bars.length; k += 1) {
    const b = bars[k];
    if (!b || b.ts > exitTs) break;
    if (isLong) {
      if (b.low <= zoneHigh) {
        const d = ((zoneHigh - Math.max(b.low, zoneLow)) / width) * 100;
        if (d > maxDepth) maxDepth = d;
      }
      if (b.close < zoneLow) failed = true;
    } else {
      if (b.high >= zoneLow) {
        const d = ((Math.min(b.high, zoneHigh) - zoneLow) / width) * 100;
        if (d > maxDepth) maxDepth = d;
      }
      if (b.close > zoneHigh) failed = true;
    }
  }
  return { fillDepthPct: Math.min(100, Math.max(0, maxDepth)), failed };
}

export function computePostOr30FvgMetrics(
  bars: readonly Bar1m[],
  orHigh: number,
  orLow: number,
  sessionEndTs: number,
): FvgRetestMetrics {
  const res = emptyFvgRetestMetrics();
  if (bars.length < 5 || orHigh <= orLow) return res;

  // Cutoff: latest entry 30m before session close (or 15:30 on 16:00 close); hard exit 10m before close (15:50).
  const entryCutoffTs = sessionEndTs - 30 * 60000;
  const exitTs = sessionEndTs - 10 * 60000;

  // 1) First 1m FVG (>= 1.0 bps) closing beyond OR30
  for (let i = 2; i < bars.length; i += 1) {
    const c2 = bars[i - 2];
    const c0 = bars[i];
    if (!c2 || !c0 || c0.ts > entryCutoffTs) break;

    const bullGap = c0.low - c2.high;
    const bearGap = c2.low - c0.high;
    const bull = bullGap > 0 && c0.close > 0 && (bullGap / c0.close) * 10000 >= 1.0 && c0.close > orHigh;
    const bear = bearGap > 0 && c0.close > 0 && (bearGap / c0.close) * 10000 >= 1.0 && c0.close < orLow;
    if (!bull && !bear) continue;

    const isLong = bull;
    const zoneLow = isLong ? c2.high : c0.high;
    const zoneHigh = isLong ? c0.low : c2.low;
    const sizeBps = ((zoneHigh - zoneLow) / c0.close) * 10000;

    res.fvg1m_dir = isLong ? "up" : "down";
    res.fvg1m_size_bps = round(sizeBps, 2);

    const life = trackFvgLifecycle(bars, i + 1, exitTs, zoneLow, zoneHigh, isLong);
    res.fvg1m_fill_depth_pct = round(life.fillDepthPct, 1);

    const lvl = isLong ? zoneHigh : zoneLow;
    let retestIdx = -1;
    for (let k = i + 1; k < Math.min(i + 11, bars.length); k += 1) {
      const bk = bars[k];
      if (!bk || bk.ts > entryCutoffTs) break;
      if ((isLong && bk.low <= lvl) || (!isLong && bk.high >= lvl)) {
        retestIdx = k;
        break;
      }
    }
    res.fvg1m_retested = retestIdx >= 0;
    if (retestIdx >= 0) {
      const rb = bars[retestIdx]!;
      res.fvg1m_retest_min = Math.max(0, Math.round((rb.ts - c0.ts) / 60000));
      res.fvg1m_held = !life.failed;
      const s15 = simCtqBps(bars, retestIdx + 1, exitTs, lvl, isLong, 15, 10, 30);
      const s12 = simCtqBps(bars, retestIdx + 1, exitTs, lvl, isLong, 12, 10, 25);
      const s10 = simCtqBps(bars, retestIdx + 1, exitTs, lvl, isLong, 10, 8, 20);
      res.fvg1m_ret_mfe_bps = round(s15.mfe, 2);
      res.fvg1m_ret_mae_bps = round(s15.mae, 2);
      res.fvg1m_ret_ctq15_bps = round(s15.pnl, 2);
      res.fvg1m_ret_ctq12_bps = round(s12.pnl, 2);
      res.fvg1m_ret_ctq10_bps = round(s10.pnl, 2);
    } else {
      res.fvg1m_held = null;
    }
    break;
  }

  // Fold causal 5m bars from 1m bars
  interface Bar5m {
    next1mIdx: number;
    ts: number;
    open: number;
    high: number;
    low: number;
    close: number;
  }
  const b5: Bar5m[] = [];
  for (let idx = 0; idx + 5 <= bars.length; idx += 5) {
    let h = -Infinity;
    let l = Infinity;
    for (let m = 0; m < 5; m += 1) {
      const bm = bars[idx + m]!;
      if (bm.high > h) h = bm.high;
      if (bm.low < l) l = bm.low;
    }
    const first = bars[idx]!;
    const last = bars[idx + 4]!;
    b5.push({ next1mIdx: idx + 5, ts: last.ts, open: first.open, high: h, low: l, close: last.close });
  }

  // 2) First 5m FVG breakout (>= 1.5 bps) & 3) First 5m P3B sweep fade
  let done5m = false;
  let doneP3b = false;
  for (let j = 2; j < b5.length; j += 1) {
    const c2 = b5[j - 2]!;
    const c1 = b5[j - 1]!;
    const c0 = b5[j]!;
    if (c0.ts > entryCutoffTs) break;

    const bullFvg = c0.low > c2.high && c0.close > 0 && ((c0.low - c2.high) / c0.close) * 10000 >= 1.5;
    const bearFvg = c0.high < c2.low && c0.close > 0 && ((c2.low - c0.high) / c0.close) * 10000 >= 1.5;

    if (!done5m && ((bullFvg && c0.close > orHigh) || (bearFvg && c0.close < orLow))) {
      done5m = true;
      const isLong = bullFvg && c0.close > orHigh;
      const zoneLow = isLong ? c2.high : c0.high;
      const zoneHigh = isLong ? c0.low : c2.low;
      const lvl = isLong ? zoneHigh : zoneLow;
      res.fvg5m_dir = isLong ? "up" : "down";

      const life = trackFvgLifecycle(bars, c0.next1mIdx, exitTs, zoneLow, zoneHigh, isLong);
      let retestIdx = -1;
      for (let k = c0.next1mIdx; k < Math.min(c0.next1mIdx + 15, bars.length); k += 1) {
        const bk = bars[k];
        if (!bk || bk.ts > entryCutoffTs) break;
        if ((isLong && bk.low <= lvl) || (!isLong && bk.high >= lvl)) {
          retestIdx = k;
          break;
        }
      }
      res.fvg5m_retested = retestIdx >= 0;
      if (retestIdx >= 0) {
        res.fvg5m_held = !life.failed;
        const s12 = simCtqBps(bars, retestIdx + 1, exitTs, lvl, isLong, 12, 10, 25);
        res.fvg5m_ret_mfe_bps = round(s12.mfe, 2);
        res.fvg5m_ret_mae_bps = round(s12.mae, 2);
        res.fvg5m_ret_ctq12_bps = round(s12.pnl, 2);
      }
    }

    if (!doneP3b) {
      const sweptHi = c2.high > orHigh || c1.high > orHigh || c0.high > orHigh;
      const sweptLo = c2.low < orLow || c1.low < orLow || c0.low < orLow;
      if (bearFvg && sweptHi && c0.close < orHigh && c0.close < c0.open) {
        doneP3b = true;
        res.p3b5m_dir = "down";
        const s12 = simCtqBps(bars, c0.next1mIdx, exitTs, c0.close, false, 12, 10, 25);
        res.p3b5m_mfe_bps = round(s12.mfe, 2);
        res.p3b5m_mae_bps = round(s12.mae, 2);
        res.p3b5m_ctq12_bps = round(s12.pnl, 2);
      } else if (bullFvg && sweptLo && c0.close > orLow && c0.close > c0.open) {
        doneP3b = true;
        res.p3b5m_dir = "up";
        const s12 = simCtqBps(bars, c0.next1mIdx, exitTs, c0.close, true, 12, 10, 25);
        res.p3b5m_mfe_bps = round(s12.mfe, 2);
        res.p3b5m_mae_bps = round(s12.mae, 2);
        res.p3b5m_ctq12_bps = round(s12.pnl, 2);
      }
    }
    if (done5m && doneP3b) break;
  }

  return res;
}
