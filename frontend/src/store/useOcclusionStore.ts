import { create } from 'zustand';
import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { API_URL } from '../api';

export interface Box {
  id: string;
  document_id: string;
  page_index: number;
  pdfRect: [number, number, number, number];
  is_deleted: boolean;
  last_modified: number;
  note?: string;
}

export interface Bookmark {
  id: string;
  document_id: string;
  page_index: number;
  title: string;
  created_at: number;
  // Optional because bookmarks saved before soft-delete existed don't have them.
  is_deleted?: boolean;
  last_modified?: number;
}

export interface SrsCard {
  occlusion_id: string;
  document_id: string;
  ease_factor: number;
  interval_days: number;
  repetitions: number;
  next_review_at: string;
  last_modified: number;
  /** The grade recorded in the most recent review session. */
  last_grade?: SrsGrade;
  /** Total number of times this card has been graded. */
  review_count: number;
  /** True once the card has ever been graded 'impossible'; never resets to false. */
  ever_impossible: boolean;
}

/** Filter mode for review-mode arrow-key navigation — based solely on last grade. */
export type ReviewFilter =
  | 'all'
  | 'ungraded'     // no grade recorded yet (black)
  | 'easy'
  | 'ok'
  | 'hard'
  | 'impossible';

export type SrsGrade = 'easy' | 'ok' | 'hard' | 'impossible';

const GRADE_MAP: Record<SrsGrade, number> = { easy: 5, ok: 3, hard: 1, impossible: 0 };

function computeSrs(card: Pick<SrsCard, 'ease_factor' | 'interval_days' | 'repetitions'>, grade: SrsGrade) {
  const q = GRADE_MAP[grade];
  let ef = card.ease_factor;
  let interval = card.interval_days;
  let reps = card.repetitions;

  ef = ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (ef < 1.3) ef = 1.3;

  if (q < 3) {
    reps = 0;
    interval = 0;
  } else {
    reps += 1;
    if (reps === 1) interval = 1;
    else if (reps === 2) interval = 6;
    else interval = Math.round(interval * ef);
  }

  const nextReview = new Date();
  nextReview.setDate(nextReview.getDate() + interval);

  return {
    ease_factor: Math.round(ef * 100) / 100,
    interval_days: interval,
    repetitions: reps,
    next_review_at: nextReview.toISOString(),
  };
}

export interface HistoryPatch {
  id: string;
  oldRef: Box | null;
  newRef: Box | null;
}

export interface PatchGroup {
  patches: HistoryPatch[];
}

/**
 * Apply one side of a patch group (oldRef for undo, newRef for redo).
 * Touched boxes get a fresh last_modified so the backend's last-write-wins upsert
 * accepts them, and a box that shouldn't exist is tombstoned rather than removed
 * so the deletion still reaches the backend.
 */
function applyPatches(boxes: Box[], patches: HistoryPatch[], side: 'oldRef' | 'newRef') {
  const now = Date.now();
  const next = [...boxes];
  const changed: Box[] = [];
  for (const p of patches) {
    const idx = next.findIndex(b => b.id === p.id);
    const target = p[side];
    const box = target
      ? { ...target, last_modified: now }
      : idx >= 0 ? { ...next[idx], is_deleted: true, last_modified: now } : null;
    if (!box) continue;
    if (idx >= 0) next[idx] = box;
    else next.push(box);
    changed.push(box);
  }
  return { boxes: next, changed };
}

export interface RecentPdfEntry {
  fileHash: string;
  fileName: string;
  fileSize: number;
  numPages: number;
  lastViewedPage: number;
  lastOpenedAt: number;
  pdfData: ArrayBuffer;
}

interface OcclusionDB extends DBSchema {
  occlusions: {
    key: string;
    value: Box;
    indexes: { 'by-doc': string };
  };
  bookmarks: {
    key: string;
    value: Bookmark;
    indexes: { 'by-doc': string };
  };
  srs_cards: {
    key: string;
    value: SrsCard;
    indexes: { 'by-doc': string };
  };
  recent_pdfs: {
    key: string;
    value: RecentPdfEntry;
    indexes: { 'by-lastOpened': number };
  };
}

export let dbPromise: Promise<IDBPDatabase<OcclusionDB>> | null = null;
let idbQueue: Promise<void> = Promise.resolve();
if (typeof window !== 'undefined') {
  dbPromise = openDB<OcclusionDB>('occlusion_engine', 4, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const store = db.createObjectStore('occlusions', { keyPath: 'id' });
        store.createIndex('by-doc', 'document_id');
      }
      if (oldVersion < 2) {
        const bStore = db.createObjectStore('bookmarks', { keyPath: 'id' });
        bStore.createIndex('by-doc', 'document_id');
      }
      if (oldVersion < 3) {
        const srsStore = db.createObjectStore('srs_cards', { keyPath: 'occlusion_id' });
        srsStore.createIndex('by-doc', 'document_id');
      }
      if (oldVersion < 4) {
        const recentStore = db.createObjectStore('recent_pdfs', { keyPath: 'fileHash' });
        recentStore.createIndex('by-lastOpened', 'lastOpenedAt');
      }
    },
  });
}

interface State {
  boxes: Box[];
  history: PatchGroup[];
  historyIndex: number;
  bookmarks: Bookmark[];
  srsCards: SrsCard[];

  // Reveal-all state (ephemeral, not persisted)
  revealAllPages: Set<number>;   // page indices with all occlusions revealed
  revealAllDocument: boolean;     // true = every page is revealed

  // Page whose masks answer review-mode keys (null until a page is shown)
  activeReviewPage: number | null;

  loadBoxesForDocument: (documentId: string) => Promise<void>;
  addBox: (box: Box) => void;
  updateBox: (id: string, updates: Partial<Box>) => void;
  updateBoxNote: (id: string, note: string) => void;
  deleteBox: (id: string) => void;
  undo: () => void;
  redo: () => void;

  toggleBookmark: (documentId: string, pageIndex: number, title?: string) => Promise<void>;
  recordGrade: (occlusionId: string, documentId: string, grade: SrsGrade) => void;

  toggleRevealAllForPage: (pageIndex: number) => void;
  toggleRevealAllForDocument: () => void;
  setActiveReviewPage: (pageIndex: number) => void;

  _saveToIDB: (boxesToSave: Box[]) => Promise<void>;
  _saveSrsCardToIDB: (card: SrsCard) => Promise<void>;
}

export const useOcclusionStore = create<State>((set, get) => ({
  boxes: [],
  history: [],
  historyIndex: -1,
  bookmarks: [],
  srsCards: [],
  revealAllPages: new Set<number>(),
  revealAllDocument: false,
  activeReviewPage: null,

  loadBoxesForDocument: async (documentId: string) => {
    if (!dbPromise) return;
    const db = await dbPromise;
    const allBoxes = await db.getAllFromIndex('occlusions', 'by-doc', documentId);
    const bookmarks = await db.getAllFromIndex('bookmarks', 'by-doc', documentId);
    const srsCards = await db.getAllFromIndex('srs_cards', 'by-doc', documentId);
    set({ boxes: allBoxes, history: [], historyIndex: -1, bookmarks, srsCards });
  },

  _saveToIDB: async (boxesToSave: Box[]) => {
    if (!dbPromise || boxesToSave.length === 0) return;
    idbQueue = idbQueue.then(async () => {
      const db = await dbPromise;
      if (!db) return;
      const tx = db.transaction('occlusions', 'readwrite');
      for (const b of boxesToSave) {
        tx.store.put(b);
      }
      await tx.done;
    }).catch(console.error);
    await idbQueue;
  },

  addBox: (box: Box) => {
    set((state) => {
      const newBoxes = [...state.boxes, box];
      const newHistory = state.history.slice(0, Math.max(0, state.historyIndex + 1));
      newHistory.push({ patches: [{ id: box.id, oldRef: null, newRef: box }] });
      if (newHistory.length > 20) newHistory.shift();

      return {
        boxes: newBoxes,
        history: newHistory,
        historyIndex: newHistory.length - 1
      };
    });
    get()._saveToIDB([box]);
  },

  updateBox: (id: string, updates: Partial<Box>) => {
    let updatedBox: Box | null = null;
    set((state) => {
      let oldBox = state.boxes.find(b => b.id === id) || null;
      if (!oldBox) return state;

      const newBoxes = state.boxes.map(b => {
        if (b.id === id) {
          updatedBox = { ...b, ...updates, last_modified: Date.now() };
          return updatedBox;
        }
        return b;
      });
      if (!updatedBox) return state;

      const newHistory = state.history.slice(0, Math.max(0, state.historyIndex + 1));
      newHistory.push({ patches: [{ id: id, oldRef: oldBox, newRef: updatedBox }] });
      if (newHistory.length > 20) newHistory.shift();

      return {
        boxes: newBoxes,
        history: newHistory,
        historyIndex: newHistory.length - 1
      };
    });

    if (updatedBox) {
      get()._saveToIDB([updatedBox]);
    }
  },

  updateBoxNote: (id: string, note: string) => {
    // The note popover saves on every blur; skip unchanged notes so they don't add empty undo steps.
    const box = get().boxes.find(b => b.id === id);
    if (!box || (box.note ?? '') === note) return;
    get().updateBox(id, { note });
  },

  // Soft delete: the sync worker pushes the tombstone to the backend.
  deleteBox: (id: string) => {
    get().updateBox(id, { is_deleted: true });
  },

  toggleBookmark: async (documentId: string, pageIndex: number, title: string = `Page ${pageIndex}`) => {
    if (!dbPromise) return;
    const db = await dbPromise;
    const { bookmarks } = get();
    const existing = bookmarks.find(b => b.page_index === pageIndex);
    const now = Date.now();

    // Soft-delete (and revive) rather than removing the row, so the sync worker can push removals.
    const updated: Bookmark = existing
      ? { ...existing, is_deleted: !existing.is_deleted, last_modified: now }
      : {
          id: crypto.randomUUID(),
          document_id: documentId,
          page_index: pageIndex,
          title,
          created_at: now,
          is_deleted: false,
          last_modified: now,
        };
    set({ bookmarks: existing ? bookmarks.map(b => (b.id === existing.id ? updated : b)) : [...bookmarks, updated] });
    await db.put('bookmarks', updated);
  },

  recordGrade: (occlusionId: string, documentId: string, grade: SrsGrade) => {
    const { srsCards } = get();
    const existing = srsCards.find(c => c.occlusion_id === occlusionId);
    const currentCard = existing || {
      ease_factor: 2.5,
      interval_days: 0,
      repetitions: 0,
    };

    const newState = computeSrs(currentCard, grade);
    const now = Date.now();

    const updatedCard: SrsCard = {
      occlusion_id: occlusionId,
      document_id: documentId,
      ease_factor: newState.ease_factor,
      interval_days: newState.interval_days,
      repetitions: newState.repetitions,
      next_review_at: newState.next_review_at,
      last_modified: now,
      last_grade: grade,
      review_count: (existing?.review_count ?? 0) + 1,
      ever_impossible: grade === 'impossible' || (existing?.ever_impossible ?? false),
    };

    if (existing) {
      set({ srsCards: srsCards.map(c => c.occlusion_id === occlusionId ? updatedCard : c) });
    } else {
      set({ srsCards: [...srsCards, updatedCard] });
    }

    // Save to IDB (offline cache)
    get()._saveSrsCardToIDB(updatedCard);

    // Fire review to backend — creates srs_reviews row and updates srs_cards.
    // If the occlusion hasn't synced to PostgreSQL yet, the server returns 202
    // and we retry after 12 seconds (sync worker runs every 10s).
    const reviewPayload = {
      occlusion_id: occlusionId,
      grade,
      reviewed_at: new Date().toISOString(),
      last_modified: now,
    };
    const postReview = () => fetch(`${API_URL}/api/srs/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reviewPayload),
    });
    postReview().then(async res => {
      if (res.status === 202) {
        // Occlusion not in DB yet — retry after sync worker has had a chance to push it
        setTimeout(() => postReview().catch(err => console.warn('[SRS] Retry failed:', err)), 12000);
      }
    }).catch(err => console.warn('[SRS] Failed to sync review to backend:', err));
  },

  toggleRevealAllForPage: (pageIndex: number) => {
    set((state) => {
      const next = new Set(state.revealAllPages);
      if (next.has(pageIndex)) {
        next.delete(pageIndex);
      } else {
        next.add(pageIndex);
      }
      return { revealAllPages: next };
    });
  },

  toggleRevealAllForDocument: () => {
    set((state) => ({
      revealAllDocument: !state.revealAllDocument,
      // When toggling document-level off, also clear per-page reveals
      revealAllPages: state.revealAllDocument ? new Set<number>() : state.revealAllPages,
    }));
  },

  setActiveReviewPage: (pageIndex: number) => {
    set({ activeReviewPage: pageIndex });
  },

  _saveSrsCardToIDB: async (card: SrsCard) => {
    if (!dbPromise) return;
    idbQueue = idbQueue.then(async () => {
      const db = await dbPromise;
      if (!db) return;
      const tx = db.transaction('srs_cards', 'readwrite');
      tx.store.put(card);
      await tx.done;
    }).catch(console.error);
    await idbQueue;
  },

  undo: () => {
    let changed: Box[] = [];
    set((state) => {
      if (state.historyIndex < 0) return state;
      const result = applyPatches(state.boxes, state.history[state.historyIndex].patches, 'oldRef');
      changed = result.changed;
      return { boxes: result.boxes, historyIndex: state.historyIndex - 1 };
    });
    get()._saveToIDB(changed);
  },

  redo: () => {
    let changed: Box[] = [];
    set((state) => {
      if (state.historyIndex >= state.history.length - 1) return state;
      const newIndex = state.historyIndex + 1;
      const result = applyPatches(state.boxes, state.history[newIndex].patches, 'newRef');
      changed = result.changed;
      return { boxes: result.boxes, historyIndex: newIndex };
    });
    get()._saveToIDB(changed);
  }
}));
