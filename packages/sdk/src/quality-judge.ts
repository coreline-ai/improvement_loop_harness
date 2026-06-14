/**
 * B1 — advisory tie-break quality judge.
 *
 * When the deterministic Arbiter leaves a set of candidates score-indistinguishable
 * (same evidence / changed_files / changed_lines), the choice between them is
 * otherwise arbitrary (lexicographic id). An OPTIONAL quality judge may express a
 * preference among those tied candidates. It is strictly ADVISORY:
 *
 *   - it only ever sees ALREADY-ACCEPTED, score-equal candidates;
 *   - it can only pick ONE of them — it cannot promote a rejected candidate,
 *     change a decision, or override correctness;
 *   - its pick is still gated by the B2/B3 final verification before PR candidacy.
 *
 * The judge runs in a SEPARATE PROCESS (a fresh context, e.g. a second LLM/CLI
 * invocation) so it is not the same context that produced the candidates — this
 * is the "open it in a different context to evaluate" property. `commandQualityJudge`
 * spawns a command, hands it the tied candidates as JSON on stdin, and reads a
 * JSON verdict from stdout.
 */
import { spawn } from 'node:child_process';

export interface QualityJudgeCandidate {
  candidate_id: string;
  artifact_root: string;
  /** Absolute path to the candidate's patch (the judge reads it for context). */
  patch_ref: string;
  report_path?: string | undefined;
  score?:
    | {
        total: number;
        changed_files: number;
        changed_lines: number;
        quality_metric_score?: number | undefined;
      }
    | undefined;
}

export interface QualityJudgeInput {
  /** The score-indistinguishable accepted candidates to rank (length >= 2). */
  tied: QualityJudgeCandidate[];
}

export interface QualityJudgeResult {
  /** Must be one of the tied candidate ids; anything else is ignored by the loop. */
  winner_candidate_id: string;
  rationale?: string | undefined;
}

export type QualityJudge = (
  input: QualityJudgeInput
) => Promise<QualityJudgeResult>;

export interface CommandQualityJudgeOptions {
  timeoutMs?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

/**
 * Build a {@link QualityJudge} backed by a shell command run in its own process.
 * The command receives `QualityJudgeInput` as JSON on stdin and must print a
 * `QualityJudgeResult` JSON object to stdout. A non-zero exit, missing JSON, or
 * parse error rejects — the loop treats a rejected judge as "no advice" and keeps
 * the deterministic pick (the advisory never blocks a run).
 */
export function commandQualityJudge(
  command: string,
  options: CommandQualityJudgeOptions = {}
): QualityJudge {
  return (input) =>
    new Promise<QualityJudgeResult>((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(options.env ? { env: options.env } : {})
      });
      let stdout = '';
      let stderr = '';
      let timer: NodeJS.Timeout | undefined;
      if (options.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
        timer.unref();
      }
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (stdout += chunk));
      child.stderr.on('data', (chunk: string) => (stderr += chunk));
      child.on('error', (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (code !== 0) {
          reject(
            new Error(
              `quality judge exited ${code ?? 'signal'}: ${stderr.slice(0, 300)}`
            )
          );
          return;
        }
        const start = stdout.indexOf('{');
        if (start < 0) {
          reject(new Error('quality judge produced no JSON verdict'));
          return;
        }
        try {
          resolve(JSON.parse(stdout.slice(start)) as QualityJudgeResult);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    });
}
