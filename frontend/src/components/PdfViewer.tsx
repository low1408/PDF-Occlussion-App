import React, { useEffect, useState, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { openDB } from 'idb';
import { useOcclusionStore } from '../store/useOcclusionStore';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

import PdfPage from './PdfPage';

interface PdfViewerProps {
  fileData: ArrayBuffer;
  fileHash: string;
}

export default function PdfViewer({ fileData, fileHash }: PdfViewerProps) {
  const [pdfDocument, setPdfDocument] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [zoom, setZoom] = useState<number>(1.0);
  const containerRef = useRef<HTMLDivElement>(null);

  const undo = useOcclusionStore(state => state.undo);
  const redo = useOcclusionStore(state => state.redo);
  const addBox = useOcclusionStore(state => state.addBox);
  const historyIndex = useOcclusionStore(state => state.historyIndex);
  const historyLength = useOcclusionStore(state => state.history.length);

  const handleExport = async () => {
    try {
      const db = await openDB('occlusion_engine', 1);
      const boxes = await db.getAllFromIndex('occlusions', 'by-doc', fileHash);
      const blob = new Blob([JSON.stringify(boxes, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `occlusions_${fileHash.substring(0, 8)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Export failed', e);
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const json = ev.target?.result;
        if (typeof json === 'string') {
          const importedBoxes = JSON.parse(json);
          if (!Array.isArray(importedBoxes)) throw new Error('Invalid format');
          for (const box of importedBoxes) {
            if (box.pdfRect && box.document_id === fileHash) {
              addBox({ ...box, id: crypto.randomUUID(), last_modified: Date.now() });
            }
          }
        }
      } catch (e) {
        alert('Failed to import JSON');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  useEffect(() => {
    const loadPdf = async () => {
      try {
        const loadingTask = pdfjsLib.getDocument(new Uint8Array(fileData));
        const pdf = await loadingTask.promise;
        setPdfDocument(pdf);
        setNumPages(pdf.numPages);
      } catch (e) {
        console.error("Error loading PDF", e);
      }
    };
    loadPdf();
  }, [fileData]);

  if (!pdfDocument) {
    return <div className="loading">Loading PDF...</div>;
  }

  return (
    <div className="pdf-viewer-overlay">
      <div className="toolbar">
        <div className="toolbar-title">PDF Occlusion Engine ({numPages} pages)</div>
        <div className="history-controls">
          <button onClick={undo} disabled={historyIndex <= 0}>Undo</button>
          <button onClick={redo} disabled={historyIndex >= historyLength - 1}>Redo</button>
        </div>
        <div className="share-controls">
          <button onClick={handleExport}>Export</button>
          <label className="import-btn">
            Import
            <input type="file" accept="application/json" onChange={handleImport} style={{ display: 'none' }} />
          </label>
        </div>
        <div className="zoom-controls">
          <button onClick={() => setZoom(z => Math.max(0.5, z - 0.2))}>-</button>
          <span>{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom(z => Math.min(3.0, z + 0.2))}>+</button>
        </div>
      </div>
      <div className="pdf-pages-container" ref={containerRef}>
        {Array.from({ length: numPages }).map((_, i) => (
          <PdfPage
            key={i + 1}
            pageIndex={i + 1}
            pdfDocument={pdfDocument}
            scale={zoom}
            fileHash={fileHash}
          />
        ))}
      </div>
    </div>
  );
}
