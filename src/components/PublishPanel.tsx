import { useEffect, useState } from "react";
import { computeBlankScore } from "../lib/blankScore";
import { buildShareUrl } from "../lib/share";
import type { FontName, ThemeName, WritingStats } from "../types";
import { ScoreMeter } from "./ScoreMeter";

interface Snapshot {
  content: string;
  stats: WritingStats;
}

export function PublishPanel({
  open,
  onClose,
  getSnapshot,
  theme,
  font,
}: {
  open: boolean;
  onClose: () => void;
  getSnapshot: () => Snapshot;
  theme: ThemeName;
  font: FontName;
}) {
  const [stage, setStage] = useState<"review" | "done">("review");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSnapshot(getSnapshot());
    setStage("review");
    setCopied(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!snapshot) return null;

  const finalLength = snapshot.content.length;
  const wordCount = snapshot.content.trim() === "" ? 0 : snapshot.content.trim().split(/\s+/).length;
  const breakdown = computeBlankScore(snapshot.stats, finalLength);

  function confirmPublish() {
    if (!snapshot) return;
    const url = buildShareUrl({
      content: snapshot.content,
      theme,
      font,
      stats: snapshot.stats,
      finalLength,
      score: breakdown.score,
      publishedAt: Date.now(),
    });
    setShareUrl(url);
    setStage("done");
  }

  async function copyLink() {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
  }

  return (
    <div
      className={`fixed inset-y-0 right-0 z-10 w-[min(380px,100%)] border-l border-[var(--rule)] bg-[var(--surface)] p-7 transition-transform duration-300 ease-out ${
        open ? "translate-x-0" : "translate-x-full"
      }`}
      aria-hidden={!open}
    >
      <div className="flex items-center justify-between">
        <h2 className="font-write-mono text-[11px] uppercase tracking-wide text-[var(--fg-muted)]">
          {stage === "review" ? "Publish" : "Published"}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="font-write-mono text-[11px] uppercase tracking-wide text-[var(--fg-muted)] hover:text-[var(--fg)]"
        >
          Close
        </button>
      </div>

      {stage === "review" ? (
        <div className="mt-8 flex flex-col gap-8">
          <dl className="grid grid-cols-2 gap-y-3 font-write-mono text-[13px]">
            <dt className="text-[var(--fg-muted)]">Words</dt>
            <dd className="tabular-nums text-right">{wordCount}</dd>
            <dt className="text-[var(--fg-muted)]">Characters</dt>
            <dd className="tabular-nums text-right">{finalLength}</dd>
            <dt className="text-[var(--fg-muted)]">Pasted</dt>
            <dd className="tabular-nums text-right">{snapshot.stats.pastedChars}</dd>
            <dt className="text-[var(--fg-muted)]">Edits</dt>
            <dd className="tabular-nums text-right">{snapshot.stats.edits}</dd>
          </dl>

          <ScoreMeter score={breakdown.score} label="Blank score" />

          <p className="text-[13px] leading-relaxed text-[var(--fg-muted)]">
            Publishing freezes this text as a read-only page anyone with the
            link can view. It cannot be edited afterward.
          </p>

          <button
            type="button"
            onClick={confirmPublish}
            disabled={finalLength === 0}
            className="self-start rounded-sm border border-[var(--fg)] px-4 py-2 font-write-mono text-[12px] uppercase tracking-wide text-[var(--fg)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Confirm &amp; get link
          </button>
        </div>
      ) : (
        <div className="mt-8 flex flex-col gap-6">
          <ScoreMeter score={breakdown.score} label="Blank score" />

          <div>
            <label
              htmlFor="share-url"
              className="font-write-mono text-[11px] uppercase tracking-wide text-[var(--fg-muted)]"
            >
              Share link
            </label>
            <div className="mt-2 flex items-stretch gap-2">
              <input
                id="share-url"
                readOnly
                value={shareUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full truncate border border-[var(--rule)] bg-transparent px-3 py-2 font-write-mono text-[12px] text-[var(--fg)]"
              />
              <button
                type="button"
                onClick={copyLink}
                className="shrink-0 rounded-sm border border-[var(--fg)] px-3 py-2 font-write-mono text-[11px] uppercase tracking-wide text-[var(--fg)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          <a
            href={shareUrl}
            target="_blank"
            rel="noreferrer"
            className="font-write-mono text-[12px] text-[var(--accent)] underline underline-offset-4"
          >
            Open published page ↗
          </a>
        </div>
      )}
    </div>
  );
}
