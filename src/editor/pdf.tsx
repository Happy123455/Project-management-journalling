import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

let pdfjs: Promise<typeof import("pdfjs-dist")> | null = null;

/** pdf.js, loaded the first time a PDF is shown. */
function loadPdfjs() {
  pdfjs ??= import("pdfjs-dist").then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    return lib;
  });
  return pdfjs;
}

export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const lib = await loadPdfjs();
  // pdf.js takes ownership of the buffer it's given, so hand it a copy.
  return lib.getDocument({ data: bytes.slice() }).promise;
}

/** Draws one page into a canvas at `width` CSS pixels (sharp on high-density screens). */
export async function drawPage(doc: PDFDocumentProxy, pageNumber: number, canvas: HTMLCanvasElement, width: number) {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = (width / base.width) * (window.devicePixelRatio || 1);
  const viewport = page.getViewport({ scale });
  // Render off-screen, then copy: a second draw of the same page (re-render, StrictMode)
  // would otherwise collide with one still running on the visible canvas.
  const scratch = document.createElement("canvas");
  scratch.width = Math.floor(viewport.width);
  scratch.height = Math.floor(viewport.height);
  await page.render({ canvas: scratch, viewport }).promise;
  canvas.width = scratch.width;
  canvas.height = scratch.height;
  canvas.getContext("2d")?.drawImage(scratch, 0, 0);
}

/** Full-screen reader: every page, scrollable, with a close button. */
export function PdfViewer({ name, bytes, onClose, onOpenExternally }: {
  name: string;
  bytes: Uint8Array;
  onClose: () => void;
  onOpenExternally?: () => void;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    openPdf(bytes).then((d) => live && setDoc(d)).catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [bytes]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="pdf-viewer" role="dialog" aria-label={name}>
      <header className="pdf-viewer-bar">
        <span className="pdf-viewer-name">📕 {name}</span>
        {onOpenExternally && <button type="button" onClick={onOpenExternally}>Open in app</button>}
        <button type="button" onClick={onClose} aria-label="Close">✕</button>
      </header>
      <div className="pdf-viewer-pages">
        {error && <p className="hint">This PDF couldn't be read.</p>}
        {doc && Array.from({ length: doc.numPages }, (_, i) => <PdfPage key={i} doc={doc} pageNumber={i + 1} />)}
      </div>
    </div>
  );
}

function PdfPage({ doc, pageNumber }: { doc: PDFDocumentProxy; pageNumber: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (canvas.current) void drawPage(doc, pageNumber, canvas.current, Math.min(window.innerWidth - 24, 900));
  }, [doc, pageNumber]);
  return <canvas ref={canvas} className="pdf-page" />;
}
