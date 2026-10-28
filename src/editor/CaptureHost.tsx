import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { insertFiles, insertQr } from "./attachments";
import { Capture } from "./Capture";

/** Shows the camera screen when the "/" Capture tile asks for it. */
export function CaptureHost() {
  const [editor, setEditor] = useState<Editor | null>(null);
  useEffect(() => {
    const onOpen = (e: Event) => setEditor((e as CustomEvent<{ editor: Editor }>).detail.editor);
    window.addEventListener("journal:capture", onOpen);
    return () => window.removeEventListener("journal:capture", onOpen);
  }, []);
  if (!editor) return null;
  return (
    <Capture
      onClose={() => setEditor(null)}
      onDone={(result) => {
        setEditor(null);
        if (result.kind === "qr") insertQr(editor, result.text);
        else void insertFiles(editor, [result.file]);
      }}
    />
  );
}
