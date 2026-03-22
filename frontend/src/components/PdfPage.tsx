import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import OcclusionLayer from './OcclusionLayer';

interface PdfPageProps {
  pageIndex: number; // 1-based index
  pdfDocument: pdfjsLib.PDFDocumentProxy;
  scale: number;
  fileHash: string;
}

export default function PdfPage({ pageIndex, pdfDocument, scale, fileHash }: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [viewport, setViewport] = useState<pdfjsLib.PageViewport | null>(null);

  // IntersectionObserver for Virtualization
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      setIsVisible(entry.isIntersecting);
    }, { rootMargin: '100% 0px' }); // Load 1 viewport worth of pages ahead

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
        // Single source of truth: PDF.js generates viewport with correct translation for rotation
        const vp = pageProxy.getViewport({ scale, rotation: pageProxy.rotate || 0 });
        setViewport(vp);

        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return;

        // DevicePixelRatio for high-res screens
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
      }}
    >
      {isVisible && <canvas ref={canvasRef} />}
      {isVisible && viewport && (
        <OcclusionLayer viewport={viewport} pageIndex={pageIndex} fileHash={fileHash} />
      )}
    </div>
  );
}
