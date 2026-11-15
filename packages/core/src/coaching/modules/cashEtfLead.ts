import type { CoachModule, ModuleSignal } from "./types";

export const cashEtfLeadModule: CoachModule = {
  id: "cash-etf-lead",
  name: "SPY/SPX/QQQ Lead",
  description: "Tracks cash ETF/index leadership (SPY, SPX, QQQ) leading ES/NQ/YM.",
  defaultEnabled: true,
  evaluate(ctx): ModuleSignal[] {
    const spy = ctx.quotes["SPY"]?.netPct;
    const spx = ctx.quotes["SPX"]?.netPct;
    const qqq = ctx.quotes["QQQ"]?.netPct;

    const eq = spy ?? spx;
    if (eq === undefined && qqq === undefined) return [];

    const out: ModuleSignal[] = [];
    if (eq !== undefined && qqq !== undefined) {
      if (eq > 0.35 && qqq > 0.35) {
        out.push({
          moduleId: "cash-etf-lead",
          code: "CASH_LEAD_BULL",
          label: `SPY/QQQ BULL LEAD (+${eq.toFixed(2)}% / +${qqq.toFixed(2)}%)`,
          detail: "Cash ETFs leading higher — favor ES/NQ longs on pullbacks.",
          tone: "good",
          permissionHint: "LONG_ONLY",
        });
      } else if (eq < -0.35 && qqq < -0.35) {
        out.push({
          moduleId: "cash-etf-lead",
          code: "CASH_LEAD_BEAR",
          label: `SPY/QQQ BEAR LEAD (${eq.toFixed(2)}% / ${qqq.toFixed(2)}%)`,
          detail: "Cash ETFs leading lower — favor ES/NQ shorts on pops.",
          tone: "danger",
          permissionHint: "SHORT_ONLY",
        });
      } else if (Math.abs(qqq - eq) >= 0.35) {
        const leader = qqq > eq ? "QQQ>SPY (Favor NQ)" : "SPY>QQQ (Favor ES/YM)";
        out.push({
          moduleId: "cash-etf-lead",
          code: "CASH_ROTATION",
          label: `ROTATION ${leader}`,
          detail: `QQQ ${qqq.toFixed(2)}% vs SPY ${eq.toFixed(2)}%.`,
          tone: "info",
        });
      }
    }

    return out;
  },
};
