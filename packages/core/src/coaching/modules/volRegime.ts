import type { CoachModule, ModuleSignal } from "./types";

export const volRegimeModule: CoachModule = {
  id: "vol-regime",
  name: "VIX Term Structure",
  description: "Checks VIX9D / VIX ratio for contango (pin/fade) vs backwardation (expansion).",
  defaultEnabled: true,
  evaluate(ctx): ModuleSignal[] {
    const vix = ctx.quotes["VIX"]?.last;
    const vix9d = ctx.quotes["VIX9D"]?.last;
    if (!vix || !vix9d || vix <= 0) return [];

    const ratio = vix9d / vix;
    if (ratio >= 1.02) {
      return [
        {
          moduleId: "vol-regime",
          code: "VOL_BACKWARDATION",
          label: `VIX BACKWARDATION (${ratio.toFixed(2)}x) — EXPANSION`,
          detail: `VIX9D (${vix9d.toFixed(2)}) > VIX (${vix.toFixed(2)}). Expect wider swings; hold runners.`,
          tone: "warn",
        },
      ];
    }

    if (ratio <= 0.94) {
      return [
        {
          moduleId: "vol-regime",
          code: "VOL_CONTANGO",
          label: `VIX CONTANGO (${ratio.toFixed(2)}x) — MEAN REVERT`,
          detail: `VIX9D (${vix9d.toFixed(2)}) < VIX (${vix.toFixed(2)}). Favor fading extremes.`,
          tone: "info",
        },
      ];
    }

    return [];
  },
};
