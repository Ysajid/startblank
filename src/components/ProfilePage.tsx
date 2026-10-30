import { useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { FONT_CLASS } from "../fonts";
import { MAX_STYLES, readProfile, saveProfile, type Profile } from "../lib/profile";
import type { FontName, ThemeName } from "../types";
import { FontSwitch } from "./FontSwitch";
import { ThemeSwitch } from "./ThemeSwitch";

const inputClass =
  "w-full border border-[var(--rule)] bg-transparent px-3 py-2 text-[14px] text-[var(--fg)] focus:border-[var(--accent)] focus:outline-none";
const labelClass = "font-write-mono text-[11px] uppercase tracking-wide text-[var(--fg-muted)]";
const smallButton =
  "font-write-mono text-[11px] uppercase tracking-wide text-[var(--fg-muted)] hover:text-[var(--fg)] disabled:opacity-40";

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-[var(--rule)] py-8">
      <h2 className="font-write-typewriter text-xl text-[var(--fg)]">{title}</h2>
      {hint ? <p className="mt-2 text-[13px] leading-relaxed text-[var(--fg-muted)]">{hint}</p> : null}
      <div className="mt-6 flex flex-col gap-5">{children}</div>
    </section>
  );
}

function Toggle({ label, hint, value, onChange }: { label: string; hint: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div>
        <div className="text-[14px] text-[var(--fg)]">{label}</div>
        <div className="mt-1 text-[12px] leading-relaxed text-[var(--fg-muted)]">{hint}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={label}
        onClick={() => onChange(!value)}
        className={`shrink-0 font-write-mono text-[11px] uppercase tracking-wide pb-0.5 border-b ${
          value ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)]"
        }`}
      >
        {value ? "On" : "Off"}
      </button>
    </div>
  );
}

export function ProfilePage({
  session,
  guest,
  theme,
  onTheme,
  font,
  onFont,
  showPasted,
  onShowPasted,
  showToc,
  onShowToc,
  onClose,
}: {
  session: Session;
  guest: boolean;
  theme: ThemeName;
  onTheme: (theme: ThemeName) => void;
  font: FontName;
  onFont: (font: FontName) => void;
  showPasted: boolean;
  onShowPasted: (value: boolean) => void;
  showToc: boolean;
  onShowToc: (value: boolean) => void;
  onClose: () => void;
}) {
  const [saved, setSaved] = useState<Profile>(() => readProfile(session.user));
  const [draft, setDraft] = useState<Profile>(saved);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);

  function update(patch: Partial<Profile>) {
    setDraft((d) => ({ ...d, ...patch }));
    setMessage(null);
  }

  function updateStyle(index: number, patch: Partial<Profile["styles"][number]>) {
    update({ styles: draft.styles.map((s, i) => (i === index ? { ...s, ...patch } : s)) });
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      await saveProfile(draft);
      setSaved(draft);
      setMessage("Saved.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Couldn't save — check your connection.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-[640px] px-6 pb-24 pt-10">
        <div className="flex items-center justify-between gap-4">
          <button type="button" onClick={onClose} className={smallButton}>
            ← Notes
          </button>
          <span className="truncate font-write-mono text-[11px] text-[var(--fg-muted)]">
            {guest ? "Guest — no account" : session.user.email}
          </span>
        </div>

        <h1 className={`${FONT_CLASS[font]} mt-8 text-3xl text-[var(--fg)]`}>
          {draft.displayName.trim() || "Your profile"}
        </h1>
        {guest ? (
          <p className="mt-3 text-[13px] leading-relaxed text-[var(--fg-muted)]">
            You're writing without an account, so this profile is lost when you sign out.
          </p>
        ) : null}

        <Section title="About you">
          <div className="flex flex-col gap-2">
            <label htmlFor="display-name" className={labelClass}>
              Name
            </label>
            <input
              id="display-name"
              value={draft.displayName}
              maxLength={80}
              onChange={(e) => update({ displayName: e.target.value })}
              className={inputClass}
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="bio" className={labelClass}>
              Bio
            </label>
            <textarea
              id="bio"
              value={draft.bio}
              maxLength={2000}
              rows={5}
              placeholder="Who you are and what you write about."
              onChange={(e) => update({ bio: e.target.value })}
              className={`${inputClass} resize-y leading-relaxed`}
            />
          </div>
        </Section>

        <Section
          title="Writing styles"
          hint="How you sound for different kinds of pieces — an essay, a work update, a letter. A name and a few words on the voice."
        >
          {draft.styles.length === 0 ? (
            <p className="text-[13px] text-[var(--fg-muted)]">No styles yet.</p>
          ) : (
            draft.styles.map((style, i) => (
              <div key={i} className="flex flex-col gap-2 border border-[var(--rule)] p-4">
                <div className="flex items-center gap-3">
                  <input
                    value={style.name}
                    maxLength={60}
                    placeholder="Name, e.g. Essays"
                    aria-label={`Style ${i + 1} name`}
                    onChange={(e) => updateStyle(i, { name: e.target.value })}
                    className={`${inputClass} font-medium`}
                  />
                  <button
                    type="button"
                    className={smallButton}
                    onClick={() => update({ styles: draft.styles.filter((_, j) => j !== i) })}
                  >
                    Remove
                  </button>
                </div>
                <textarea
                  value={style.description}
                  maxLength={600}
                  rows={3}
                  placeholder="e.g. Plain and direct, short paragraphs, one idea each, no jargon."
                  aria-label={`Style ${i + 1} description`}
                  onChange={(e) => updateStyle(i, { description: e.target.value })}
                  className={`${inputClass} resize-y leading-relaxed`}
                />
              </div>
            ))
          )}
          <button
            type="button"
            className={`${smallButton} self-start`}
            disabled={draft.styles.length >= MAX_STYLES}
            onClick={() => update({ styles: [...draft.styles, { name: "", description: "" }] })}
          >
            + Add a style
          </button>
        </Section>

        <div className="sticky bottom-0 -mx-6 flex items-center gap-4 border-t border-[var(--rule)] bg-[var(--bg)] px-6 py-3">
          <button
            type="button"
            onClick={save}
            disabled={!changed || saving}
            className="rounded-sm border border-[var(--fg)] px-4 py-2 font-write-mono text-[12px] uppercase tracking-wide text-[var(--fg)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save profile"}
          </button>
          {changed && !saving ? (
            <button type="button" className={smallButton} onClick={() => setDraft(saved)}>
              Discard changes
            </button>
          ) : null}
          {message ? <span className="text-[13px] text-[var(--fg-muted)]">{message}</span> : null}
        </div>

        <Section title="Appearance" hint="Saved in this browser and applied right away.">
          <div className="flex flex-col gap-3">
            <span className={labelClass}>Theme</span>
            <ThemeSwitch value={theme} onChange={onTheme} />
          </div>
          <div className="flex flex-col gap-3">
            <span className={labelClass}>Writing font</span>
            <FontSwitch value={font} onChange={onFont} />
            <p className={`${FONT_CLASS[font]} text-[1.1rem] leading-relaxed text-[var(--fg)]`}>
              It takes a human to think. The quick brown fox jumps over the lazy dog.
            </p>
          </div>
          <Toggle
            label="Highlight pasted text"
            hint="Marks text that wasn't typed here. It counts toward the Blank Score either way."
            value={showPasted}
            onChange={onShowPasted}
          />
          <Toggle
            label="Show contents in the Details panel"
            hint="Lists a note's headings so you can jump between them."
            value={showToc}
            onChange={onShowToc}
          />
        </Section>
      </div>
    </main>
  );
}
