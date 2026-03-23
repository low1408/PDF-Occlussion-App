import React, { useEffect, useState, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { openDB } from 'idb';
import { useOcclusionStore } from '../store/useOcclusionStore';
import PdfPage from './PdfPage';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfViewerProps {
  fileData: ArrayBuffer;
  fileHash: string;
}

export default function PdfViewer({ fileData, fileHash }: PdfViewerProps) {
  const [pdfDocument, setPdfDocument] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [zoom, setZoom] = useState<number>(1.0);
  const [drawMode, setDrawMode] = useState<boolean>(false);
  const [darkMode, setDarkMode] = useState<boolean>(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const [outline, setOutline] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'chapters' | 'bookmarks'>('chapters');
  const bookmarks = useOcclusionStore(state => state.bookmarks);

  const undo = useOcclusionStore(state => state.undo);
  const redo = useOcclusionStore(state => state.redo);
  const addBox = useOcclusionStore(state => state.addBox);
  const historyIndex = useOcclusionStore(state => state.historyIndex);
  const historyLength = useOcclusionStore(state => state.history.length);

  // Keyboard shortcut: 'D' to toggle draw mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isInput = document.activeElement?.tagName === 'INPUT';
      if (isInput) return;

      if (e.key === 'd' || e.key === 'D') {
        setDrawMode(prev => !prev);
      } else if (e.ctrlKey && e.key.toLowerCase() === 'z') {
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
        e.preventDefault();
      } else if (e.ctrlKey && e.key.toLowerCase() === 'y') {
        redo();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo]);

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
        
        const out = await pdf.getOutline();
        setOutline(out || []);
      } catch (e) {
        console.error("Error loading PDF", e);
      }
    };
    loadPdf();
  }, [fileData]);

  const scrollToPage = async (dest: any, pageIndex?: number) => {
    let targetIndex = pageIndex;
    if (dest && pdfDocument) {
      let destArray = dest;
      if (typeof dest === 'string') {
        destArray = await pdfDocument.getDestination(dest);
      }
      if (Array.isArray(destArray)) {
        try {
          const ref = destArray[0];
          targetIndex = await pdfDocument.getPageIndex(ref) + 1; // 0-based to 1-based
        } catch (e) {
          console.error("Could not resolve destination string/ref", e);
        }
      }
    }
    if (targetIndex && containerRef.current) {
      const el = containerRef.current.children[targetIndex - 1];
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const renderOutline = (items: any[]) => items.map((item, idx) => (
    <div key={idx} style={{ paddingLeft: '10px' }}>
      <div className="toc-item" onClick={() => scrollToPage(item.dest)}>
        {item.title}
      </div>
      {item.items && item.items.length > 0 && renderOutline(item.items)}
    </div>
  ));

  if (!pdfDocument) {
    return <div className="loading">Loading PDF...</div>;
  }

  return (
    <div className={`pdf-viewer-overlay ${darkMode ? 'dark-mode' : ''}`}>
      <div className="toolbar">
        <div className="toolbar-title">PDF Occlusion Engine ({numPages} pages)</div>
        <div className="mode-controls">
          <button
            className={`mode-btn ${drawMode ? 'active' : ''}`}
            onClick={() => setDrawMode(prev => !prev)}
          >
            {drawMode ? '✏️ Draw Mode' : '👁️ Review Mode'}
          </button>
          <button
            className={`mode-btn ${darkMode ? 'active' : ''}`}
            onClick={() => setDarkMode(prev => !prev)}
          >
            {darkMode ? '☀️ Light' : '🌙 Dark'}
          </button>
        </div>
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
          <button onClick={() => setZoom(z => Math.min(5.0, z + 0.2))}>+</button>
        </div>
      </div>
      {drawMode && (
        <div className="draw-mode-banner">
          DRAW MODE ACTIVE — Click and drag to create occlusions. Press <kbd>D</kbd> to switch back to Review Mode.
        </div>
      )}
      <div className="pdf-layout">
        <div className="sidebar">
          <div className="sidebar-tabs">
            <button 
              className={`sidebar-tab ${activeTab === 'chapters' ? 'active' : ''}`}
              onClick={() => setActiveTab('chapters')}
            >
              Chapters
            </button>
            <button 
              className={`sidebar-tab ${activeTab === 'bookmarks' ? 'active' : ''}`}
              onClick={() => setActiveTab('bookmarks')}
            >
              Bookmarks
            </button>
          </div>
          <div className="sidebar-content">
            {activeTab === 'chapters' && (
              outline.length > 0 ? renderOutline(outline) : <div style={{ color: '#64748b', textAlign: 'center', marginTop: '20px' }}>No chapters found</div>
            )}
            {activeTab === 'bookmarks' && (
              bookmarks.length > 0 ? bookmarks.map(b => (
                <div key={b.id} className="bookmark-item" onClick={() => scrollToPage(null, b.page_index)}>
                  ⭐ {b.title}
                </div>
              )) : <div style={{ color: '#64748b', textAlign: 'center', marginTop: '20px' }}>No bookmarks added</div>
            )}
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
              drawMode={drawMode}
              darkMode={darkMode}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
