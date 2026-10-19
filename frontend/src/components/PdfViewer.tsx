import React, { useEffect, useState, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { useOcclusionStore, ReviewFilter, dbPromise } from '../store/useOcclusionStore';
import { updateLastViewedPage } from '../store/useRecentPdfs';
import { onSyncResult, requestSync } from '../sync';
import { useTheme } from '../theme';
import Icon from './Icon';
import PdfPage from './PdfPage';
import ReviewDashboard from './ReviewDashboard';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfViewerProps {
  fileData: ArrayBuffer;
  fileHash: string;
  fileName: string;
  initialPage?: number;
  onClose: () => void;
}

// Swatches for the sub-bar legend, in grade-key order.
const GRADE_LEGEND: [string, string][] = [
  ['New', 'var(--mask-ungraded)'],
  ['Easy', 'var(--grade-easy)'],
  ['OK', 'var(--grade-ok)'],
  ['Hard', 'var(--grade-hard)'],
  ['Impossible', 'var(--grade-impossible)'],
];

export default function PdfViewer({ fileData, fileHash, fileName, initialPage, onClose }: PdfViewerProps) {
  const [pdfDocument, setPdfDocument] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [zoom, setZoom] = useState<number>(2.3);
  const [drawMode, setDrawMode] = useState<boolean>(false);
  const [theme, toggleTheme] = useTheme();
  const darkMode = theme === 'dark';
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

  const renderOutline = (items: any[], depth = 0) => items.map((item, idx) => (
    <div key={idx}>
      <div
        className={`toc-item ${depth === 0 ? 'top' : ''}`}
        style={{ paddingLeft: `${10 + depth * 14}px` }}
        title={item.title}
        onClick={() => scrollToPage(item.dest)}
      >
        {item.title}
      </div>
      {item.items && item.items.length > 0 && renderOutline(item.items, depth + 1)}
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

  const syncLabel = syncState === 'syncing' ? 'Syncing…' : syncState === 'failed' ? 'Sync failed' : 'Sync';

  return (
    <div className="pdf-viewer-overlay">
      {showDashboard && (
        <ReviewDashboard
          fileHash={fileHash}
          fileName={fileName}
          onClose={() => setShowDashboard(false)}
          onJumpToPage={handleJumpToPage}
        />
      )}
      <div className="toolbar">
        <div className="toolbar-group">
          <button className="tb-btn" onClick={onClose} title="Back to library" aria-label="Back to library">
            <Icon name="arrowLeft" />
          </button>
          <button
            className={`tb-btn ${isSidebarCollapsed ? '' : 'active'}`}
            onClick={() => setIsSidebarCollapsed(prev => !prev)}
            aria-expanded={!isSidebarCollapsed}
            aria-controls="document-outline"
            aria-label={isSidebarCollapsed ? 'Show outline' : 'Hide outline'}
            title={isSidebarCollapsed ? 'Show outline' : 'Hide outline'}
          >
            <Icon name="panel" />
          </button>
        </div>
        <div className="toolbar-title" title={fileName}>
          <strong>{fileName}</strong>
          <span>{numPages} pages</span>
        </div>
        <div className="toolbar-spacer" />
        <div className="segmented" role="group" aria-label="Mode">
          <button aria-pressed={!drawMode} onClick={() => setDrawMode(false)} title="Review mode (D)">
            <Icon name="eye" size={14} />Review
          </button>
          <button className="draw" aria-pressed={drawMode} onClick={() => setDrawMode(true)} title="Draw mode (D)">
            <Icon name="pencil" size={14} />Draw
          </button>
        </div>
        <div className="toolbar-divider" />
        <div className="toolbar-group history-controls">
          <button className="tb-btn" onClick={undo} disabled={historyIndex < 0} aria-label="Undo" title="Undo (Ctrl+Z)">
            <Icon name="undo" />
          </button>
          <button className="tb-btn" onClick={redo} disabled={historyIndex >= historyLength - 1} aria-label="Redo" title="Redo (Ctrl+Y)">
            <Icon name="redo" />
          </button>
        </div>
        <div className="toolbar-divider" />
        <div className="toolbar-group zoom-controls">
          <button className="tb-btn" onClick={() => setZoom(z => Math.max(0.5, z - 0.2))} aria-label="Zoom out" title="Zoom out">
            <Icon name="minus" />
          </button>
          <span className="zoom-value">{Math.round(zoom * 100)}%</span>
          <button className="tb-btn" onClick={() => setZoom(z => Math.min(5.0, z + 0.2))} aria-label="Zoom in" title="Zoom in">
            <Icon name="plus" />
          </button>
        </div>
        <div className="toolbar-divider" />
        <div className="toolbar-group share-controls">
          <button
            onClick={handleSync}
            className={`tb-btn ${syncState}`}
            disabled={syncState === 'syncing'}
            aria-label={syncLabel}
            title={syncState === 'failed' ? 'Could not reach the backend. Changes are saved locally and will sync automatically.' : 'Sync now (also runs every 10 seconds)'}
          >
            <Icon name={syncState === 'failed' ? 'warning' : 'refresh'} />
            <span className="tb-label">{syncLabel}</span>
          </button>
          <button className="tb-btn" onClick={() => setShowDashboard(true)} aria-label="Dashboard" title="Review dashboard">
            <Icon name="chart" />
            <span className="tb-label">Dashboard</span>
          </button>
          <button className="tb-btn" onClick={handleExport} aria-label="Export" title="Export masks as JSON">
            <Icon name="download" />
            <span className="tb-label">Export</span>
          </button>
          <label className="tb-btn" title="Import masks from JSON">
            <Icon name="upload" />
            <span className="tb-label">Import</span>
            <input type="file" accept="application/json" onChange={handleImport} style={{ display: 'none' }} />
          </label>
        </div>
        <div className="toolbar-divider" />
        <button
          className="tb-btn"
          onClick={toggleTheme}
          aria-label={darkMode ? 'Light mode' : 'Dark mode'}
          title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          <Icon name={darkMode ? 'sun' : 'moon'} />
        </button>
      </div>
      {drawMode ? (
        <div className="subbar draw">
          <Icon name="pencil" size={14} />
          <strong>Draw mode</strong>
          <span className="hint-sep">·</span>
          <span>Drag to add a mask</span>
          <span className="hint-sep">·</span>
          <span><kbd>Shift</kbd> + drag to select</span>
          <span className="hint-sep">·</span>
          <span><kbd>Del</kbd> deletes the selection</span>
          <span className="hint-sep">·</span>
          <span><kbd>D</kbd> back to review</span>
        </div>
      ) : (
        <div className="subbar">
          <button
            id="reveal-page-btn"
            className={`reveal-btn ${revealAllPages.has(visiblePage) ? 'active' : ''}`}
            onClick={() => toggleRevealAllForPage(visiblePage)}
          >
            <Icon name="eye" size={14} />Reveal Page {visiblePage}
          </button>
          <button
            id="reveal-all-btn"
            className={`reveal-btn ${revealAllDocument ? 'active' : ''}`}
            onClick={toggleRevealAllForDocument}
          >
            <Icon name="eye" size={14} />Reveal All Pages
          </button>
          <div className="filter-control">
            <label htmlFor="review-filter-select">Show</label>
            <select
              id="review-filter-select"
              className="filter-select"
              value={reviewFilter}
              onChange={e => setReviewFilter(e.target.value as ReviewFilter)}
            >
              <option value="all">All masks</option>
              <option value="ungraded">New (ungraded)</option>
              <option value="easy">Easy</option>
              <option value="ok">OK</option>
              <option value="hard">Hard</option>
              <option value="impossible">Impossible</option>
            </select>
          </div>
          <div className="grade-legend" aria-hidden="true">
            {GRADE_LEGEND.map(([label, color]) => (
              <span key={label}>
                <i className="swatch" style={{ ['--swatch' as string]: color }} />
                {label}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="pdf-layout">
        {!isSidebarCollapsed && (
          <div id="document-outline" className="sidebar">
            <div className="sidebar-header">
              <div className="sidebar-title">Outline</div>
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
                    <span className="star">★</span>{b.title}
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
