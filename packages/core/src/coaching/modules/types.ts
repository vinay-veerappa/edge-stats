import type { InstrumentCoachState } from "../scanner";
import type { GexLevelSummary } from "./gexFeed";

export type PermissionState = "LONG_ONLY" | "SHORT_ONLY" | "BALANCED" | "STAND_DOWN";

export type SignalTone = "good" | "warn" | "danger" | "info";

export interface ModuleSignal {
  moduleId: string;
  code: string;
  label: string;
  detail: string;
  tone: SignalTone;
  permissionHint?: PermissionState;
  symbol?: string;
}

export interface FastQuote {
  symbol: string;
  last: number;
  open?: number;
  high?: number;
  low?: number;
  prevClose?: number;
  netPct?: number;
  volume?: number;
  bidSize?: number;
  askSize?: number;
  tsMs: number;
}

export interface OrderflowState {
  symbol: string;
  cvd: number;
  cvdDelta5m?: number;
  tsMs: number;
}

export interface BasketAssetRow {
  symbol: string;
  last: number;
  dayPct: number;
  vwapPct?: number;
  rvol?: number;
  score: number;
}

export interface ReferenceLevels {
  pdh?: number;
  pdl?: number;
  onh?: number;
  onl?: number;
  sessionHigh?: number;
  sessionLow?: number;
}

export interface CoachModuleContext {
  tradeDate: string;
  asOfEt: string;
  instruments: InstrumentCoachState[];
  levelsBySymbol: Record<string, ReferenceLevels>;
  quotes: Record<string, FastQuote>;
  orderflow: Record<string, OrderflowState>;
  basket: BasketAssetRow[];
  gex?: Record<string, GexLevelSummary>;
}

export interface CoachModule {
  id: string;
  name: string;
  description: string;
  defaultEnabled: boolean;
  evaluate(ctx: CoachModuleContext): ModuleSignal[];
}
