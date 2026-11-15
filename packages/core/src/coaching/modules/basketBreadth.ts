import type { CoachModule, ModuleSignal } from "./types";

export const basketBreadthModule: CoachModule = {
  id: "basket-breadth",
  name: "Mag-7 Basket Breadth",
  description: "Pulserank-style Mag-7 directional breadth -> LONG ONLY / SHORT ONLY / BALANCED.",
  defaultEnabled: true,
  evaluate(ctx): ModuleSignal[] {
    if (ctx.basket.length < 3) return [];

    const total = ctx.basket.length;
    const green = ctx.basket.filter((b) => b.dayPct > 0.15).length;
    const red = ctx.basket.filter((b) => b.dayPct < -0.15).length;
    const avgPct = ctx.basket.reduce((acc, b) => acc + b.dayPct, 0) / total;

    if (green >= Math.ceil(total * 0.7) && avgPct > 0.25) {
      return [
        {
          moduleId: "basket-breadth",
          code: "BASKET_LONG_ONLY",
          label: `BASKET LONG ONLY (${green}/${total} UP · avg ${avgPct.toFixed(2)}%)`,
          detail: "Broad Mag-7 strength. Do not counter-trend short NQ/ES.",
          tone: "good",
          permissionHint: "LONG_ONLY",
        },
      ];
    }

    if (red >= Math.ceil(total * 0.7) && avgPct < -0.25) {
      return [
        {
          moduleId: "basket-breadth",
          code: "BASKET_SHORT_ONLY",
          label: `BASKET SHORT ONLY (${red}/${total} DOWN · avg ${avgPct.toFixed(2)}%)`,
          detail: "Broad Mag-7 selling. Do not catch falling knives.",
          tone: "danger",
          permissionHint: "SHORT_ONLY",
        },
      ];
    }

    return [
      {
        moduleId: "basket-breadth",
        code: "BASKET_BALANCED",
        label: `BASKET MIXED (${green}↑ / ${red}↓ of ${total})`,
        detail: "No clear Mag-7 consensus — trade key levels / rotations.",
        tone: "info",
        permissionHint: "BALANCED",
      },
    ];
  },
};
