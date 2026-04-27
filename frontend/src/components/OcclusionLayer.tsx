import React, { useState, useRef, useEffect, useMemo } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { useOcclusionStore, Box, SrsGrade } from '../store/useOcclusionStore';

interface OcclusionLayerProps {
  viewport: pdfjsLib.PageViewport;
  pageIndex: number;
  fileHash: string;
  drawMode: boolean;
  revealAll: boolean;
}

export default function OcclusionLayer({ viewport, pageIndex, fileHash, drawMode, revealAll }: OcclusionLayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wasDragged = useRef(false);
  // In review mode, we store the pointer id here so we can call setPointerCapture
  // only after we confirm a real drag (movement > 5px). This keeps plain clicks
  // fully intact — handleBoxClick still fires normally.
  const pendingPointerIdRef = useRef<number | null>(null);

  const allBoxes = useOcclusionStore(state => state.boxes);
  const addBox = useOcclusionStore(state => state.addBox);
  const deleteBox = useOcclusionStore(state => state.deleteBox);
  const recordGrade = useOcclusionStore(state => state.recordGrade);

  const boxes = allBoxes.filter(b => b.document_id === fileHash && b.page_index === pageIndex);

  // Boxes sorted in reading order (top → bottom) using viewport screen coordinates.
  // viewport.convertToViewportRectangle maps PDF space (y from bottom) → screen space (y from top).
  const sortedBoxes = useMemo(() => {
    return boxes
      .filter(b => !b.is_deleted)
      .sort((a, b) => {
        const aRect = viewport.convertToViewportRectangle(a.pdfRect);
        const bRect = viewport.convertToViewportRectangle(b.pdfRect);
        const aTop = Math.min(aRect[1], aRect[3]);
        const bTop = Math.min(bRect[1], bRect[3]);
        return aTop - bTop;
      });
  }, [boxes, viewport]);

  const [isDrawing, setIsDrawing] = useState(false);
  const [isLassoing, setIsLassoing] = useState(false);
  const [selectedBoxIds, setSelectedBoxIds] = useState<Set<string>>(new Set());
  const [revealedBoxId, setRevealedBoxId] = useState<string | null>(null);
  const [startPos, setStartPos] = useState<{ x: number, y: number } | null>(null);
  const [tempBox, setTempBox] = useState<{ x: number, y: number, w: number, h: number } | null>(null);

  // Per-page focus index for keyboard navigation in review mode.
  // null = no mask focused on this page.
  const [focusedBoxIndex, setFocusedBoxIndex] = useState<number | null>(null);

  // Derive the focused box from the index (guarded against out-of-bounds after deletions).
  const focusedBox: Box | null =
    focusedBoxIndex !== null && focusedBoxIndex < sortedBoxes.length
      ? sortedBoxes[focusedBoxIndex]
      : null;

  // Advance focus to the next box and hide the current reveal.
  const advanceFocus = (currentIndex: number | null) => {
    if (sortedBoxes.length === 0) return;
    const next = currentIndex === null ? 0 : (currentIndex + 1) % sortedBoxes.length;
    setFocusedBoxIndex(next);
    setRevealedBoxId(null);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't fire when typing in an input
      if ((e.target as HTMLElement)?.tagName === 'INPUT' ||
          (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;

      // --- Delete selected masks (works in both modes) ---
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedBoxIds.size > 0) {
        selectedBoxIds.forEach(id => deleteBox(id));
        setSelectedBoxIds(new Set());
        setRevealedBoxId(null);
        return;
      }

      if (e.key === 'Escape') {
        setSelectedBoxIds(new Set());
        setRevealedBoxId(null);
        setFocusedBoxIndex(null);
        return;
      }

      // --- Review mode keyboard navigation ---
      // Only respond if this page has focus established (focusedBoxIndex !== null)
      // OR if it's the first press of ArrowRight (starts focus at index 0).
      if (!drawMode && sortedBoxes.length > 0) {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          setFocusedBoxIndex(prev => {
            const next = prev === null ? 0 : (prev + 1) % sortedBoxes.length;
            return next;
          });
          setRevealedBoxId(null); // hide when navigating away
          return;
        }

        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          // Only go left if already focused (no wrap-around from null)
          if (focusedBoxIndex !== null) {
            const prev = (focusedBoxIndex - 1 + sortedBoxes.length) % sortedBoxes.length;
            setFocusedBoxIndex(prev);
            setRevealedBoxId(null);
          }
          return;
        }

        // Space: toggle reveal of focused box
        if (e.key === ' ' && focusedBox) {
          e.preventDefault();
          setRevealedBoxId(prev => (prev === focusedBox.id ? null : focusedBox.id));
          return;
        }

        // 1/2/3/4: grade the currently revealed focused box, then auto-advance
        if (focusedBox && revealedBoxId === focusedBox.id) {
          const gradeMap: Record<string, SrsGrade> = {
            '1': 'easy',
            '2': 'ok',
            '3': 'hard',
            '4': 'impossible',
          };
          const grade = gradeMap[e.key];
          if (grade) {
            e.preventDefault();
            recordGrade(focusedBox.id, fileHash, grade);
            advanceFocus(focusedBoxIndex);
            return;
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedBoxIds, deleteBox, drawMode, sortedBoxes, focusedBox, focusedBoxIndex, revealedBoxId, recordGrade, fileHash]);

  const getPointerPos = (e: React.PointerEvent) => {
    if (!containerRef.current) return { x: 0, y: 0 };
    const rect = containerRef.current.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    wasDragged.current = false;

    if (drawMode) {
      // Draw mode: Shift+drag = lasso, plain drag = draw new box
      if (e.target !== containerRef.current && (e.target as HTMLElement).classList.contains('occlusion-box')) return;
      const pos = getPointerPos(e);
      if (e.shiftKey) {
        setIsLassoing(true);
      } else {
        setIsDrawing(true);
        setSelectedBoxIds(new Set());
      }
      setRevealedBoxId(null);
      setStartPos(pos);
      setTempBox({ x: pos.x, y: pos.y, w: 0, h: 0 });
      e.currentTarget.setPointerCapture(e.pointerId);
    } else {
      // Review mode: just record where the potential drag started.
      // Do NOT capture, do NOT set isLassoing, do NOT clear revealedBoxId yet.
      // We only commit to a lasso once handlePointerMove confirms movement > 5px.
      // This ensures plain clicks still reach handleBoxClick untouched.
      pendingPointerIdRef.current = e.pointerId;
      setStartPos(getPointerPos(e));
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDrawing && !isLassoing) {
      // Review mode: check if we've moved enough to commit to a lasso
      if (!drawMode && pendingPointerIdRef.current !== null && startPos) {
        const currentPos = getPointerPos(e);
        const w = Math.abs(currentPos.x - startPos.x);
        const h = Math.abs(currentPos.y - startPos.y);
        if (w > 5 || h > 5) {
          // Confirmed drag — now start the lasso
          wasDragged.current = true;
          setIsLassoing(true);
          setRevealedBoxId(null);
          setFocusedBoxIndex(null);
          setTempBox({
            x: Math.min(startPos.x, currentPos.x),
            y: Math.min(startPos.y, currentPos.y),
            w,
            h,
          });
          // Capture the pointer now that we know it's a real drag
          e.currentTarget.setPointerCapture(pendingPointerIdRef.current);
          pendingPointerIdRef.current = null;
        }
      }
      return;
    }
    const currentPos = getPointerPos(e);
    const x = Math.min(startPos.x, currentPos.x);
    const y = Math.min(startPos.y, currentPos.y);
    const w = Math.abs(currentPos.x - startPos.x);
    const h = Math.abs(currentPos.y - startPos.y);
    if (w > 5 || h > 5) wasDragged.current = true;
    setTempBox({ x, y, w, h });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    // Clear any pending review-mode drag tracker (covers the case where the
    // pointer was released before movement exceeded the 5px threshold — i.e. a plain click).
    pendingPointerIdRef.current = null;

    if ((!isDrawing && !isLassoing) || !tempBox || !startPos) return;

    if (isLassoing) {
      setIsLassoing(false);
      if (tempBox.w > 5 && tempBox.h > 5) {
        const tempPdfRect = [
          viewport.convertToPdfPoint(tempBox.x, tempBox.y),
          viewport.convertToPdfPoint(tempBox.x + tempBox.w, tempBox.y + tempBox.h)
        ];
        const lassoXMin = Math.min(tempPdfRect[0][0], tempPdfRect[1][0]);
        const lassoXMax = Math.max(tempPdfRect[0][0], tempPdfRect[1][0]);
        const lassoYMin = Math.min(tempPdfRect[0][1], tempPdfRect[1][1]);
        const lassoYMax = Math.max(tempPdfRect[0][1], tempPdfRect[1][1]);

        setSelectedBoxIds(prev => {
          const next = new Set(prev);
          boxes.forEach(box => {
            if (box.is_deleted) return;
            const bXMin = Math.min(box.pdfRect[0], box.pdfRect[2]);
            const bXMax = Math.max(box.pdfRect[0], box.pdfRect[2]);
            const bYMin = Math.min(box.pdfRect[1], box.pdfRect[3]);
            const bYMax = Math.max(box.pdfRect[1], box.pdfRect[3]);
            if (bXMin <= lassoXMax && bXMax >= lassoXMin && bYMin <= lassoYMax && bYMax >= lassoYMin) {
              next.add(box.id);
            }
          });
          return next;
        });
      }
    } else {
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
    }
    setTempBox(null);
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const handleBoxClick = (e: React.MouseEvent, boxId: string) => {
    e.stopPropagation();

    if (drawMode) {
      // Selection logic for deletion
      setSelectedBoxIds(prev => {
        const next = new Set(prev);
        if (next.has(boxId)) {
          next.delete(boxId);
        } else {
          next.add(boxId);
        }
        return next;
      });
      setRevealedBoxId(null);
    } else {
      // Clicking a box in review mode: set focus to that box AND toggle reveal.
      // This establishes page focus so arrow keys start working here.
      const idx = sortedBoxes.findIndex(b => b.id === boxId);
      if (idx >= 0) setFocusedBoxIndex(idx);
      setRevealedBoxId(prev => (prev === boxId ? null : boxId));
    }
  };

  const handleGrade = (grade: SrsGrade) => {
    if (revealedBoxId) {
      recordGrade(revealedBoxId, fileHash, grade);
    }
    advanceFocus(focusedBoxIndex);
    setSelectedBoxIds(new Set());
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
        if (wasDragged.current) return;
        setSelectedBoxIds(new Set());
        setRevealedBoxId(null);
        setFocusedBoxIndex(null);
      }}
    >
      {sortedBoxes.map(box => {
        const rect = viewport.convertToViewportRectangle(box.pdfRect);
        const x = Math.min(rect[0], rect[2]);
        const y = Math.min(rect[1], rect[3]);
        const w = Math.abs(rect[2] - rect[0]);
        const h = Math.abs(rect[3] - rect[1]);

        const isRevealed = revealAll || revealedBoxId === box.id;
        const isSelected = selectedBoxIds.has(box.id);
        const isFocused = !drawMode && focusedBox?.id === box.id;

        const getBorderColor = () => {
          if (drawMode && isSelected) return '#ef4444'; // Red for deletion
          if (isRevealed) return '#22c55e';             // Green for revealed
          if (isFocused) return '#60a5fa';              // Blue for focused
          return '#fbbf24';                             // Yellow default
        };

        return (
          <div key={box.id} style={{ position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` }}>
            <div
              className={`occlusion-box ${isRevealed ? 'revealed' : ''} ${isSelected ? 'selected' : ''} ${isFocused && !isRevealed ? 'focused' : ''}`}
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
                boxShadow: isFocused && !isRevealed ? '0 0 0 3px rgba(96, 165, 250, 0.4)' : undefined,
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
          backgroundColor: isLassoing ? 'rgba(59, 130, 246, 0.2)' : 'rgba(17, 24, 39, 0.7)',
          border: `2px dashed ${isLassoing ? '#3b82f6' : '#fbbf24'}`
        }} />
      )}

      {/* Grade bar — shown when a box is revealed (click or Space) */}
      {revealedBoxId && !drawMode && (
        <div className="srs-grade-bar" style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'stretch',
          gap: '12px',
          zIndex: 9999,
          pointerEvents: 'auto',
          backgroundColor: '#1f2937',
          padding: '16px 24px',
          boxShadow: '0 -4px 12px rgba(0, 0, 0, 0.2)'
        }}>
          {/* Navigation hint */}
          <div style={{
            position: 'absolute',
            top: '8px',
            left: '50%',
            transform: 'translateX(-50%)',
            fontSize: '0.72rem',
            color: '#64748b',
            whiteSpace: 'nowrap',
            letterSpacing: '0.04em',
          }}>
            ← → navigate &nbsp;·&nbsp; Space reveal &nbsp;·&nbsp; 1 Easy &nbsp; 2 OK &nbsp; 3 Hard &nbsp; 4 Impossible
          </div>
          <button className="srs-btn srs-easy"   onClick={() => handleGrade('easy')}>
            <span className="srs-key">1</span> Easy
          </button>
          <button className="srs-btn srs-ok"     onClick={() => handleGrade('ok')}>
            <span className="srs-key">2</span> OK
          </button>
          <button className="srs-btn srs-hard"   onClick={() => handleGrade('hard')}>
            <span className="srs-key">3</span> Hard
          </button>
          <button className="srs-btn srs-impossible" onClick={() => handleGrade('impossible')}>
            <span className="srs-key">4</span> Impossible
          </button>
        </div>
      )}

      {/* Navigation hint when focused but not yet revealed, and nothing selected */}
      {focusedBox && !revealedBoxId && !drawMode && selectedBoxIds.size === 0 && (
        <div style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: '16px',
          zIndex: 9999,
          pointerEvents: 'none',
          backgroundColor: 'rgba(31, 41, 55, 0.92)',
          padding: '10px 24px',
          fontSize: '0.8rem',
          color: '#94a3b8',
          letterSpacing: '0.04em',
        }}>
          <span>
            <kbd className="nav-kbd">←</kbd><kbd className="nav-kbd">→</kbd> navigate
          </span>
          <span>·</span>
          <span><kbd className="nav-kbd">Space</kbd> reveal</span>
          <span>·</span>
          <span style={{ color: '#60a5fa' }}>
            {sortedBoxes.findIndex(b => b.id === focusedBox.id) + 1} / {sortedBoxes.length}
          </span>
        </div>
      )}

      {/* Delete-selection bar — shown when masks are lasso-selected in review mode */}
      {!drawMode && selectedBoxIds.size > 0 && !revealedBoxId && (
        <div style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: '16px',
          zIndex: 9999,
          backgroundColor: '#1f2937',
          borderTop: '2px solid #ef4444',
          padding: '14px 24px',
          boxShadow: '0 -4px 12px rgba(0,0,0,0.25)',
          animation: 'fadeInUp 0.15s ease-out',
        }}>
          <span style={{ color: '#f87171', fontWeight: 600, fontSize: '0.95rem' }}>
            {selectedBoxIds.size} mask{selectedBoxIds.size !== 1 ? 's' : ''} selected
          </span>
          <button
            onClick={() => {
              selectedBoxIds.forEach(id => deleteBox(id));
              setSelectedBoxIds(new Set());
            }}
            style={{
              background: '#ef4444',
              border: 'none',
              color: 'white',
              padding: '8px 20px',
              borderRadius: '6px',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.9rem',
              transition: 'filter 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.filter = 'brightness(1.15)')}
            onMouseLeave={e => (e.currentTarget.style.filter = '')}
          >
            🗑️ Delete
          </button>
          <span style={{ color: '#64748b', fontSize: '0.8rem' }}>
            or <kbd className="nav-kbd">Del</kbd> · <kbd className="nav-kbd">Esc</kbd> to cancel
          </span>
        </div>
      )}
    </div>
  );
}
