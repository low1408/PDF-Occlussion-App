import { useState, useEffect } from 'react';
// pdf.js's legacy build carries polyfills; the modern build needs very recent browsers
// (e.g. Map#getOrInsertComputed) and paints blank pages elsewhere.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { useOcclusionStore, RecentPdfEntry } from './store/useOcclusionStore';
import { loadRecents, saveRecent, loadPdfData, deleteRecent, RecentPdfMeta } from './store/useRecentPdfs';
import PdfViewer from './components/PdfViewer';
import { pullFromServer, startAutoSync } from './sync';
import './index.css';

// Ensure worker is configured before any getDocument call in this module
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function App() {
  const [fileData, setFileData] = useState<ArrayBuffer | null>(null);
  const [fileHash, setFileHash] = useState<string>('');
  const [initialPage, setInitialPage] = useState<number | undefined>(undefined);
  const [recents, setRecents] = useState<RecentPdfMeta[]>([]);
  const [loadingRecent, setLoadingRecent] = useState<string | null>(null);
  const loadBoxesForDocument = useOcclusionStore(state => state.loadBoxesForDocument);

  useEffect(() => {
    if (fileHash) {
      // Show local data straight away, then fold in anything newer from the backend.
      loadBoxesForDocument(fileHash).then(() => pullFromServer(fileHash));
    }
  }, [fileHash, loadBoxesForDocument]);

  // Load recents list on mount
  useEffect(() => {
    loadRecents().then(setRecents).catch(console.error);
  }, []);

  useEffect(() => startAutoSync(), []);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const buffer = await file.arrayBuffer();
    // Generate SHA-256 for Document ID
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    // Reopening a PDF that's already in recents resumes where it was left.
    const known = recents.find(r => r.fileHash === hashHex);

    // Open the PDF immediately — don't block on caching
    setFileData(buffer);
    setFileHash(hashHex);
    setInitialPage(known?.lastViewedPage);

    // Cache in IDB in the background (best-effort).
    // pdf.js transfers (detaches) the buffer it's given, so take the copy to store
    // before handing pdf.js a separate one.
    try {
      const pdfData = buffer.slice(0);
      const pdf = await pdfjsLib.getDocument(new Uint8Array(buffer.slice(0))).promise;
      const numPages = pdf.numPages;
      await pdf.destroy(); // only needed the page count
      const entry: RecentPdfEntry = {
        fileHash: hashHex,
        fileName: file.name,
        fileSize: file.size,
        numPages,
        lastViewedPage: known?.lastViewedPage ?? 1,
        lastOpenedAt: Date.now(),
        pdfData,
      };
      await saveRecent(entry);
    } catch (err) {
      console.warn('[Recents] Failed to cache PDF — it will still open:', err);
    }
  };

  const handleOpenRecent = async (meta: RecentPdfMeta) => {
    if (loadingRecent) return;
    setLoadingRecent(meta.fileHash);
    try {
      const data = await loadPdfData(meta.fileHash);
      if (!data) {
        alert('PDF data not found in cache. Please re-open the file.');
        setLoadingRecent(null);
        return;
      }
      setFileData(data);
      setFileHash(meta.fileHash);
      setInitialPage(meta.lastViewedPage);
    } catch (err) {
      console.error('Failed to load recent PDF:', err);
      alert('Failed to load PDF from cache.');
    }
    setLoadingRecent(null);
  };

  const handleDeleteRecent = async (e: React.MouseEvent, fileHash: string) => {
    e.stopPropagation();
    await deleteRecent(fileHash);
    setRecents(prev => prev.filter(r => r.fileHash !== fileHash));
  };

  return (
    <div className="app-container">
      {!fileData ? (
        <div className="upload-container">
          <div className="landing-header">
            <h1>📖 PDF Occlusion Engine</h1>
            <p>Select a PDF to begin studying</p>
            <label className="file-picker-btn" id="file-picker">
              <span>📂 Choose PDF</span>
              <input type="file" accept="application/pdf" onChange={handleFileChange} />
            </label>
          </div>

          {recents.length > 0 && (
            <div className="recents-section">
              <div className="recents-divider">
                <span>Recently Opened</span>
              </div>
              <div className="recents-list">
                {recents.map(r => (
                  // A div, not a <button>: it contains the delete button, and buttons can't nest.
                  <div
                    key={r.fileHash}
                    className="recent-card"
                    id={`recent-${r.fileHash.substring(0, 8)}`}
                    role="button"
                    tabIndex={0}
                    aria-disabled={loadingRecent === r.fileHash}
                    onClick={() => handleOpenRecent(r)}
                    onKeyDown={e => {
                      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        handleOpenRecent(r);
                      }
                    }}
                  >
                    <div className="recent-icon">📄</div>
                    <div className="recent-info">
                      <div className="recent-name">{r.fileName}</div>
                      <div className="recent-meta">
                        <span>{r.numPages} pages</span>
                        <span className="meta-dot">·</span>
                        <span>Page {r.lastViewedPage}</span>
                        <span className="meta-dot">·</span>
                        <span>{formatFileSize(r.fileSize)}</span>
                        <span className="meta-dot">·</span>
                        <span>{formatTimeAgo(r.lastOpenedAt)}</span>
                      </div>
                    </div>
                    <button
                      className="recent-delete"
                      onClick={(e) => handleDeleteRecent(e, r.fileHash)}
                      title="Remove from recent"
                    >
                      ✕
                    </button>
                    {loadingRecent === r.fileHash && (
                      <div className="recent-loading">Loading…</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <PdfViewer key={fileHash} fileData={fileData} fileHash={fileHash} initialPage={initialPage} />
      )}
    </div>
  );
}

export default App;
