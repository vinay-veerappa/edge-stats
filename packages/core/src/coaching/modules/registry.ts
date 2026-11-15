import { basketBreadthModule } from "./basketBreadth";
import { cashEtfLeadModule } from "./cashEtfLead";
import { cvdFlowModule } from "./cvdFlow";
import { gammaRegimeModule } from "./gammaRegime";
import { pdxSweepsModule } from "./pdxSweeps";
import { smtDivergenceModule } from "./smtDivergence";
import type { CoachModule, CoachModuleContext, ModuleSignal, PermissionState } from "./types";
import { volRegimeModule } from "./volRegime";

const REGISTERED_MODULES: CoachModule[] = [
  pdxSweepsModule,
  smtDivergenceModule,
  basketBreadthModule,
  cashEtfLeadModule,
  volRegimeModule,
  cvdFlowModule,
  gammaRegimeModule,
];

const disabledSet = new Set<string>(
  (process.env.COACH_DISABLED_MODULES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

for (const mod of REGISTERED_MODULES) {
  if (!mod.defaultEnabled && !disabledSet.has(mod.id)) {
    disabledSet.add(mod.id);
  }
}

export interface ModuleStatus {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export function listCoachModules(): ModuleStatus[] {
  return REGISTERED_MODULES.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    enabled: !disabledSet.has(m.id),
  }));
}

export function setCoachModuleEnabled(id: string, enabled: boolean): ModuleStatus[] {
  if (enabled) disabledSet.delete(id);
  else disabledSet.add(id);
  return listCoachModules();
}

export function evaluateCoachModules(
  ctx: CoachModuleContext,
  extraDisabledIds: string[] = [],
): {
  permission: PermissionState;
  signals: ModuleSignal[];
  modules: ModuleStatus[];
} {
  const skip = new Set<string>([...disabledSet, ...extraDisabledIds]);
  const signals: ModuleSignal[] = [];

  for (const mod of REGISTERED_MODULES) {
    if (skip.has(mod.id)) continue;
    try {
      const res = mod.evaluate(ctx);
      if (Array.isArray(res)) signals.push(...res);
    } catch {
      // Isolate individual module failures so the coach never crashes
    }
  }

  let longVotes = 0;
  let shortVotes = 0;
  let standDown = false;
  for (const s of signals) {
    if (s.permissionHint === "STAND_DOWN") standDown = true;
    else if (s.permissionHint === "LONG_ONLY") longVotes += 1;
    else if (s.permissionHint === "SHORT_ONLY") shortVotes += 1;
  }

  let permission: PermissionState = "BALANCED";
  if (standDown) permission = "STAND_DOWN";
  else if (longVotes > 0 && shortVotes === 0) permission = "LONG_ONLY";
  else if (shortVotes > 0 && longVotes === 0) permission = "SHORT_ONLY";

  return {
    permission,
    signals,
    modules: REGISTERED_MODULES.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      enabled: !skip.has(m.id),
    })),
  };
}
