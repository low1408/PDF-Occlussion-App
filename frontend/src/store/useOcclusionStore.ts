import { create } from 'zustand';
import { openDB, DBSchema, IDBPDatabase } from 'idb';

export interface Box {
  id: string;
  document_id: string;
  page_index: number;
  pdfRect: [number, number, number, number];
  is_deleted: boolean;
  last_modified: number;
}

interface OcclusionDB extends DBSchema {
  occlusions: {
    key: string;
    value: Box;
    indexes: { 'by-doc': string };
  };
}

let dbPromise: Promise<IDBPDatabase<OcclusionDB>> | null = null;
if (typeof window !== 'undefined') {
  dbPromise = openDB<OcclusionDB>('occlusion_engine', 1, {
    upgrade(db) {
      const store = db.createObjectStore('occlusions', { keyPath: 'id' });
      store.createIndex('by-doc', 'document_id');
    },
  });
}

interface State {
  boxes: Box[];
  history: Box[][];
  historyIndex: number;

  loadBoxesForDocument: (documentId: string) => Promise<void>;
  addBox: (box: Box) => void;
  updateBox: (id: string, updates: Partial<Box>) => void;
  deleteBox: (id: string) => void;
  undo: () => void;
  redo: () => void;

  _saveToIDB: (boxesToSave: Box[]) => Promise<void>;
}

export const useOcclusionStore = create<State>((set, get) => ({
  boxes: [],
  history: [],
  historyIndex: -1,

  loadBoxesForDocument: async (documentId: string) => {
    if (!dbPromise) return;
    const db = await dbPromise;
    const allBoxes = await db.getAllFromIndex('occlusions', 'by-doc', documentId);
    set({ boxes: allBoxes, history: [allBoxes], historyIndex: 0 });
  },

  _saveToIDB: async (boxesToSave: Box[]) => {
    if (!dbPromise) return;
    const db = await dbPromise;
    const tx = db.transaction('occlusions', 'readwrite');
    for (const b of boxesToSave) {
      tx.store.put(b);
    }
    await tx.done;
  },

  addBox: (box: Box) => {
    set((state) => {
      const newBoxes = [...state.boxes, box];
      const newHistory = state.history.slice(0, state.historyIndex + 1);
      newHistory.push(newBoxes);
      if (newHistory.length > 10) newHistory.shift();

      get()._saveToIDB([box]);

      return {
        boxes: newBoxes,
        history: newHistory,
        historyIndex: newHistory.length - 1
      };
    });
  },

  updateBox: (id: string, updates: Partial<Box>) => {
    set((state) => {
      let updatedBox: Box | null = null;
      const newBoxes = state.boxes.map(b => {
        if (b.id === id) {
          updatedBox = { ...b, ...updates, last_modified: Date.now() };
          return updatedBox;
        }
        return b;
      });
      if (!updatedBox) return state;

      const newHistory = state.history.slice(0, state.historyIndex + 1);
      newHistory.push(newBoxes);
      if (newHistory.length > 10) newHistory.shift();

      get()._saveToIDB([updatedBox]);

      return {
        boxes: newBoxes,
        history: newHistory,
        historyIndex: newHistory.length - 1
      };
    });
  },

  deleteBox: (id: string) => {
    get().updateBox(id, { is_deleted: true });
  },

  undo: () => {
    set((state) => {
      if (state.historyIndex <= 0) return state;
      const newIndex = state.historyIndex - 1;
      const previousBoxes = state.history[newIndex];
      get()._saveToIDB(previousBoxes);
      return { boxes: previousBoxes, historyIndex: newIndex };
    });
  },

  redo: () => {
    set((state) => {
      if (state.historyIndex >= state.history.length - 1) return state;
      const newIndex = state.historyIndex + 1;
      const nextBoxes = state.history[newIndex];
      get()._saveToIDB(nextBoxes);
      return { boxes: nextBoxes, historyIndex: newIndex };
    });
  }
}));
