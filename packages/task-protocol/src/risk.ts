import { pathMatchesPrefix } from './paths.js';

export interface RiskClassificationResult {
  areas: string[];
  unknown: boolean;
}

export function classifyRisk(paths: string[], riskClassification: Record<string, string[]> | undefined): RiskClassificationResult {
  const areas = new Set<string>();
  let unknown = false;

  if (paths.length === 0) {
    return { areas: [], unknown: false };
  }

  for (const changedPath of paths) {
    let matched = false;
    for (const [area, prefixes] of Object.entries(riskClassification ?? {})) {
      if (prefixes.some((prefix) => pathMatchesPrefix(changedPath, prefix))) {
        areas.add(area);
        matched = true;
      }
    }
    if (!matched) {
      unknown = true;
    }
  }

  return { areas: [...areas].sort(), unknown };
}
