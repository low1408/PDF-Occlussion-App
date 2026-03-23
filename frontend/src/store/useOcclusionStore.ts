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
}

let dbPromise: Promise<IDBPDatabase<OcclusionDB>> | null = null;
let idbQueue: Promise<void> = Promise.resolve();
if (typeof window !== 'undefined') {
  dbPromise = openDB<OcclusionDB>('occlusion_engine', 2, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const store = db.createObjectStore('occlusions', { keyPath: 'id' });
        store.createIndex('by-doc', 'document_id');
      }
      if (oldVersion < 2) {
        const bStore = db.createObjectStore('bookmarks', { keyPath: 'id' });
        bStore.createIndex('by-doc', 'document_id');
      }
    },
  });
}

interface State {
  boxes: Box[];
  history: PatchGroup[];
  historyIndex: number;
  bookmarks: Bookmark[];

  loadBoxesForDocument: (documentId: string) => Promise<void>;
  addBox: (box: Box) => void;
  updateBox: (id: string, updates: Partial<Box>) => void;
  updateBoxNote: (id: string, note: string) => void;
  deleteBox: (id: string) => void;
  undo: () => void;
  redo: () => void;

  toggleBookmark: (documentId: string, pageIndex: number, title?: string) => Promise<void>;

  _saveToIDB: (boxesToSave: Box[]) => Promise<void>;
  _deleteFromIDB: (boxIds: string[]) => Promise<void>;
}

export const useOcclusionStore = create<State>((set, get) => ({
  boxes: [],
  history: [],
  historyIndex: -1,
  bookmarks: [],

  loadBoxesForDocument: async (documentId: string) => {
    if (!dbPromise) return;
    const db = await dbPromise;
    const allBoxes = await db.getAllFromIndex('occlusions', 'by-doc', documentId);
    const bookmarks = await db.getAllFromIndex('bookmarks', 'by-doc', documentId);
    set({ boxes: allBoxes, history: [], historyIndex: -1, bookmarks });
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
