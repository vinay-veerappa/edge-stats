import type { CoachModule, ModuleSignal } from "./types";

export const smtDivergenceModule: CoachModule = {
  id: "smt-divergence",
  name: "ES/NQ/YM SMT Divergence",
  description: "Flags cross-index divergence when one index sweeps PDH/PDL and peers fail to confirm.",
  defaultEnabled: true,
  evaluate(ctx): ModuleSignal[] {
    const out: ModuleSignal[] = [];
    const sweptHigh: string[] = [];
    const missedHigh: string[] = [];
    const sweptLow: string[] = [];
    const missedLow: string[] = [];

    for (const inst of ctx.instruments) {
      const lvl = ctx.levelsBySymbol[inst.symbol];
      if (!lvl) continue;
      const last = ctx.quotes[inst.symbol]?.last ?? inst.lastPrice;
      const hi = Math.max(lvl.sessionHigh ?? last, last);
      const lo = Math.min(lvl.sessionLow ?? last, last);

      if (lvl.pdh) {
        if (hi > lvl.pdh) sweptHigh.push(inst.symbol);
        else missedHigh.push(inst.symbol);
      }
      if (lvl.pdl) {
        if (lo < lvl.pdl) sweptLow.push(inst.symbol);
        else missedLow.push(inst.symbol);
      }
    }

    if (sweptHigh.length > 0 && missedHigh.length > 0) {
      out.push({
        moduleId: "smt-divergence",
        code: "SMT_BEAR_PDH",
        label: `SMT BEAR (${sweptHigh.join("/")} > PDH, ${missedHigh.join("/")} lagging)`,
        detail: "Non-confirmation at prior day high — watch for short reversal if rejected.",
        tone: "warn",
      });
    }

    if (sweptLow.length > 0 && missedLow.length > 0) {
      out.push({
        moduleId: "smt-divergence",
        code: "SMT_BULL_PDL",
        label: `SMT BULL (${sweptLow.join("/")} < PDL, ${missedLow.join("/")} holding)`,
        detail: "Non-confirmation at prior day low — watch for long reversal if reclaimed.",
        tone: "warn",
      });
    }

    return out;
  },
};
