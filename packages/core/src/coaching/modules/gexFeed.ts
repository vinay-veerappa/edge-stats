import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface GexLevelSummary {
  symbol: string; // ES1, NQ1
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  netGexTotal: number;
}

interface RawStrikeRow {
  strike?: number;
  call_gex?: number;
  put_gex?: number;
  net_gex?: number;
  cumulative_gex?: number;
}

let cachedMtime = 0;
let cachedGex: Record<string, GexLevelSummary> = {};

function summarizeProfile(symbol: string, rows: RawStrikeRow[]): GexLevelSummary | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  let callWall: number | null = null;
  let maxCallGex = -Infinity;
  let putWall: number | null = null;
  let maxPutGex = -Infinity;
  let netGexTotal = 0;
  let gammaFlip: number | null = null;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const strike = Number(r.strike);
    if (!Number.isFinite(strike)) continue;

    const cg = Number(r.call_gex ?? 0);
    const pg = Number(r.put_gex ?? 0);
    const ng = Number(r.net_gex ?? 0);
    netGexTotal += ng;

    if (cg > maxCallGex) {
      maxCallGex = cg;
      callWall = strike;
    }
    if (pg > maxPutGex) {
      maxPutGex = pg;
      putWall = strike;
    }

    if (i > 0) {
      const prevCum = Number(rows[i - 1].cumulative_gex ?? 0);
      const currCum = Number(r.cumulative_gex ?? 0);
      const prevStrike = Number(rows[i - 1].strike);
      if (
        Number.isFinite(prevStrike) &&
        ((prevCum < 0 && currCum >= 0) || (prevCum > 0 && currCum <= 0))
      ) {
        const denom = currCum - prevCum;
        const frac = denom !== 0 ? (0 - prevCum) / denom : 0.5;
        gammaFlip = Number((prevStrike + frac * (strike - prevStrike)).toFixed(2));
      }
    }
  }

  return { symbol, gammaFlip, callWall, putWall, netGexTotal };
}

export function readGexLevels(optionsDir?: string): Record<string, GexLevelSummary> {
  if (!optionsDir) return {};
  const path = resolve(optionsDir, "gex_profiles.json");
  if (!existsSync(path)) return {};

  try {
    const st = statSync(path);
    if (st.mtimeMs === cachedMtime) return cachedGex;

    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      profiles?: Record<string, RawStrikeRow[]>;
    };
    const profiles = parsed.profiles ?? {};
    const out: Record<string, GexLevelSummary> = {};

    const map: Array<[string, string]> = [
      ["ES", "ES1"],
      ["NQ", "NQ1"],
      ["SPX", "ES1"],
      ["QQQ", "NQ1"],
    ];
    for (const [rawKey, targetSym] of map) {
      if (out[targetSym]) continue;
      const rows = profiles[rawKey];
      if (!rows) continue;
      const sum = summarizeProfile(targetSym, rows);
      if (sum) out[targetSym] = sum;
    }

    cachedMtime = st.mtimeMs;
    cachedGex = out;
    return out;
  } catch {
    return cachedGex;
  }
}
