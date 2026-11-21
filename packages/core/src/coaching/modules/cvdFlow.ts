import type { CoachModule, ModuleSignal } from "./types";

export const cvdFlowModule: CoachModule = {
  id: "cvd-flow",
  name: "Futures CVD Flow",
  description: "Tracks ES/NQ CVD and 5m delta for live buying/selling pressure or divergence.",
  defaultEnabled: true,
  evaluate(ctx): ModuleSignal[] {
    const out: ModuleSignal[] = [];
    const summaryParts: string[] = [];
    let anyDiv = false;

    for (const sym of ["ES1", "NQ1"] as const) {
      const flow = ctx.orderflow[sym];
      if (!flow) continue;

      const inst = ctx.instruments.find((i) => i.symbol === sym);
      const quote = ctx.quotes[sym];
      const netPct = quote?.netPct ?? (inst?.org.gapBps != null ? inst.org.gapBps / 100 : 0);
      const delta5m = flow.cvdDelta5m ?? 0;
      const sign = delta5m >= 0 ? "+" : "";
      const shortSym = sym.replace("1", "");
      summaryParts.push(`${shortSym} ${flow.cvd} (${sign}${delta5m})`);

      if (netPct > 0.25 && delta5m < -500) {
        anyDiv = true;
        out.push({
          moduleId: "cvd-flow",
          code: "CVD_BEAR_DIV",
          label: `${sym} CVD BEAR DIV (Price +${netPct.toFixed(2)}%, CVD ${delta5m})`,
          detail: "Price rising on negative 5m CVD delta — watch for absorption/reversal.",
          tone: "warn",
          symbol: sym,
        });
      } else if (netPct < -0.25 && delta5m > 500) {
        anyDiv = true;
        out.push({
          moduleId: "cvd-flow",
          code: "CVD_BULL_DIV",
          label: `${sym} CVD BULL DIV (Price ${netPct.toFixed(2)}%, CVD +${delta5m})`,
          detail: "Price dropping on positive 5m CVD delta — watch for absorption/reclaim.",
          tone: "warn",
          symbol: sym,
        });
      }
    }

    if (!anyDiv && summaryParts.length > 0) {
      const esCvd = ctx.orderflow["ES1"]?.cvd ?? 0;
      const nqCvd = ctx.orderflow["NQ1"]?.cvd ?? 0;
      const net = esCvd + nqCvd;
      out.push({
        moduleId: "cvd-flow",
        code: summaryParts.join(" | "),
        label: `CVD: ${summaryParts.join(" · ")}`,
        detail: "Live cumulative volume delta and 5m change from orderflow stream.",
        tone: net >= 50 ? "good" : net <= -50 ? "danger" : "info",
      });
    }

    return out;
  },
};
