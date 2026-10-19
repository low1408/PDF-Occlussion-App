import React, { useState, useRef, useEffect, useMemo } from 'react';
import type * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { useOcclusionStore, Box, SrsGrade, SrsCard, ReviewFilter } from '../store/useOcclusionStore';
import { computeSrs, formatInterval, NEW_CARD } from '../srs';
import Icon from './Icon';

// Mask fill per last grade; the colours are theme tokens in index.css.
const GRADE_COLORS: Record<SrsGrade, string> = {
  easy: 'var(--grade-easy)',
  ok: 'var(--grade-ok)',
  hard: 'var(--grade-hard)',
  impossible: 'var(--grade-impossible)',
};
const DEFAULT_FILL = 'var(--mask-ungraded)'; // no grade yet

const GRADE_BUTTONS: { grade: SrsGrade; key: string; label: string }[] = [
  { grade: 'easy', key: '1', label: 'Easy' },
  { grade: 'ok', key: '2', label: 'OK' },
  { grade: 'hard', key: '3', label: 'Hard' },
  { grade: 'impossible', key: '4', label: 'Impossible' },
];

interface OcclusionLayerProps {
  viewport: pdfjsLib.PageViewport;
  pageIndex: number;
  fileHash: string;
  drawMode: boolean;
  revealAll: boolean;
  reviewFilter: ReviewFilter;
}

const parseNote = (noteStr?: string): { text: string; type: 'occlusion' | 'highlight' } => {
  if (!noteStr) return { text: '', type: 'occlusion' };
  try {
    const parsed = JSON.parse(noteStr);
    if (parsed && typeof parsed === 'object' && parsed.type === 'highlight') {
      return { text: parsed.text || '', type: 'highlight' };
    }
  } catch (e) {}
  return { text: noteStr, type: 'occlusion' };
};

export default function OcclusionLayer({ viewport, pageIndex, fileHash, drawMode, revealAll, reviewFilter }: OcclusionLayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wasDragged = useRef(false);

  const allBoxes = useOcclusionStore(state => state.boxes);
  const addBox = useOcclusionStore(state => state.addBox);
  const deleteBox = useOcclusionStore(state => state.deleteBox);
  const recordGrade = useOcclusionStore(state => state.recordGrade);
  const srsCards = useOcclusionStore(state => state.srsCards);
  const updateBoxNote = useOcclusionStore(state => state.updateBoxNote);
  // Every page mounts a layer, but only the active one may answer review keys.
  const ownsKeyboard = useOcclusionStore(state => state.activeReviewPage === pageIndex);
  const setActiveReviewPage = useOcclusionStore(state => state.setActiveReviewPage);

  const boxes = allBoxes.filter(b => b.document_id === fileHash && b.page_index === pageIndex);

  // Helper: look up SRS card for a given occlusion id.
  const getSrsCard = (boxId: string): SrsCard | undefined =>
    srsCards.find(c => c.occlusion_id === boxId);



  // Helper: get the grade-derived fill color for a box.
  const getGradeColor = (boxId: string): string => {
    const card = getSrsCard(boxId);
    if (!card?.last_grade) return DEFAULT_FILL;
    return GRADE_COLORS[card.last_grade];
  };

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

  // Navigable boxes: sorted + filtered by the active review filter.
  // Arrow-key navigation only cycles through these boxes.
  // getSrsCard/isDue are inline helpers that capture srsCards — since srsCards is already
  // listed as a dep, we suppress the rule to avoid listing the function references themselves.
  const navigableBoxes = useMemo(() => {
    // Exclude highlights from keyboard navigable boxes
    const occlusionsOnly = sortedBoxes.filter(box => {
      const info = parseNote(box.note);
      return info.type !== 'highlight';
    });

    if (reviewFilter === 'all') return occlusionsOnly;
    return occlusionsOnly.filter(box => {
      const card = getSrsCard(box.id);
      switch (reviewFilter) {
        case 'ungraded':    return !card?.last_grade;
        case 'easy':        return card?.last_grade === 'easy';
        case 'ok':          return card?.last_grade === 'ok';
        case 'hard':        return card?.last_grade === 'hard';
        case 'impossible':  return card?.last_grade === 'impossible';
        default:            return true;
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedBoxes, srsCards, reviewFilter]);

  const [, setIsDrawing] = useState(false);
  const [isLassoing, setIsLassoing] = useState(false);
  const [selectedBoxIds, setSelectedBoxIds] = useState<Set<string>>(new Set());
  const [revealedBoxId, setRevealedBoxId] = useState<string | null>(null);
  const [tempBox, setTempBox] = useState<{ x: number, y: number, w: number, h: number } | null>(null);

  // Per-page focus index for keyboard navigation in review mode.
  // null = no mask focused on this page.
  const [focusedBoxIndex, setFocusedBoxIndex] = useState<number | null>(null);

  const [selectionTooltip, setSelectionTooltip] = useState<{ x: number, y: number, text: string, rect: any } | null>(null);
  const [activePopoverBoxId, setActivePopoverBoxId] = useState<string | null>(null);

  // Refs for tracking active drag/lasso states in parent pointer event listeners
  const isDrawingRef = useRef(false);
  const isLassoingRef = useRef(false);
  const startPosRef = useRef<{ x: number, y: number } | null>(null);
  const tempBoxRef = useRef<{ x: number, y: number, w: number, h: number } | null>(null);
  const drawModeRef = useRef(drawMode);
  const boxesRef = useRef(boxes);

  useEffect(() => {
    drawModeRef.current = drawMode;
  }, [drawMode]);

  useEffect(() => {
    boxesRef.current = boxes;
  }, [boxes]);

  // Derive the focused box from the index (guarded against out-of-bounds after deletions/filter changes).
  const focusedBox: Box | null =
    focusedBoxIndex !== null && focusedBoxIndex < navigableBoxes.length
      ? navigableBoxes[focusedBoxIndex]
      : null;

  // Clamp or clear focusedBoxIndex when the navigable list shrinks (e.g., filter changed).
  // focusedBoxIndex is in the deps so we always read the latest value; after setFocusedBoxIndex
  // the next run will find the condition false (index 0 < length) and stop.
  useEffect(() => {
    if (focusedBoxIndex !== null && focusedBoxIndex >= navigableBoxes.length) {
      setFocusedBoxIndex(navigableBoxes.length > 0 ? 0 : null);
    }
  }, [navigableBoxes.length, focusedBoxIndex]);

  // Drop focus, reveal and selection when another page becomes active, so only one
  // page ever shows a grade bar or hint bar.
  useEffect(() => {
    if (ownsKeyboard) return;
    setFocusedBoxIndex(null);
    setRevealedBoxId(null);
    setSelectedBoxIds(prev => (prev.size > 0 ? new Set() : prev));
  }, [ownsKeyboard]);

  // Keep the keyboard-focused mask on screen; on a tall page it can be outside the viewport.
  const focusedBoxId = focusedBox?.id;
  useEffect(() => {
    if (!ownsKeyboard || !focusedBoxId) return;
    containerRef.current
      ?.querySelector(`[data-box-id="${focusedBoxId}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [ownsKeyboard, focusedBoxId]);

  // Advance focus to the next navigable box and hide the current reveal.
  const advanceFocus = (currentIndex: number | null) => {
    if (navigableBoxes.length === 0) return;
    const next = currentIndex === null ? 0 : (currentIndex + 1) % navigableBoxes.length;
    setFocusedBoxIndex(next);
    setRevealedBoxId(null);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't fire when typing in an input
      if ((e.target as HTMLElement)?.tagName === 'INPUT' ||
          (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      if (!ownsKeyboard) return;

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
      if (!drawMode && navigableBoxes.length > 0) {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          setFocusedBoxIndex(prev => {
            const next = prev === null ? 0 : (prev + 1) % navigableBoxes.length;
            return next;
          });
          setRevealedBoxId(null); // hide when navigating away
          return;
        }

        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          // Only go left if already focused (no wrap-around from null)
          if (focusedBoxIndex !== null) {
            const prev = (focusedBoxIndex - 1 + navigableBoxes.length) % navigableBoxes.length;
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
  }, [ownsKeyboard, selectedBoxIds, deleteBox, drawMode, sortedBoxes, navigableBoxes, focusedBox, focusedBoxIndex, revealedBoxId, recordGrade, fileHash]);

  // Hook up event delegation on the parent container (.pdf-page-wrapper)
  useEffect(() => {
    const parent = containerRef.current?.parentElement;
    if (!parent) return;

    const getPointerPosFromParent = (clientX: number, clientY: number) => {
      const rect = parent.getBoundingClientRect();
      return {
        x: clientX - rect.left,
        y: clientY - rect.top,
      };
    };

    const handlePointerDown = (e: PointerEvent) => {
      // Interacting with a page hands it the review keys, even if it isn't the one centred in view.
      setActiveReviewPage(pageIndex);

      const target = e.target as HTMLElement;
      // The tooltip button must survive pointerdown so its click handler can run.
      if (target.closest('.selection-tooltip')) return;

      // Clear selection tooltip when interacting elsewhere on the page.
      setSelectionTooltip(null);

      // If clicking inside the active note popover, let the popover handle it (don't start drag, don't clear popover)
      if (target.closest('.note-popover')) return;

      // If not clicking active popover, clear popover state
      setActivePopoverBoxId(null);

      if (target.classList.contains('occlusion-box') || target.classList.contains('highlight-overlay')) return;
      if (target.closest('.srs-grade-bar') || target.closest('.page-bookmark-btn') || target.closest('.share-controls') || target.closest('.history-controls')) return;

      const isShift = e.shiftKey;
      const shouldStartDrag = drawModeRef.current || isShift;
      if (!shouldStartDrag) return;

      wasDragged.current = false;
      const pos = getPointerPosFromParent(e.clientX, e.clientY);
      startPosRef.current = pos;

      if (drawModeRef.current) {
        if (isShift) {
          setIsLassoing(true);
          isLassoingRef.current = true;
        } else {
          setIsDrawing(true);
          isDrawingRef.current = true;
          setSelectedBoxIds(new Set());
        }
      } else {
        // Review Mode + Shift -> Lasso
        setIsLassoing(true);
        isLassoingRef.current = true;
        setSelectedBoxIds(new Set());
      }

      setRevealedBoxId(null);
      setFocusedBoxIndex(null);

      const initialBox = { x: pos.x, y: pos.y, w: 0, h: 0 };
      setTempBox(initialBox);
      tempBoxRef.current = initialBox;

      parent.setPointerCapture(e.pointerId);
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (!isDrawingRef.current && !isLassoingRef.current) return;
      if (!startPosRef.current) return;

      const currentPos = getPointerPosFromParent(e.clientX, e.clientY);
      const x = Math.min(startPosRef.current.x, currentPos.x);
      const y = Math.min(startPosRef.current.y, currentPos.y);
      const w = Math.abs(currentPos.x - startPosRef.current.x);
      const h = Math.abs(currentPos.y - startPosRef.current.y);

      if (w > 5 || h > 5) {
        wasDragged.current = true;
      }

      const updatedBox = { x, y, w, h };
      setTempBox(updatedBox);
      tempBoxRef.current = updatedBox;
    };

    const handlePointerUp = (e: PointerEvent) => {
      const wasLasso = isLassoingRef.current;
      const wasDraw = isDrawingRef.current;

      isDrawingRef.current = false;
      isLassoingRef.current = false;
      setIsDrawing(false);
      setIsLassoing(false);

      const startPos = startPosRef.current;
      const tempBox = tempBoxRef.current;
      startPosRef.current = null;
      tempBoxRef.current = null;
      setTempBox(null);

      try {
        parent.releasePointerCapture(e.pointerId);
      } catch (err) {}

      if (wasLasso || wasDraw) {
        if (!tempBox || !startPos) return;

        if (wasLasso) {
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
              boxesRef.current.forEach(box => {
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
        } else if (wasDraw) {
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
        return;
      }

      // Check text selection to show tooltip
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        if (parent.contains(sel.anchorNode)) {
          const rect = range.getBoundingClientRect();
          const parentRect = parent.getBoundingClientRect();

          setSelectionTooltip({
            x: rect.left - parentRect.left + rect.width / 2,
            y: rect.top - parentRect.top,
            text: sel.toString().trim(),
            rect: {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
            }
          });
        }
      }
    };

    const handleParentClick = (e: MouseEvent) => {
      if (wasDragged.current) {
        wasDragged.current = false;
        return;
      }

      const target = e.target as HTMLElement;
      if (target.closest('.note-popover')) return;

      if (
        target.classList.contains('occlusion-box') || 
        target.classList.contains('highlight-overlay') ||
        target.closest('.srs-grade-bar') ||
        target.closest('.page-bookmark-btn') ||
        target.closest('.selection-tooltip')
      ) {
        return;
      }

      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        return;
      }

      setSelectedBoxIds(new Set());
      setRevealedBoxId(null);
      setFocusedBoxIndex(null);
      setActivePopoverBoxId(null);
      setSelectionTooltip(null);
    };

    parent.addEventListener('pointerdown', handlePointerDown);
    parent.addEventListener('pointermove', handlePointerMove);
    parent.addEventListener('pointerup', handlePointerUp);
    parent.addEventListener('click', handleParentClick);

    return () => {
      parent.removeEventListener('pointerdown', handlePointerDown);
      parent.removeEventListener('pointermove', handlePointerMove);
      parent.removeEventListener('pointerup', handlePointerUp);
      parent.removeEventListener('click', handleParentClick);
    };
  }, [viewport, fileHash, pageIndex, addBox, setActiveReviewPage]);

  const handleCreateHighlight = () => {
    if (!selectionTooltip) return;
    const parent = containerRef.current?.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();

    const localLeft = selectionTooltip.rect.left - parentRect.left;
    const localTop = selectionTooltip.rect.top - parentRect.top;
    const localRight = selectionTooltip.rect.right - parentRect.left;
    const localBottom = selectionTooltip.rect.bottom - parentRect.top;

    const p1 = viewport.convertToPdfPoint(localLeft, localTop);
    const p2 = viewport.convertToPdfPoint(localRight, localBottom);

    const newBoxId = crypto.randomUUID();
    const newBox: Box = {
      id: newBoxId,
      document_id: fileHash,
      page_index: pageIndex,
      pdfRect: [p1[0], p1[1], p2[0], p2[1]],
      is_deleted: false,
      last_modified: Date.now(),
      note: JSON.stringify({ text: '', type: 'highlight' }),
    };

    addBox(newBox);
    setActivePopoverBoxId(newBoxId);
    setSelectionTooltip(null);
    window.getSelection()?.removeAllRanges();
  };


  const handleBoxClick = (e: React.MouseEvent, boxId: string) => {
    e.stopPropagation();

    const clickedBox = boxesRef.current.find(b => b.id === boxId);
    if (!clickedBox) return;
    const noteInfo = parseNote(clickedBox.note);

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
      setActivePopoverBoxId(null);
    } else {
      if (noteInfo.type === 'highlight') {
        // Highlights: toggle note popover directly on click
        setActivePopoverBoxId(prev => prev === boxId ? null : boxId);
      } else {
        // Occlusion boxes: normal click logic (reveal/unreveal)
        const isRevealed = revealAll || revealedBoxId === boxId;
        if (isRevealed) {
          // Already revealed -> click toggles note popover
          setActivePopoverBoxId(prev => prev === boxId ? null : boxId);
        } else {
          // Reveal it
          setRevealedBoxId(boxId);
          const navIdx = navigableBoxes.findIndex(b => b.id === boxId);
          setFocusedBoxIndex(navIdx >= 0 ? navIdx : null);
          setActivePopoverBoxId(null);
        }
      }
    }
  };

  const handleGrade = (grade: SrsGrade) => {
    if (revealedBoxId) {
      recordGrade(revealedBoxId, fileHash, grade);
    }
    advanceFocus(focusedBoxIndex);
    setSelectedBoxIds(new Set());
  };

  // Show a "0 matches" hint when a filter is active but no masks qualify on this page.
  const shouldShowFilterEmptyHint =
    ownsKeyboard &&
    !drawMode &&
    reviewFilter !== 'all' &&
    navigableBoxes.length === 0 &&
    sortedBoxes.length > 0 &&
    !revealedBoxId &&
    selectedBoxIds.size === 0;

  // Next interval each grade would give the revealed mask, shown on its button.
  const revealedCard = revealedBoxId ? getSrsCard(revealedBoxId) : undefined;
  const nextIntervalLabel = (grade: SrsGrade) => {
    const days = computeSrs(revealedCard ?? NEW_CARD, grade).interval_days;
    return days === 0 ? 'again now' : `next in ${formatInterval(days)}`;
  };

  return (
    <div
      ref={containerRef}
      className="occlusion-layer"
      style={{
        position: 'absolute',
        top: 0, left: 0, right: 0, bottom: 0,
        zIndex: 10,
        cursor: drawMode ? 'crosshair' : 'default',
        pointerEvents: drawMode ? 'auto' : 'none',
        touchAction: drawMode ? 'none' : 'auto'
      }}
    >
      {sortedBoxes.map(box => {
        const rect = viewport.convertToViewportRectangle(box.pdfRect);
        const x = Math.min(rect[0], rect[2]);
        const y = Math.min(rect[1], rect[3]);
        const w = Math.abs(rect[2] - rect[0]);
        const h = Math.abs(rect[3] - rect[1]);

        const noteInfo = parseNote(box.note);
        const isHighlight = noteInfo.type === 'highlight';

        const isRevealed = revealAll || revealedBoxId === box.id;
        const isSelected = selectedBoxIds.has(box.id);
        const isFocused = !drawMode && focusedBox?.id === box.id;
        const isPopoverOpen = activePopoverBoxId === box.id;

        // Looks live in index.css: fill from --mask-color, dashed outline when revealed,
        // pulsing ring when focused, accent stripes when selected in draw mode.
        const className = isHighlight
          ? `highlight-overlay ${isPopoverOpen ? 'active' : ''} ${isSelected ? 'selected' : ''}`
          : `occlusion-box ${isRevealed ? 'revealed' : ''} ${isSelected ? 'selected' : ''} ${isFocused && !isRevealed ? 'focused' : ''}`;

        return (
          <div key={box.id} data-box-id={box.id} style={{ position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` }}>
            <div
              className={className}
              onClick={(e) => handleBoxClick(e, box.id)}
              style={isHighlight ? undefined : { ['--mask-color' as string]: getGradeColor(box.id) }}
            >
              {/* Note indicator for occlusion boxes */}
              {!isHighlight && noteInfo.text && (
                <div className="occlusion-note-indicator" title={noteInfo.text}>
                  ✎
                </div>
              )}
            </div>

            {/* Note Popover overlay */}
            {isPopoverOpen && (
              <div className="note-popover" onClick={e => e.stopPropagation()}>
                <textarea
                  className="note-textarea"
                  placeholder="Type a note or comment..."
                  defaultValue={noteInfo.text}
                  autoFocus
                  onKeyDown={e => {
                    // Prevent key events from bubbling to global hotkeys
                    e.stopPropagation();
                  }}
                  onBlur={(e) => {
                    const newText = e.target.value.trim();
                    const updatedNote = isHighlight
                      ? JSON.stringify({ text: newText, type: 'highlight' })
                      : newText;
                    updateBoxNote(box.id, updatedNote);
                  }}
                />
                <div className="note-actions">
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => {
                      deleteBox(box.id);
                      setActivePopoverBoxId(null);
                    }}
                  >
                    <Icon name="trash" size={14} />
                    Delete
                  </button>
                  <button className="btn btn-sm" onClick={() => setActivePopoverBoxId(null)}>
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {tempBox && (
        <div style={{
          position: 'absolute',
          left: `${tempBox.x}px`, top: `${tempBox.y}px`,
          width: `${tempBox.w}px`, height: `${tempBox.h}px`,
          borderRadius: '3px',
          backgroundColor: isLassoing ? 'var(--accent-soft)' : 'color-mix(in srgb, var(--mask-ungraded) 55%, transparent)',
          border: '2px dashed var(--accent)',
        }} />
      )}

      {/* Grade panel — shown when a box is revealed (click or Space) */}
      {revealedBoxId && !drawMode && (
        <div className="review-dock">
          <div className="srs-grade-bar">
            <div className="srs-grade-hint">
              How well did you remember it? &nbsp;<kbd>1</kbd>–<kbd>4</kbd> to grade · <kbd>←</kbd> <kbd>→</kbd> to move on
            </div>
            <div className="srs-grade-buttons">
              {GRADE_BUTTONS.map(({ grade, key, label }) => (
                <button
                  key={grade}
                  className={`srs-btn srs-${grade}`}
                  onClick={() => handleGrade(grade)}
                  title={`${label} (${key}): ${nextIntervalLabel(grade)}`}
                >
                  <span className="srs-key">{key}</span>
                  <span className="srs-label">{label}</span>
                  <span className="srs-interval">{nextIntervalLabel(grade)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Navigation hint when focused but not yet revealed, and nothing selected */}
      {focusedBox && !revealedBoxId && !drawMode && selectedBoxIds.size === 0 && (
        <div className="review-dock">
          <div className="hint-pill">
            <span><kbd>←</kbd> <kbd>→</kbd> move</span>
            <span className="sep">·</span>
            <span><kbd>Space</kbd> reveal</span>
            <span className="sep">·</span>
            <span className="count">{(focusedBoxIndex ?? 0) + 1} / {navigableBoxes.length}</span>
            {reviewFilter !== 'all' && <span>filtered from {sortedBoxes.length}</span>}
          </div>
        </div>
      )}

      {/* Hint when a filter is active but no masks match on this page */}
      {shouldShowFilterEmptyHint && (
        <div className="review-dock">
          <div className="hint-pill">No masks on this page match the filter</div>
        </div>
      )}

      {/* Delete-selection bar — shown when masks are lasso-selected in review mode */}
      {!drawMode && selectedBoxIds.size > 0 && !revealedBoxId && (
        <div className="review-dock">
          <div className="hint-pill danger">
            <strong>{selectedBoxIds.size} mask{selectedBoxIds.size !== 1 ? 's' : ''} selected</strong>
            <span><kbd>Esc</kbd> to cancel</span>
            <button
              className="btn btn-sm btn-danger"
              onClick={() => {
                selectedBoxIds.forEach(id => deleteBox(id));
                setSelectedBoxIds(new Set());
              }}
            >
              <Icon name="trash" size={14} />
              Delete
            </button>
          </div>
        </div>
      )}

      {/* Floating selection tooltip */}
      {selectionTooltip && (
        <div
          className="selection-tooltip"
          style={{
            left: `${selectionTooltip.x}px`,
            top: `${selectionTooltip.y}px`
          }}
          onClick={e => e.stopPropagation()}
        >
          <button onClick={handleCreateHighlight}>
            <Icon name="pencil" size={14} />
            Highlight &amp; note
          </button>
        </div>
      )}
    </div>
  );
}
