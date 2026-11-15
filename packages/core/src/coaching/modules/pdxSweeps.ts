import type { CoachModule, ModuleSignal } from "./types";

const SWEEP_BUFFER_PCT = 0.0005; // 5 bps hold/reject buffer

export const pdxSweepsModule: CoachModule = {
  id: "pdx-sweeps",
  name: "PDx & Overnight Sweeps",
  description: "Detects PDH/PDL/ONH/ONL sweeps with rejection (reversal) vs acceptance (trend).",
  defaultEnabled: true,
  evaluate(ctx): ModuleSignal[] {
    const out: ModuleSignal[] = [];

    for (const inst of ctx.instruments) {
      const lvl = ctx.levelsBySymbol[inst.symbol];
      if (!lvl) continue;

      const last = ctx.quotes[inst.symbol]?.last ?? inst.lastPrice;
      const sessHigh = Math.max(lvl.sessionHigh ?? last, last);
      const sessLow = Math.min(lvl.sessionLow ?? last, last);

      if (lvl.pdh && sessHigh > lvl.pdh) {
        if (last < lvl.pdh) {
          out.push({
            moduleId: "pdx-sweeps",
            code: "PDH_SWEPT_REJECT",
            label: `${inst.symbol} PDH SWEPT — WATCH REVERSAL`,
            detail: `Swept PDH (${lvl.pdh.toFixed(2)}) and rejected back below (${last.toFixed(2)}).`,
            tone: "warn",
            symbol: inst.symbol,
          });
        } else if (last > lvl.pdh * (1 + SWEEP_BUFFER_PCT)) {
          out.push({
            moduleId: "pdx-sweeps",
            code: "PDH_ACCEPTED",
            label: `${inst.symbol} ABOVE PDH — LONG ONLY`,
            detail: `Holding above PDH (${lvl.pdh.toFixed(2)}). Favor trend continuation.`,
            tone: "good",
            permissionHint: "LONG_ONLY",
            symbol: inst.symbol,
          });
        }
      }

      if (lvl.pdl && sessLow < lvl.pdl) {
        if (last > lvl.pdl) {
          out.push({
            moduleId: "pdx-sweeps",
            code: "PDL_SWEPT_RECLAIM",
            label: `${inst.symbol} PDL SWEPT — WATCH REVERSAL`,
            detail: `Swept PDL (${lvl.pdl.toFixed(2)}) and reclaimed above (${last.toFixed(2)}).`,
            tone: "warn",
            symbol: inst.symbol,
          });
        } else if (last < lvl.pdl * (1 - SWEEP_BUFFER_PCT)) {
          out.push({
            moduleId: "pdx-sweeps",
            code: "PDL_ACCEPTED",
            label: `${inst.symbol} BELOW PDL — SHORT ONLY`,
            detail: `Accepting below PDL (${lvl.pdl.toFixed(2)}). Favor short continuation.`,
            tone: "danger",
            permissionHint: "SHORT_ONLY",
            symbol: inst.symbol,
          });
        }
      }
    }

    return out;
  },
};
