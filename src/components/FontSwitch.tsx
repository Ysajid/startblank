import type { FontName } from "../types";

const FONTS: { value: FontName; label: string; className: string }[] = [
  { value: "typewriter", label: "Typewriter", className: "font-write-typewriter" },
  { value: "serif", label: "Serif", className: "font-write-serif" },
  { value: "sans", label: "Sans", className: "font-write-sans" },
  { value: "mono", label: "Mono", className: "font-write-mono" },
];

export function FontSwitch({
  value,
  onChange,
}: {
  value: FontName;
  onChange: (font: FontName) => void;
}) {
  return (
    <div className="flex items-center gap-3" role="group" aria-label="Font">
      {FONTS.map((font) => (
        <button
          key={font.value}
          type="button"
          onClick={() => onChange(font.value)}
          aria-pressed={value === font.value}
          className={`${font.className} text-[13px] pb-0.5 border-b transition-colors ${
            value === font.value
              ? "border-[var(--accent)] text-[var(--accent)]"
              : "border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)]"
          }`}
        >
          {font.label}
        </button>
      ))}
    </div>
  );
}
