import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import OcclusionLayer from './OcclusionLayer';
import { useOcclusionStore } from '../store/useOcclusionStore';

interface PdfPageProps {
  pageIndex: number; // 1-based index
  pdfDocument: pdfjsLib.PDFDocumentProxy;
  scale: number;
  fileHash: string;
  drawMode: boolean;
  darkMode: boolean;
}

export default function PdfPage({ pageIndex, pdfDocument, scale, fileHash, drawMode, darkMode }: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [viewport, setViewport] = useState<pdfjsLib.PageViewport | null>(null);

  const bookmarks = useOcclusionStore(state => state.bookmarks);
  const toggleBookmark = useOcclusionStore(state => state.toggleBookmark);
  const isBookmarked = bookmarks.some(b => b.document_id === fileHash && b.page_index === pageIndex);

  // IntersectionObserver for Virtualization
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      setIsVisible(entry.isIntersecting);
    }, { rootMargin: '100% 0px' });

    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Pre-calculate container dimensions so it doesn't collapse when unmounted
  useEffect(() => {
    let active = true;
    const measure = async () => {
      try {
        const page = await pdfDocument.getPage(pageIndex);
        const vp = page.getViewport({ scale, rotation: page.rotate || 0 });
        if (active) setViewport(vp);
      } catch (e) {}
    };
    measure();
    return () => { active = false; };
  }, [pdfDocument, pageIndex, scale]);

  // Render on Canvas
  useEffect(() => {
    let renderTask: pdfjsLib.RenderTask | null = null;
    let pageProxy: pdfjsLib.PDFPageProxy | null = null;
    let isCancelled = false;

    const renderPage = async () => {
      if (!isVisible || !viewport || !canvasRef.current) return;

      try {
        pageProxy = await pdfDocument.getPage(pageIndex);
        const vp = pageProxy.getViewport({ scale, rotation: pageProxy.rotate || 0 });
        setViewport(vp);

        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return;

        const outputScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(vp.width * outputScale);
        canvas.height = Math.floor(vp.height * outputScale);
        canvas.style.width = `${vp.width}px`;
        canvas.style.height = `${vp.height}px`;

        const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;

        renderTask = pageProxy.render({
          canvasContext: ctx,
          canvas: canvas,
          transform,
          viewport: vp,
        });

        await renderTask.promise;
      } catch (err: any) {
        if (!isCancelled && err.name !== 'RenderingCancelledException') {
          console.error(`Page ${pageIndex} render error:`, err);
        }
      }
    };

    if (isVisible) {
      renderPage();
    } else {
      if (pageProxy && typeof (pageProxy as any).cleanup === 'function') (pageProxy as any).cleanup();
    }

    return () => {
      isCancelled = true;
      if (renderTask) renderTask.cancel();
      if (pageProxy && typeof (pageProxy as any).cleanup === 'function') (pageProxy as any).cleanup();
    };
  }, [isVisible, pdfDocument, pageIndex, scale]); 

  return (
    <div 
      ref={containerRef} 
      className="pdf-page-wrapper"
      style={{ 
        width: viewport ? `${viewport.width}px` : '100%', 
        height: viewport ? `${viewport.height}px` : '800px',
        position: 'relative',
      }}
    >
      <button 
        className="page-bookmark-btn" 
        onClick={() => toggleBookmark(fileHash, pageIndex)}
        title={isBookmarked ? "Remove Bookmark" : "Add Bookmark"}
      >
        {isBookmarked ? '★' : '☆'}
      </button>

      {isVisible && (
        <canvas
          ref={canvasRef}
          className={darkMode ? 'dark-canvas' : ''}
        />
      )}
      {isVisible && viewport && (
        <OcclusionLayer viewport={viewport} pageIndex={pageIndex} fileHash={fileHash} drawMode={drawMode} />
      )}
    </div>
  );
}
