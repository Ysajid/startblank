import { useEffect, useState } from "react";
import { readShareSlug } from "./lib/share";
import { fetchDocumentBySlug } from "./lib/documentsApi";
import type { PublishedDocument } from "./types";
import { useSession } from "./lib/useSession";
import { ReadOnly } from "./components/ReadOnly";
import { NotFound } from "./components/NotFound";
import { AuthScreen } from "./components/AuthScreen";
import { Workspace } from "./components/Workspace";

type ViewState =
  | { status: "vault" }
  | { status: "loading" }
  | { status: "shared"; doc: PublishedDocument }
  | { status: "not-found" };

export default function App() {
  const [view, setView] = useState<ViewState>(() =>
    readShareSlug() ? { status: "loading" } : { status: "vault" }
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const slug = readShareSlug();
      if (!slug) {
        setView({ status: "vault" });
        return;
      }
      setView({ status: "loading" });
      const doc = await fetchDocumentBySlug(slug);
      if (cancelled) return;
      setView(doc ? { status: "shared", doc } : { status: "not-found" });
    }

    load();
    window.addEventListener("hashchange", load);
    return () => {
      cancelled = true;
      window.removeEventListener("hashchange", load);
    };
  }, []);

  if (view.status === "loading") return null;
  if (view.status === "shared") return <ReadOnly doc={view.doc} />;
  if (view.status === "not-found") return <NotFound />;
  return <Vault />;
}

// Published pages are public; everything else is the signed-in user's vault.
function Vault() {
  const session = useSession();
  if (session === undefined) return null;
  if (session === null) return <AuthScreen />;
  return <Workspace key={session.user.id} session={session} />;
}
