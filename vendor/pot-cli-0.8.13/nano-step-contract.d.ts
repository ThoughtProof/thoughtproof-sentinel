export const MALFORMED_NANO_STEP_MARKER: string;
export const NANO_STRICT_OUTPUT_SUFFIX: string;
export class MalformedNanoStepError extends Error {
  reasons: string[];
  constructor(reasons: string[]);
}
export function isNanoModel(model: string): boolean;
export function faithfulnessPredicateFromScore(score: number): string;
export function normalizeNanoStep(step: unknown): {
  step: Record<string, unknown>;
  malformed: boolean;
  reason: string;
};
export function normalizeNanoStepArray(steps: unknown): {
  steps: Record<string, unknown>[];
  malformed: boolean;
  reasons: string[];
};
