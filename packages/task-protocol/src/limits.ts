import type { Limits } from './types.js';

function stricterNumber(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.min(left, right);
}

export function mergeLimits(taskLimits: Limits | undefined, evalLimits: Limits | undefined): Limits {
  const merged: Limits = {};
  const maxChangedFiles = stricterNumber(taskLimits?.max_changed_files, evalLimits?.max_changed_files);
  const maxChangedLines = stricterNumber(taskLimits?.max_changed_lines, evalLimits?.max_changed_lines);
  const agentTimeoutSeconds = stricterNumber(taskLimits?.agent_timeout_seconds, evalLimits?.agent_timeout_seconds);

  if (maxChangedFiles !== undefined) {
    merged.max_changed_files = maxChangedFiles;
  }
  if (maxChangedLines !== undefined) {
    merged.max_changed_lines = maxChangedLines;
  }
  if (agentTimeoutSeconds !== undefined) {
    merged.agent_timeout_seconds = agentTimeoutSeconds;
  }

  return merged;
}
