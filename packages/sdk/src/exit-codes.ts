import type { Decision } from '@vibeloop/shared';
import type { TerminalRunStatus } from '@vibeloop/artifacts';

export const EXIT_CODES = {
  accept: 0,
  reject: 10,
  needs_human_review: 11,
  needs_more_tests: 12,
  cancelled: 20,
  failed: 2
} as const;

export type CliExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export function exitCodeForDecision(decision: Decision): CliExitCode {
  switch (decision) {
    case 'accept':
      return EXIT_CODES.accept;
    case 'reject':
      return EXIT_CODES.reject;
    case 'needs_human_review':
      return EXIT_CODES.needs_human_review;
    case 'needs_more_tests':
      return EXIT_CODES.needs_more_tests;
  }
}

export function exitCodeForStatus(status: TerminalRunStatus): CliExitCode {
  switch (status) {
    case 'accepted':
    case 'approved':
    case 'pr_created':
    case 'completed':
      return EXIT_CODES.accept;
    case 'rejected':
      return EXIT_CODES.reject;
    case 'needs_human_review':
      return EXIT_CODES.needs_human_review;
    case 'needs_more_tests':
      return EXIT_CODES.needs_more_tests;
    case 'cancelled':
      return EXIT_CODES.cancelled;
    case 'failed':
      return EXIT_CODES.failed;
  }
}
