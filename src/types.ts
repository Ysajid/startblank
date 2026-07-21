export type ThemeName = "light" | "dark" | "sepia";
export type FontName = "serif" | "sans" | "mono";

export interface WritingStats {
  keystrokes: number;
  edits: number;
  pasteEvents: number;
  pastedChars: number;
}

export interface ScoreBreakdown {
  organicRatio: number;
  keptRatio: number;
  revisionCredit: number;
  score: number;
}

export interface PublishedDocument {
  content: string;
  theme: ThemeName;
  font: FontName;
  stats: WritingStats;
  finalLength: number;
  score: number;
  publishedAt: number;
}
