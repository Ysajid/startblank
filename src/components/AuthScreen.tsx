import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { resolveInitialTheme } from "../lib/storage";
import { Wordmark } from "./Wordmark";

type Mode = "sign-in" | "sign-up";

export function AuthScreen() {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = resolveInitialTheme();
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    if (mode === "sign-in") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setMessage(error.message);
    } else {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: window.location.origin + window.location.pathname },
      });
      if (error) setMessage(error.message);
      else if (!data.session) setMessage("Check your email to confirm your account, then sign in.");
    }
    setBusy(false);
  }

  const inputClass =
    "w-full border border-[var(--rule)] bg-transparent px-3 py-2 font-write-mono text-[13px] text-[var(--fg)] focus:border-[var(--accent)] focus:outline-none";
  const labelClass = "font-write-mono text-[11px] uppercase tracking-wide text-[var(--fg-muted)]";

  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--rule)] px-6 py-4">
        <Wordmark />
      </header>
      <main className="mx-auto max-w-[360px] px-6 pt-20">
        <h1 className="font-write-typewriter text-2xl text-[var(--fg)]">
          {mode === "sign-in" ? "Welcome back." : "Start a vault."}
        </h1>
        <p className="mt-3 text-[13px] leading-relaxed text-[var(--fg-muted)]">
          Your notes are plain Markdown files, synced to every device you sign
          in on — and every one keeps an honest record of how much of it you
          wrote by hand.
        </p>

        <form onSubmit={submit} className="mt-10 flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <label htmlFor="email" className={labelClass}>
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="password" className={labelClass}>
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="self-start rounded-sm border border-[var(--fg)] px-4 py-2 font-write-mono text-[12px] uppercase tracking-wide text-[var(--fg)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40"
          >
            {busy ? "…" : mode === "sign-in" ? "Sign in" : "Create account"}
          </button>
          {message ? <p className="text-[12px] leading-relaxed text-[var(--fg-muted)]">{message}</p> : null}
        </form>

        <button
          type="button"
          onClick={() => {
            setMode(mode === "sign-in" ? "sign-up" : "sign-in");
            setMessage(null);
          }}
          className="mt-10 font-write-mono text-[11px] uppercase tracking-wide text-[var(--fg-muted)] hover:text-[var(--fg)]"
        >
          {mode === "sign-in" ? "New here? Create an account" : "Have an account? Sign in"}
        </button>
      </main>
    </div>
  );
}
