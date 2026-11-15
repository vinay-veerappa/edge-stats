import type { CoachModule, ModuleSignal } from "./types";

const WALL_PROXIMITY_BPS = 15;

export const gammaRegimeModule: CoachModule = {
  id: "gamma-regime",
  name: "Gamma / GEX Regime",
  description: "Reads zero-gamma flip & call/put walls: Positive GEX (fade) vs Negative GEX (trend).",
  defaultEnabled: true,
  evaluate(ctx): ModuleSignal[] {
    if (!ctx.gex) return [];
    const out: ModuleSignal[] = [];

    for (const inst of ctx.instruments) {
      const g = ctx.gex[inst.symbol];
      if (!g) continue;
      const last = ctx.quotes[inst.symbol]?.last ?? inst.lastPrice;
      if (!last || last <= 0) continue;

      if (g.gammaFlip !== null) {
        if (last > g.gammaFlip) {
          out.push({
            moduleId: "gamma-regime",
            code: "POS_GAMMA",
            label: `${inst.symbol} +GEX (> ${g.gammaFlip}) — FADE / PIN`,
            detail: `Spot (${last.toFixed(2)}) above Gamma Flip (${g.gammaFlip}). Dealers dampen moves.`,
            tone: "info",
            symbol: inst.symbol,
          });
        } else {
          out.push({
            moduleId: "gamma-regime",
            code: "NEG_GAMMA",
            label: `${inst.symbol} -GEX (< ${g.gammaFlip}) — EXPANSION`,
            detail: `Spot (${last.toFixed(2)}) below Gamma Flip (${g.gammaFlip}). Dealers amplify moves; hold runners.`,
            tone: "warn",
            symbol: inst.symbol,
          });
        }
      } else {
        const pos = g.netGexTotal >= 0;
        out.push({
          moduleId: "gamma-regime",
          code: pos ? "POS_GAMMA" : "NEG_GAMMA",
          label: `${inst.symbol} ${pos ? "+GEX — FADE / PIN" : "-GEX — EXPANSION"}`,
          detail: `Net GEX (${g.netGexTotal.toFixed(0)}) across strikes; ${pos ? "dealers dampen moves" : "dealers amplify moves"}.`,
          tone: pos ? "info" : "warn",
          symbol: inst.symbol,
        });
      }

      if (g.callWall && Math.abs((last - g.callWall) / last) * 10000 <= WALL_PROXIMITY_BPS) {
        out.push({
          moduleId: "gamma-regime",
          code: "AT_CALL_WALL",
          label: `${inst.symbol} AT CALL WALL (${g.callWall})`,
          detail: `Within ${WALL_PROXIMITY_BPS} bps of Call Wall — watch for pin or rejection.`,
          tone: "warn",
          symbol: inst.symbol,
        });
      }
      if (g.putWall && Math.abs((last - g.putWall) / last) * 10000 <= WALL_PROXIMITY_BPS) {
        out.push({
          moduleId: "gamma-regime",
          code: "AT_PUT_WALL",
          label: `${inst.symbol} AT PUT WALL (${g.putWall})`,
          detail: `Within ${WALL_PROXIMITY_BPS} bps of Put Wall — watch for bounce or breakdown.`,
          tone: "warn",
          symbol: inst.symbol,
        });
      }
    }

    return out;
  },
};
