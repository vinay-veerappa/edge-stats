import type { CoachModule, ModuleSignal } from "./types";

export const cvdFlowModule: CoachModule = {
  id: "cvd-flow",
  name: "Futures CVD Flow",
  description: "Tracks ES/NQ CVD 5m delta for trend confirmation or exhaustion divergence.",
  defaultEnabled: true,
  evaluate(ctx): ModuleSignal[] {
    const out: ModuleSignal[] = [];

    for (const sym of ["ES1", "NQ1"] as const) {
      const flow = ctx.orderflow[sym];
      const quote = ctx.quotes[sym];
      if (!flow || flow.cvdDelta5m === undefined) continue;

      const netPct = quote?.netPct ?? 0;
      if (netPct > 0.25 && flow.cvdDelta5m < -500) {
        out.push({
          moduleId: "cvd-flow",
          code: "CVD_BEAR_DIV",
          label: `${sym} CVD BEAR DIV (Price +${netPct.toFixed(2)}%, CVD ${flow.cvdDelta5m})`,
          detail: "Price rising on negative 5m CVD delta — watch for absorption/reversal.",
          tone: "warn",
          symbol: sym,
        });
      } else if (netPct < -0.25 && flow.cvdDelta5m > 500) {
        out.push({
          moduleId: "cvd-flow",
          code: "CVD_BULL_DIV",
          label: `${sym} CVD BULL DIV (Price ${netPct.toFixed(2)}%, CVD +${flow.cvdDelta5m})`,
          detail: "Price dropping on positive 5m CVD delta — watch for absorption/reclaim.",
          tone: "warn",
          symbol: sym,
        });
      }
    }

    return out;
  },
};
