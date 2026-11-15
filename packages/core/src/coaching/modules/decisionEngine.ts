import type { CrossInstrumentRoute, InstrumentCoachState } from "../scanner";
import type { ModuleSignal, PermissionState } from "./types";

export type TradeAction =
  | "ENTER_LONG"
  | "ENTER_SHORT"
  | "HOLD_RUNNER"
  | "STAND_DOWN"
  | "WATCH";

export interface DecisionVote {
  source: string;
  label: string;
  weight: number;
}

export interface TradeDecision {
  action: TradeAction;
  symbol: string | null;
  score: number; // 0..100
  armed: boolean;
  vetoes: string[];
  votes: DecisionVote[];
  summary: string;
}

export function evaluateTradeDecision(input: {
  instruments: InstrumentCoachState[];
  routing: CrossInstrumentRoute;
  permission: PermissionState;
  signals: ModuleSignal[];
}): TradeDecision {
  const { instruments, routing, permission, signals } = input;
  const best =
    (routing.bestInstrument
      ? instruments.find((i) => i.symbol === routing.bestInstrument)
      : undefined) ?? instruments[0];

  const vetoes: string[] = [];
  const votes: DecisionVote[] = [];

  if (!best) {
    return {
      action: "WATCH",
      symbol: null,
      score: 0,
      armed: false,
      vetoes: ["No active session bars"],
      votes,
      summary: "Waiting for session bars",
    };
  }

  // Hard vetoes
  const allWide =
    instruments.length > 0 && instruments.every((i) => i.fvg10am.stopFit10bps === false);
  if (allWide) vetoes.push("ALL >10 bps WIDE");
  if (best.chopTimer.active && best.chopTimer.phase === "HIGH_CHOP_0_25M") {
    vetoes.push(`HIGH CHOP (${best.chopTimer.minsSinceAmExtreme ?? 0}m/25m)`);
  }
  if (best.q3Astra.lunchGated) vetoes.push("LUNCH GATE");
  if (permission === "STAND_DOWN") vetoes.push("MODULE STAND_DOWN");

  // Directional inference from setup + modules
  let bullPts = 0;
  let bearPts = 0;

  if (best.q3Astra.ifvgConfirmed === "BULL") {
    bullPts += 40;
    votes.push({ source: "q3-ifvg", label: `${best.symbol} IFVG BULL`, weight: 40 });
  } else if (best.q3Astra.ifvgConfirmed === "BEAR") {
    bearPts += 40;
    votes.push({ source: "q3-ifvg", label: `${best.symbol} IFVG BEAR`, weight: 40 });
  }

  if (best.fvg10am.status === "HELD" && best.fvg10am.stopFit10bps === true) {
    if (best.fvg10am.direction === "BULL") {
      bullPts += 35;
      votes.push({ source: "10am-fvg", label: `${best.symbol} FVG HELD BULL`, weight: 35 });
    } else if (best.fvg10am.direction === "BEAR") {
      bearPts += 35;
      votes.push({ source: "10am-fvg", label: `${best.symbol} FVG HELD BEAR`, weight: 35 });
    }
  }

  if (best.orb30.orb25ExtReject === "BULL_REJ") {
    bullPts += 30;
    votes.push({ source: "orb30", label: `${best.symbol} ORB 0.25 BULL`, weight: 30 });
  } else if (best.orb30.orb25ExtReject === "BEAR_REJ") {
    bearPts += 30;
    votes.push({ source: "orb30", label: `${best.symbol} ORB 0.25 BEAR`, weight: 30 });
  }

  if (best.fvg10am.stopFit10bps === true) {
    bullPts += 15;
    bearPts += 15;
    votes.push({ source: "stop-fit", label: `<=10 bps FIT`, weight: 15 });
  }

  for (const s of signals) {
    if (s.permissionHint === "LONG_ONLY") {
      bullPts += 20;
      votes.push({ source: s.moduleId, label: s.code, weight: 20 });
    } else if (s.permissionHint === "SHORT_ONLY") {
      bearPts += 20;
      votes.push({ source: s.moduleId, label: s.code, weight: 20 });
    } else if (s.code === "SMT_BEAR_PDH" || s.code === "PDH_SWEPT_REJECT" || s.code === "CVD_BEAR_DIV") {
      bearPts += 15;
      vetoes.push(`LONG CAUTION (${s.code})`);
      votes.push({ source: s.moduleId, label: s.code, weight: 15 });
    } else if (s.code === "SMT_BULL_PDL" || s.code === "PDL_SWEPT_RECLAIM" || s.code === "CVD_BULL_DIV") {
      bullPts += 15;
      vetoes.push(`SHORT CAUTION (${s.code})`);
      votes.push({ source: s.moduleId, label: s.code, weight: 15 });
    }
  }

  const netBull = bullPts >= bearPts;
  const rawScore = Math.min(100, netBull ? bullPts : bearPts);

  if (vetoes.some((v) => !v.includes("CAUTION"))) {
    return {
      action: "STAND_DOWN",
      symbol: best.symbol,
      score: Math.max(0, rawScore - 40),
      armed: false,
      vetoes,
      votes,
      summary: `STAND DOWN (${vetoes[0]})`,
    };
  }

  if (permission === "LONG_ONLY" && !netBull && bearPts > 0) {
    vetoes.push("BLOCKED BY LONG_ONLY PERMISSION");
  } else if (permission === "SHORT_ONLY" && netBull && bullPts > 0) {
    vetoes.push("BLOCKED BY SHORT_ONLY PERMISSION");
  }

  const armed = rawScore >= 70 && vetoes.length === 0;
  let action: TradeAction = "WATCH";
  if (armed) {
    action = netBull ? "ENTER_LONG" : "ENTER_SHORT";
  } else if (best.orb30.orb25ExtReject !== "NONE" && best.noonGate === "NO_NOON_FADE") {
    action = "HOLD_RUNNER";
  }

  return {
    action,
    symbol: best.symbol,
    score: rawScore,
    armed,
    vetoes,
    votes,
    summary: armed
      ? `ARMED ${action} ${best.symbol} (${rawScore}/100)`
      : `${action} ${best.symbol} (${rawScore}/100)`,
  };
}
