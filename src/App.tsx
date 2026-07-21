import { useEffect, useState } from "react";
import { readShareHash } from "./lib/share";
import type { PublishedDocument } from "./types";
import { Writer } from "./components/Writer";
import { ReadOnly } from "./components/ReadOnly";

export default function App() {
  const [sharedDoc, setSharedDoc] = useState<PublishedDocument | null>(() => readShareHash());

  useEffect(() => {
    function onHashChange() {
      setSharedDoc(readShareHash());
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return sharedDoc ? <ReadOnly doc={sharedDoc} /> : <Writer />;
}
