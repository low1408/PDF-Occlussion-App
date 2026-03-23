import React, { useState, useRef, useEffect } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { useOcclusionStore, Box } from '../store/useOcclusionStore';

interface OcclusionLayerProps {
  viewport: pdfjsLib.PageViewport;
  pageIndex: number;
  fileHash: string;
  drawMode: boolean;
}

type SrsGrade = 'easy' | 'ok' | 'hard' | 'impossible';

export default function OcclusionLayer({ viewport, pageIndex, fileHash, drawMode }: OcclusionLayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const allBoxes = useOcclusionStore(state => state.boxes);
  const addBox = useOcclusionStore(state => state.addBox);
  const deleteBox = useOcclusionStore(state => state.deleteBox);

  const boxes = allBoxes.filter(b => b.document_id === fileHash && b.page_index === pageIndex);

  const [isDrawing, setIsDrawing] = useState(false);
  const [selectedBoxId, setSelectedBoxId] = useState<string | null>(null);
  const [revealedBoxId, setRevealedBoxId] = useState<string | null>(null);
  const [startPos, setStartPos] = useState<{ x: number, y: number } | null>(null);
  const [tempBox, setTempBox] = useState<{ x: number, y: number, w: number, h: number } | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedBoxId) {
        deleteBox(selectedBoxId);
        setSelectedBoxId(null);
        setRevealedBoxId(null);
      }
      if (e.key === 'Escape') {
        setSelectedBoxId(null);
        setRevealedBoxId(null);
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
    if (!drawMode) return;
    if (e.target !== containerRef.current && (e.target as HTMLElement).classList.contains('occlusion-box')) return;
    const pos = getPointerPos(e);
    setIsDrawing(true);
    setSelectedBoxId(null);
    setRevealedBoxId(null);
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

    if (tempBox.w > 5 && tempBox.h > 5) {
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

  const handleBoxClick = (e: React.MouseEvent, boxId: string) => {
    e.stopPropagation();
    
    if (drawMode) {
      // Selection logic for deletion
      setSelectedBoxId(prev => prev === boxId ? null : boxId);
      setRevealedBoxId(null);
    } else {
      // Reveal logic for SRS review
      setRevealedBoxId(prev => {
        const isRevealing = prev !== boxId;
        return isRevealing ? boxId : null;
      });
    }
  };

  const handleGrade = (grade: SrsGrade) => {
    // TODO: Store grade in SRS system
    console.log(`Graded box ${revealedBoxId} as: ${grade}`);
    setRevealedBoxId(null);
    setSelectedBoxId(null);
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
        cursor: drawMode ? 'crosshair' : 'default',
        pointerEvents: 'auto',
        touchAction: drawMode ? 'none' : 'auto'
      }}
      onClick={() => {
        setSelectedBoxId(null);
        setRevealedBoxId(null);
      }}
    >
      {boxes.filter(b => !b.is_deleted).map(box => {
        const rect = viewport.convertToViewportRectangle(box.pdfRect);
        const x = Math.min(rect[0], rect[2]);
        const y = Math.min(rect[1], rect[3]);
        const w = Math.abs(rect[2] - rect[0]);
        const h = Math.abs(rect[3] - rect[1]);

        const isRevealed = revealedBoxId === box.id;
        const isSelected = selectedBoxId === box.id;

        const getBorderColor = () => {
          if (drawMode && isSelected) return '#ef4444'; // Red for deletion
          if (isRevealed) return '#22c55e';             // Green for revealed
          return '#fbbf24';                             // Yellow default
        };

        return (
          <div key={box.id} style={{ position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` }}>
            <div
              className={`occlusion-box ${isRevealed ? 'revealed' : ''} ${isSelected ? 'selected' : ''}`}
              onClick={(e) => handleBoxClick(e, box.id)}
              style={{
                position: 'absolute',
                inset: 0,
                backgroundColor: isRevealed ? 'transparent' : '#111827',
                borderRadius: '2px',
                border: `2px solid ${getBorderColor()}`,
                opacity: 1,
                cursor: 'pointer',
                pointerEvents: 'auto',
                transition: 'background-color 0.2s ease, border-color 0.2s ease',
              }}
            />
            


          </div>
        );
      })}

      {tempBox && (
        <div style={{
          position: 'absolute',
          left: `${tempBox.x}px`, top: `${tempBox.y}px`,
          width: `${tempBox.w}px`, height: `${tempBox.h}px`,
          backgroundColor: 'rgba(17, 24, 39, 0.7)',
          border: '2px dashed #fbbf24'
        }} />
      )}

      {revealedBoxId && !drawMode && (
        <div className="srs-grade-bar" style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          gap: '16px',
          zIndex: 9999,
          pointerEvents: 'auto',
          backgroundColor: '#1f2937',
          padding: '24px',
          boxShadow: '0 -4px 12px rgba(0, 0, 0, 0.2)'
        }}>
          <button className="srs-btn srs-easy" style={{ padding: '16px 32px', fontSize: '1.2rem', fontWeight: 'bold', borderRadius: '8px', flex: 1, maxWidth: '200px' }} onClick={() => handleGrade('easy')}>Easy</button>
          <button className="srs-btn srs-ok" style={{ padding: '16px 32px', fontSize: '1.2rem', fontWeight: 'bold', borderRadius: '8px', flex: 1, maxWidth: '200px' }} onClick={() => handleGrade('ok')}>OK</button>
          <button className="srs-btn srs-hard" style={{ padding: '16px 32px', fontSize: '1.2rem', fontWeight: 'bold', borderRadius: '8px', flex: 1, maxWidth: '200px' }} onClick={() => handleGrade('hard')}>Hard</button>
          <button className="srs-btn srs-impossible" style={{ padding: '16px 32px', fontSize: '1.2rem', fontWeight: 'bold', borderRadius: '8px', flex: 1, maxWidth: '200px' }} onClick={() => handleGrade('impossible')}>Impossible</button>
        </div>
      )}
    </div>
  );
}
