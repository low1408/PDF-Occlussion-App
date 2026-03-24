import { create } from 'zustand';
import { openDB, DBSchema, IDBPDatabase } from 'idb';

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
}

export interface SrsCard {
  occlusion_id: string;
  document_id: string;
  ease_factor: number;
  interval_days: number;
  repetitions: number;
  next_review_at: string;
  last_modified: number;
}

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
}

let dbPromise: Promise<IDBPDatabase<OcclusionDB>> | null = null;
let idbQueue: Promise<void> = Promise.resolve();
if (typeof window !== 'undefined') {
  dbPromise = openDB<OcclusionDB>('occlusion_engine', 3, {
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
    },
  });
}

interface State {
  boxes: Box[];
  history: PatchGroup[];
  historyIndex: number;
  bookmarks: Bookmark[];
  srsCards: SrsCard[];

  loadBoxesForDocument: (documentId: string) => Promise<void>;
  addBox: (box: Box) => void;
  updateBox: (id: string, updates: Partial<Box>) => void;
  updateBoxNote: (id: string, note: string) => void;
  deleteBox: (id: string) => void;
  undo: () => void;
  redo: () => void;

  toggleBookmark: (documentId: string, pageIndex: number, title?: string) => Promise<void>;
  recordGrade: (occlusionId: string, documentId: string, grade: SrsGrade) => void;

  _saveToIDB: (boxesToSave: Box[]) => Promise<void>;
  _deleteFromIDB: (boxIds: string[]) => Promise<void>;
  _saveSrsCardToIDB: (card: SrsCard) => Promise<void>;
}

export const useOcclusionStore = create<State>((set, get) => ({
  boxes: [],
  history: [],
  historyIndex: -1,
  bookmarks: [],
  srsCards: [],

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
      const tx = db.transaction('occlusions', 'readwrite');
      for (const b of boxesToSave) {
        tx.store.put(b);
      }
      await tx.done;
    }).catch(console.error);
    await idbQueue;
  },

  _deleteFromIDB: async (boxIds: string[]) => {
    if (!dbPromise || boxIds.length === 0) return;
    idbQueue = idbQueue.then(async () => {
      const db = await dbPromise;
      const tx = db.transaction('occlusions', 'readwrite');
      for (const id of boxIds) {
        tx.store.delete(id);
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
    get().updateBox(id, { note });
  },

  deleteBox: (id: string) => {
    get().updateBox(id, { is_deleted: true });
  },

  toggleBookmark: async (documentId: string, pageIndex: number, title: string = `Page ${pageIndex}`) => {
    if (!dbPromise) return;
    const db = await dbPromise;
    const { bookmarks } = get();
    const existing = bookmarks.find(b => b.page_index === pageIndex);

    if (existing) {
      // Remove
      await db.delete('bookmarks', existing.id);
      set({ bookmarks: bookmarks.filter(b => b.id !== existing.id) });
    } else {
      // Add
      const newBm: Bookmark = {
        id: crypto.randomUUID(),
        document_id: documentId,
        page_index: pageIndex,
        title,
        created_at: Date.now()
      };
      await db.put('bookmarks', newBm);
      set({ bookmarks: [...bookmarks, newBm] });
    }
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
    };

    if (existing) {
      set({ srsCards: srsCards.map(c => c.occlusion_id === occlusionId ? updatedCard : c) });
    } else {
      set({ srsCards: [...srsCards, updatedCard] });
    }

    get()._saveSrsCardToIDB(updatedCard);
  },

  _saveSrsCardToIDB: async (card: SrsCard) => {
    if (!dbPromise) return;
    idbQueue = idbQueue.then(async () => {
      const db = await dbPromise;
      const tx = db.transaction('srs_cards', 'readwrite');
      tx.store.put(card);
      await tx.done;
    }).catch(console.error);
    await idbQueue;
  },

  undo: () => {
    let diffToSave: Box[] = [];
    let diffToDelete: string[] = [];
    set((state) => {
      if (state.historyIndex < 0) return state;
      const patchGroup = state.history[state.historyIndex];
      const newIndex = state.historyIndex - 1;

      let newBoxes = [...state.boxes];
      for (const p of patchGroup.patches) {
        if (p.oldRef) {
          const idx = newBoxes.findIndex(b => b.id === p.id);
          if (idx >= 0) {
            newBoxes[idx] = p.oldRef;
          } else {
            newBoxes.push(p.oldRef);
          }
          diffToSave.push(p.oldRef);
        } else {
          newBoxes = newBoxes.filter(b => b.id !== p.id);
          diffToDelete.push(p.id);
        }
      }

      return { boxes: newBoxes, historyIndex: newIndex };
    });
    
    if (diffToSave.length > 0) get()._saveToIDB(diffToSave);
    if (diffToDelete.length > 0) get()._deleteFromIDB(diffToDelete);
  },

  redo: () => {
    let diffToSave: Box[] = [];
    let diffToDelete: string[] = [];
    set((state) => {
      if (state.historyIndex >= state.history.length - 1) return state;
      const newIndex = state.historyIndex + 1;
      const patchGroup = state.history[newIndex];

      let newBoxes = [...state.boxes];
      for (const p of patchGroup.patches) {
        if (p.newRef) {
          const idx = newBoxes.findIndex(b => b.id === p.id);
          if (idx >= 0) {
            newBoxes[idx] = p.newRef;
          } else {
            newBoxes.push(p.newRef);
          }
          diffToSave.push(p.newRef);
        } else {
          newBoxes = newBoxes.filter(b => b.id !== p.id);
          diffToDelete.push(p.id);
        }
      }

      return { boxes: newBoxes, historyIndex: newIndex };
    });
    
    if (diffToSave.length > 0) get()._saveToIDB(diffToSave);
    if (diffToDelete.length > 0) get()._deleteFromIDB(diffToDelete);
  }
}));
