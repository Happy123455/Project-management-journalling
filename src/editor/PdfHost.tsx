import { useEffect, useState } from "react";
import { openFile, readFileBytes, readFileRecord } from "./attachments";
import { PdfViewer } from "./pdf";

/** Shows the full-screen PDF reader when a PDF preview's ⤢ is tapped. */
export function PdfHost() {
  const [open, setOpen] = useState<{ id: string; name: string; bytes: Uint8Array } | null>(null);
  useEffect(() => {
    const onOpen = async (e: Event) => {
      const id = (e as CustomEvent<{ fileId: string }>).detail.fileId;
      const [file, bytes] = await Promise.all([readFileRecord(id), readFileBytes(id)]);
      if (file && bytes) setOpen({ id, name: file.name, bytes });
    };
    window.addEventListener("journal:open-pdf", onOpen);
    return () => window.removeEventListener("journal:open-pdf", onOpen);
  }, []);
  if (!open) return null;
  return (
    <PdfViewer
      name={open.name}
      bytes={open.bytes}
      onClose={() => setOpen(null)}
      onOpenExternally={"__TAURI_INTERNALS__" in window ? () => void openFile(open.id) : undefined}
    />
  );
}
