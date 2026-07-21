import type { ThemeName } from "../types";

const THEMES: { value: ThemeName; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "sepia", label: "Sepia" },
];

export function ThemeSwitch({
  value,
  onChange,
}: {
  value: ThemeName;
  onChange: (theme: ThemeName) => void;
}) {
  return (
    <div className="flex items-center gap-3" role="group" aria-label="Theme">
      {THEMES.map((theme) => (
        <button
          key={theme.value}
          type="button"
          onClick={() => onChange(theme.value)}
          aria-pressed={value === theme.value}
          className={`font-write-mono text-[11px] uppercase tracking-wide pb-0.5 border-b transition-colors ${
            value === theme.value
              ? "border-[var(--accent)] text-[var(--accent)]"
              : "border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)]"
          }`}
        >
          {theme.label}
        </button>
      ))}
    </div>
  );
}
