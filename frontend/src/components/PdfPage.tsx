import React, { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import 'pdfjs-dist/web/pdf_viewer.css';
import OcclusionLayer from './OcclusionLayer';
import { useOcclusionStore, ReviewFilter } from '../store/useOcclusionStore';

interface PdfPageProps {
  pageIndex: number; // 1-based index
  pdfDocument: pdfjsLib.PDFDocumentProxy;
  scale: number;
  fileHash: string;
  drawMode: boolean;
  darkMode: boolean;
  scrollContainerRef: React.RefObject<HTMLDivElement>;
  reviewFilter: ReviewFilter;
}

export default function PdfPage({ pageIndex, pdfDocument, scale, fileHash, drawMode, darkMode, scrollContainerRef, reviewFilter }: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  
  // Track visibility purely imperatively (no useState) to avoid React render cycles on scroll
  const isVisibleRef = useRef(false);
  
  const [viewport, setViewport] = useState<pdfjsLib.PageViewport | null>(null);
  // Cache last-known dimensions so the container never collapses during visibility transitions
  const dimensionsRef = useRef<{ width: number; height: number } | null>(null);

  const bookmarks = useOcclusionStore(state => state.bookmarks);
  const toggleBookmark = useOcclusionStore(state => state.toggleBookmark);
  const isBookmarked = bookmarks.some(b => b.document_id === fileHash && b.page_index === pageIndex && !b.is_deleted);

  const revealAllPages = useOcclusionStore(state => state.revealAllPages);
  const revealAllDocument = useOcclusionStore(state => state.revealAllDocument);
  const revealAll = revealAllDocument || revealAllPages.has(pageIndex);

  // Pre-calculate container dimensions so it doesn't collapse when unmounted
  useEffect(() => {
    let active = true;
    const measure = async () => {
      try {
        const page = await pdfDocument.getPage(pageIndex);
        const vp = page.getViewport({ scale, rotation: page.rotate || 0 });
        if (active) {
          dimensionsRef.current = { width: vp.width, height: vp.height };
          setViewport(vp);
        }
      } catch (e) {}
    };
    measure();
    return () => { active = false; };
  }, [pdfDocument, pageIndex, scale]);

  // Unified IntersectionObserver and Canvas Render Effect (Imperative Only)
  useEffect(() => {
    if (!viewport || !pdfDocument || !canvasRef.current) return;

    let isCancelled = false;
    let renderTask: pdfjsLib.RenderTask | null = null;
    let pageProxy: pdfjsLib.PDFPageProxy | null = null;
    let textLayerInstance: pdfjsLib.TextLayer | null = null;

    const cleanupPage = () => {
      if (renderTask) {
        renderTask.cancel();
        renderTask = null;
      }
      if (textLayerInstance) {
        textLayerInstance.cancel();
        textLayerInstance = null;
      }
      if (pageProxy && typeof (pageProxy as any).cleanup === 'function') {
        (pageProxy as any).cleanup();
        pageProxy = null;
      }
      // Clear the canvas to free up memory from the painted pixels
      if (canvasRef.current) {
        const ctx = canvasRef.current.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }
      // Clear the text layer container
      if (textLayerRef.current) {
        textLayerRef.current.innerHTML = '';
      }
    };

    const renderPage = async () => {
      if (!isVisibleRef.current || !canvasRef.current) return;

      try {
        pageProxy = await pdfDocument.getPage(pageIndex);
        const vp = pageProxy.getViewport({ scale, rotation: pageProxy.rotate || 0 });

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

        // Render the text layer overlay
        if (!isCancelled && textLayerRef.current) {
          textLayerRef.current.innerHTML = '';
          const textContent = await pageProxy.getTextContent();
          
          textLayerInstance = new pdfjsLib.TextLayer({
            textContentSource: textContent,
            container: textLayerRef.current,
            viewport: vp,
          });

          await textLayerInstance.render();
        }
      } catch (err: any) {
        if (!isCancelled && err.name !== 'RenderingCancelledException') {
          console.error(`Page ${pageIndex} render error:`, err);
        }
      }
    };

    const observer = new IntersectionObserver(([entry]) => {
      isVisibleRef.current = entry.isIntersecting;
      if (entry.isIntersecting) {
        renderPage();
      } else {
        cleanupPage();
      }
    }, { root: scrollContainerRef.current, rootMargin: '200% 0px' });

    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      isCancelled = true;
      observer.disconnect();
      cleanupPage();
    };
  }, [viewport, pdfDocument, pageIndex, scale, scrollContainerRef]); 

  // Use cached dimensions for the container to prevent layout shifts on scroll
  const containerWidth = dimensionsRef.current?.width ?? viewport?.width;
  const containerHeight = dimensionsRef.current?.height ?? viewport?.height;

  return (
    <div 
      ref={containerRef} 
      className="pdf-page-wrapper"
      data-page-index={pageIndex}
      style={{ 
        width: containerWidth ? `${containerWidth}px` : '100%', 
        height: containerHeight ? `${containerHeight}px` : '800px',
        position: 'relative',
        ['--scale-factor' as any]: scale,
        ['--total-scale-factor' as any]: scale,
        ['--user-unit' as any]: 1,
      }}
    >
      <button 
        className="page-bookmark-btn" 
        onClick={() => toggleBookmark(fileHash, pageIndex)}
        title={isBookmarked ? "Remove Bookmark" : "Add Bookmark"}
      >
        {isBookmarked ? '★' : '☆'}
      </button>

      {/* Unconditionally rendered, purely imperatively managed */}
      <canvas
        ref={canvasRef}
        className={darkMode ? 'dark-canvas' : ''}
      />
      <div 
        ref={textLayerRef}
        className="textLayer"
      />
      {viewport && (
        <OcclusionLayer viewport={viewport} pageIndex={pageIndex} fileHash={fileHash} drawMode={drawMode} revealAll={revealAll} reviewFilter={reviewFilter} />
      )}
    </div>
  );
}
