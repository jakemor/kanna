import type { FeatureStage } from "../../shared/types"

export const FEATURE_STAGE_TINT_STYLES: Record<FeatureStage, string> = {
  idea: "border-amber-500/40 bg-amber-500/12 text-amber-200",
  todo: "border-sky-500/40 bg-sky-500/12 text-sky-200",
  progress: "border-indigo-500/40 bg-indigo-500/12 text-indigo-200",
  testing: "border-cyan-500/40 bg-cyan-500/12 text-cyan-200",
  done: "border-emerald-500/40 bg-emerald-500/12 text-emerald-200",
}
