import type { FontName, ThemeName, WritingStats } from "../types";

const DRAFT_KEY = "startblank.draft";
const PREFS_KEY = "startblank.prefs";

export interface Draft {
  content: string;
  stats: WritingStats;
}

export interface Prefs {
  theme: ThemeName;
  font: FontName;
}

export function loadDraft(): Draft | null {
  const raw = localStorage.getItem(DRAFT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Draft;
  } catch {
    return null;
  }
}

export function saveDraft(draft: Draft): void {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

export function clearDraft(): void {
  localStorage.removeItem(DRAFT_KEY);
}

export function loadPrefs(): Prefs {
  const raw = localStorage.getItem(PREFS_KEY);
  if (!raw) return { theme: "light", font: "serif" };
  try {
    const parsed = JSON.parse(raw);
    return {
      theme: parsed.theme ?? "light",
      font: parsed.font ?? "serif",
    };
  } catch {
    return { theme: "light", font: "serif" };
  }
}

export function savePrefs(prefs: Prefs): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}
