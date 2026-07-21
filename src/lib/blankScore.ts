import type { ScoreBreakdown, WritingStats } from "../types";

// See PROJECT_PLAN.md §5 for the derivation of this formula.
const REVISION_BASELINE = 0.9;
const REVISION_HEADROOM = 0.1;

export function computeBlankScore(stats: WritingStats, finalLength: number): ScoreBreakdown {
  const { keystrokes, edits, pastedChars } = stats;

  const organicDenominator = Math.max(keystrokes + pastedChars, 1);
  const organicRatio = keystrokes / organicDenominator;

  const lengthSafe = Math.max(finalLength, 1);
  const pasteReliance = Math.min(pastedChars / lengthSafe, 1);
  const keptRatio = 1 - pasteReliance;

  const revisionDensity = edits / lengthSafe;
  const revisionCredit = Math.min(1, REVISION_BASELINE + REVISION_HEADROOM * revisionDensity);

  const raw = 100 * organicRatio * keptRatio * revisionCredit;
  const score = Math.max(0, Math.min(100, raw));

  return { organicRatio, keptRatio, revisionCredit, score };
}
