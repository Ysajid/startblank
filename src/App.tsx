import { useEffect, useState } from "react";
import { readShareSlug } from "./lib/share";
import { fetchDocumentBySlug } from "./lib/documentsApi";
import type { PublishedDocument } from "./types";
import { Writer } from "./components/Writer";
import { ReadOnly } from "./components/ReadOnly";
import { NotFound } from "./components/NotFound";

type ViewState =
  | { status: "writer" }
  | { status: "loading" }
  | { status: "shared"; doc: PublishedDocument }
  | { status: "not-found" };

export default function App() {
  const [view, setView] = useState<ViewState>(() =>
    readShareSlug() ? { status: "loading" } : { status: "writer" }
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const slug = readShareSlug();
      if (!slug) {
        setView({ status: "writer" });
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
  return <Writer />;
}
