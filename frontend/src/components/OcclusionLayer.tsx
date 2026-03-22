import React, { useState, useRef, useEffect } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { useOcclusionStore, Box } from '../store/useOcclusionStore';

interface OcclusionLayerProps {
  viewport: pdfjsLib.PageViewport;
  pageIndex: number;
  fileHash: string;
}

export default function OcclusionLayer({ viewport, pageIndex, fileHash }: OcclusionLayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  
  const allBoxes = useOcclusionStore(state => state.boxes);
  const addBox = useOcclusionStore(state => state.addBox);
  const deleteBox = useOcclusionStore(state => state.deleteBox);
  
  const boxes = allBoxes.filter(b => b.document_id === fileHash && b.page_index === pageIndex);

  const [isDrawing, setIsDrawing] = useState(false);
  const [selectedBoxId, setSelectedBoxId] = useState<string | null>(null);
  const [startPos, setStartPos] = useState<{ x: number, y: number } | null>(null);
  const [tempBox, setTempBox] = useState<{ x: number, y: number, w: number, h: number } | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedBoxId) {
        deleteBox(selectedBoxId);
        setSelectedBoxId(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedBoxId, deleteBox]);

  const getPointerPos = (e: React.PointerEvent) => {
    if (!containerRef.current) return { x: 0, y: 0 };
    const rect = containerRef.current.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.target !== containerRef.current && (e.target as HTMLElement).className !== 'occlusion-layer') return;
    const pos = getPointerPos(e);
    setIsDrawing(true);
    setSelectedBoxId(null);
    setStartPos(pos);
    setTempBox({ x: pos.x, y: pos.y, w: 0, h: 0 });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDrawing || !startPos) return;
    const currentPos = getPointerPos(e);
    const x = Math.min(startPos.x, currentPos.x);
    const y = Math.min(startPos.y, currentPos.y);
    const w = Math.abs(currentPos.x - startPos.x);
    const h = Math.abs(currentPos.y - startPos.y);
    setTempBox({ x, y, w, h });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!isDrawing || !tempBox || !startPos) return;
    setIsDrawing(false);
    
    // Only save if it has a minimum size
    if (tempBox.w > 5 && tempBox.h > 5) {
      // Convert screen px to PDF coordinates directly
      const p1 = viewport.convertToPdfPoint(tempBox.x, tempBox.y);
      const p2 = viewport.convertToPdfPoint(tempBox.x + tempBox.w, tempBox.y + tempBox.h);
      
      const newBox: Box = {
        id: crypto.randomUUID(),
        document_id: fileHash,
        page_index: pageIndex,
        pdfRect: [p1[0], p1[1], p2[0], p2[1]],
        is_deleted: false,
        last_modified: Date.now()
      };
      
      addBox(newBox);
    }
    setTempBox(null);
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div 
      ref={containerRef}
      className="occlusion-layer"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{
        position: 'absolute',
        top: 0, left: 0, right: 0, bottom: 0,
        zIndex: 10,
        cursor: 'crosshair',
        touchAction: 'none'
      }}
    >
      {boxes.filter(b => !b.is_deleted).map(box => {
        // Convert PDF coordinates back to screen pixels using current viewport
        const rect = viewport.convertToViewportRectangle(box.pdfRect);
        const x = Math.min(rect[0], rect[2]);
        const y = Math.min(rect[1], rect[3]);
        const w = Math.abs(rect[2] - rect[0]);
        const h = Math.abs(rect[3] - rect[1]);

        return (
          <div 
            key={box.id}
            className="occlusion-box"
            onClick={(e) => { e.stopPropagation(); setSelectedBoxId(box.id); }}
            style={{
              position: 'absolute',
              left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`,
              backgroundColor: '#111827',
              borderRadius: '2px',
              border: selectedBoxId === box.id ? '2px solid #ef4444' : '2px solid #fbbf24',
              opacity: 0.95,
              cursor: 'pointer'
            }}
          />
        );
      })}

      {tempBox && (
        <div style={{
          position: 'absolute',
          left: `${tempBox.x}px`, top: `${tempBox.y}px`, 
          width: `${tempBox.w}px`, height: `${tempBox.h}px`,
          backgroundColor: 'rgba(17, 24, 39, 0.5)',
          border: '2px dashed #fbbf24'
        }} />
      )}
    </div>
  );
}
