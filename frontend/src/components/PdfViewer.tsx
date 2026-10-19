import React, { useEffect, useState, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { useOcclusionStore, ReviewFilter, dbPromise } from '../store/useOcclusionStore';
import { updateLastViewedPage } from '../store/useRecentPdfs';
import { onSyncResult, requestSync } from '../sync';
import PdfPage from './PdfPage';
import ReviewDashboard from './ReviewDashboard';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfViewerProps {
  fileData: ArrayBuffer;
  fileHash: string;
  initialPage?: number;
}

export default function PdfViewer({ fileData, fileHash, initialPage }: PdfViewerProps) {
  const [pdfDocument, setPdfDocument] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [zoom, setZoom] = useState<number>(2.3);
  const [drawMode, setDrawMode] = useState<boolean>(false);
  const [darkMode, setDarkMode] = useState<boolean>(false);
  const [showDashboard, setShowDashboard] = useState<boolean>(false);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'failed'>('idle');
  const containerRef = useRef<HTMLDivElement>(null);

  const [outline, setOutline] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'chapters' | 'bookmarks'>('chapters');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(false);
  const bookmarks = useOcclusionStore(state => state.bookmarks);

  const undo = useOcclusionStore(state => state.undo);
  const redo = useOcclusionStore(state => state.redo);
  const addBox = useOcclusionStore(state => state.addBox);
  const historyIndex = useOcclusionStore(state => state.historyIndex);
  const historyLength = useOcclusionStore(state => state.history.length);

  const toggleRevealAllForPage = useOcclusionStore(state => state.toggleRevealAllForPage);
  const toggleRevealAllForDocument = useOcclusionStore(state => state.toggleRevealAllForDocument);
  const setActiveReviewPage = useOcclusionStore(state => state.setActiveReviewPage);
  const revealAllDocument = useOcclusionStore(state => state.revealAllDocument);
  const revealAllPages = useOcclusionStore(state => state.revealAllPages);

  // Track currently visible page for the "Reveal Page" button
  const [visiblePage, setVisiblePage] = useState<number>(1);

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

  // Track the page under the viewer's vertical midpoint. The zero-height root band
  // means at most one page intersects it at a time, so a page that is only peeking
  // in at the edge never counts as the visible one.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || numPages === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setVisiblePage(Number((entry.target as HTMLElement).dataset.pageIndex));
        }
      },
      { root: container, rootMargin: '-50% 0px -50% 0px' }
    );

    // Defer observation so children are mounted
    const timer = setTimeout(() => {
      for (const child of Array.from(container.children)) {
        observer.observe(child);
      }
    }, 100);

    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [numPages]);

  // Reflect automatic syncs too, so the button shows when the backend goes away or comes back.
  useEffect(() => onSyncResult(ok => setSyncState(ok ? 'idle' : 'failed')), []);

  // Review-mode keys follow the page being read (a click on another page also claims them).
  useEffect(() => {
    setActiveReviewPage(visiblePage);
  }, [visiblePage, setActiveReviewPage]);

  // Debounced save of the currently visible page to IDB (for resume-on-reopen)
  useEffect(() => {
    if (!fileHash || visiblePage < 1) return;
    const timer = setTimeout(() => {
      updateLastViewedPage(fileHash, visiblePage).catch(console.error);
    }, 2000);
    return () => clearTimeout(timer);
  }, [fileHash, visiblePage]);

  // Scroll to initialPage after PDF finishes loading
  const hasScrolledToInitial = useRef(false);
  useEffect(() => {
    if (!initialPage || initialPage <= 1 || hasScrolledToInitial.current) return;
    if (!pdfDocument || numPages === 0) return;
    const target = Math.min(initialPage, numPages);

    // Wait for pages to render, then scroll
    const timer = setTimeout(() => {
      scrollToPage(null, target);
      hasScrolledToInitial.current = true;
    }, 300);
    return () => clearTimeout(timer);
  }, [pdfDocument, numPages, initialPage]);

  const handleExport = async () => {
    try {
      if (!dbPromise) return;
      const db = await dbPromise;
      const boxes = (await db.getAllFromIndex('occlusions', 'by-doc', fileHash)).filter(b => !b.is_deleted);
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
    // pdf.js transfers (detaches) the buffer it's given, so hand it a copy: StrictMode runs
    // this effect twice in development, and the second run still needs fileData intact.
    const loadingTask = pdfjsLib.getDocument(new Uint8Array(fileData.slice(0)));
    let cancelled = false;
    const loadPdf = async () => {
      try {
        const pdf = await loadingTask.promise;
        if (cancelled) return;
        setPdfDocument(pdf);
        setNumPages(pdf.numPages);

        const out = await pdf.getOutline();
        if (!cancelled) setOutline(out || []);
      } catch (e) {
        if (!cancelled) console.error("Error loading PDF", e);
      }
    };
    loadPdf();
    return () => {
      cancelled = true;
      loadingTask.destroy(); // frees the document and its worker
    };
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
          if (Number.isInteger(ref)) {
            targetIndex = ref + 1;
          } else {
            targetIndex = await pdfDocument.getPageIndex(ref) + 1; // 0-based to 1-based
          }
        } catch (e) {
          console.error("Could not resolve destination string/ref", e);
        }
      }
    }

    const container = containerRef.current;
    if (!targetIndex || !container) return;

    const el = container.children[targetIndex - 1] as HTMLElement | undefined;
    if (!el) return;

    // Use getBoundingClientRect for reliable position regardless of offsetParent chain.
    // elRect.top is the element's distance from the viewport top.
    // containerRect.top is the container's distance from the viewport top.
    // The difference gives the element's position relative to the container's visible area.
    // Adding container.scrollTop converts that to an absolute scroll offset.
    const jumpTo = () => {
      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      container.scrollTop += elRect.top - containerRect.top;
    };

    // Pass 1: instant jump to the target page.
    // This triggers IntersectionObserver to render pages around the target.
    jumpTo();

    // Pass 2: after lazy-rendered pages resize and layout stabilises, correct.
    setTimeout(jumpTo, 0);
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

  const handleJumpToPage = (pageIndex: number) => {
    scrollToPage(null, pageIndex);
  };

  const handleSync = () => {
    setSyncState('syncing');
    void requestSync();
  };

  const liveBookmarks = bookmarks.filter(b => !b.is_deleted);

  return (
    <div className={`pdf-viewer-overlay ${darkMode ? 'dark-mode' : ''}`}>
      {showDashboard && (
        <ReviewDashboard
          fileHash={fileHash}
          onClose={() => setShowDashboard(false)}
          onJumpToPage={handleJumpToPage}
        />
      )}
      <div className="toolbar">
        <div className="toolbar-title">PDF Occlusion Engine ({numPages} pages)</div>
        <button
          className={`mode-btn ${isSidebarCollapsed ? '' : 'active'}`}
          onClick={() => setIsSidebarCollapsed(prev => !prev)}
          aria-expanded={!isSidebarCollapsed}
          aria-controls="document-outline"
        >
          {isSidebarCollapsed ? '☰ Outline' : '← Hide outline'}
        </button>
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
          <button onClick={undo} disabled={historyIndex < 0}>Undo</button>
          <button onClick={redo} disabled={historyIndex >= historyLength - 1}>Redo</button>
        </div>
        <div className="share-controls">
          <button
            onClick={handleSync}
            className="mode-btn"
            disabled={syncState === 'syncing'}
            title={syncState === 'failed' ? 'Could not reach the backend. Changes are saved locally and will sync automatically.' : undefined}
          >
            {syncState === 'syncing' ? '🔄 Syncing…' : syncState === 'failed' ? '⚠️ Sync failed' : '🔄 Sync'}
          </button>
          <button
            className="mode-btn"
            onClick={() => setShowDashboard(true)}
          >
            📊 Dashboard
          </button>
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
      {!drawMode && (
        <div className="reveal-controls-banner">
          <button
            id="reveal-page-btn"
            className={`reveal-btn ${revealAllPages.has(visiblePage) ? 'active' : ''}`}
            onClick={() => toggleRevealAllForPage(visiblePage)}
          >
            👁️ Reveal Page {visiblePage}
          </button>
          <button
            id="reveal-all-btn"
            className={`reveal-btn ${revealAllDocument ? 'active' : ''}`}
            onClick={toggleRevealAllForDocument}
          >
            👁️‍🗨️ Reveal All Pages
          </button>
          <div className="filter-control">
            <label htmlFor="review-filter-select" style={{ color: '#94a3b8', fontSize: '0.85rem', marginRight: '6px' }}>
              Filter:
            </label>
            <select
              id="review-filter-select"
              value={reviewFilter}
              onChange={e => setReviewFilter(e.target.value as ReviewFilter)}
              style={{
                background: '#1e293b',
                color: '#e2e8f0',
                border: '1px solid #334155',
                borderRadius: '6px',
                padding: '4px 8px',
                fontSize: '0.85rem',
                cursor: 'pointer',
              }}
            >
              <option value="all">All masks</option>
              <option value="ungraded">⬛ Ungraded</option>
              <option value="easy">🟢 Easy</option>
              <option value="ok">🔵 OK</option>
              <option value="hard">🟠 Hard</option>
              <option value="impossible">🔴 Impossible</option>
            </select>
          </div>
        </div>
      )}
      {drawMode && (
        <div className="draw-mode-banner">
          DRAW MODE ACTIVE — Click and drag to create occlusions. Press <kbd>D</kbd> to switch back to Review Mode.
        </div>
      )}
      <div className="pdf-layout">
        {!isSidebarCollapsed && (
          <div id="document-outline" className="sidebar">
            <div className="sidebar-header">
              <div className="sidebar-title">Document outline</div>
            </div>
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
                outline.length > 0 ? renderOutline(outline) : <div className="sidebar-empty">No chapters found</div>
              )}
              {activeTab === 'bookmarks' && (
                liveBookmarks.length > 0 ? liveBookmarks.map(b => (
                  <div key={b.id} className="bookmark-item" onClick={() => scrollToPage(null, b.page_index)}>
                    ⭐ {b.title}
                  </div>
                )) : <div className="sidebar-empty">No bookmarks added</div>
              )}
            </div>
          </div>
        )}
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
              scrollContainerRef={containerRef}
              reviewFilter={reviewFilter}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
