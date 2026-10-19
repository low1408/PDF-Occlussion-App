import { API_URL } from './api';
import { dbPromise, useOcclusionStore, SrsGrade } from './store/useOcclusionStore';

const SYNC_INTERVAL_MS = 10_000;

let worker: Worker | null = null;
let nextRequestId = 0;
const pending = new Map<number, (ok: boolean) => void>();
const listeners = new Set<(ok: boolean) => void>();

function settle(id: number, ok: boolean) {
  pending.get(id)?.(ok);
  pending.delete(id);
  listeners.forEach(listener => listener(ok));
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./syncWorker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (e: MessageEvent<{ id: number; ok: boolean }>) => settle(e.data.id, e.data.ok));
    worker.addEventListener('error', () => [...pending.keys()].forEach(id => settle(id, false)));
  }
  return worker;
}

/**
 * Push local changes to the backend.
 * Resolves true when the backend accepted everything (or was reachable with nothing to push).
 */
export async function requestSync(): Promise<boolean> {
  // The worker opens the DB without an upgrade handler, so let the main thread create the stores first.
  await dbPromise;
  const id = nextRequestId++;
  return new Promise(resolve => {
    pending.set(id, resolve);
    getWorker().postMessage({ type: 'sync', id });
  });
}

/** Subscribe to the outcome of every sync, manual or automatic. Returns an unsubscribe function. */
export function onSyncResult(listener: (ok: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Row shapes returned by the backend. Postgres BIGINT columns arrive as strings.
interface RemoteOcclusion {
  id: string;
  page_index: number;
  bounding_box: [number, number, number, number];
  note: string | null;
  is_deleted: boolean;
  last_modified: string;
}
interface RemoteBookmark {
  id: string;
  page_index: number;
  title: string | null;
  is_deleted: boolean;
  last_modified: string;
}
interface RemoteSrsCard {
  occlusion_id: string;
  ease_factor: number;
  interval_days: number;
  repetitions: number;
  next_review_at: string | null;
  last_modified: string;
  last_grade: SrsGrade | null;
  review_count: number;
  ever_impossible: boolean;
}

/**
 * Fetch a document's records from the backend and merge in any that are newer than
 * the local copy (for example, edits made in another browser).
 * Resolves false if the backend couldn't be reached.
 */
export async function pullFromServer(fileHash: string): Promise<boolean> {
  try {
    const [syncRes, cardsRes] = await Promise.all([
      fetch(`${API_URL}/api/sync/${fileHash}`),
      fetch(`${API_URL}/api/srs/cards/${fileHash}`),
    ]);
    if (!syncRes.ok || !cardsRes.ok) return false;
    const { occlusions, bookmarks } = await syncRes.json() as { occlusions: RemoteOcclusion[]; bookmarks: RemoteBookmark[] };
    const { srs_cards } = await cardsRes.json() as { srs_cards: RemoteSrsCard[] };

    useOcclusionStore.getState().mergeRemote(fileHash, {
      boxes: occlusions.map(o => ({
        id: o.id,
        document_id: fileHash,
        page_index: o.page_index,
        pdfRect: o.bounding_box,
        note: o.note ?? undefined,
        is_deleted: o.is_deleted,
        last_modified: Number(o.last_modified),
      })),
      bookmarks: bookmarks.map(b => ({
        id: b.id,
        document_id: fileHash,
        page_index: b.page_index,
        title: b.title ?? `Page ${b.page_index}`,
        created_at: Number(b.last_modified),
        is_deleted: b.is_deleted,
        last_modified: Number(b.last_modified),
      })),
      srsCards: srs_cards.map(c => ({
        occlusion_id: c.occlusion_id,
        document_id: fileHash,
        ease_factor: c.ease_factor,
        interval_days: c.interval_days,
        repetitions: c.repetitions,
        next_review_at: c.next_review_at ?? new Date().toISOString(),
        last_modified: Number(c.last_modified),
        last_grade: c.last_grade ?? undefined,
        review_count: c.review_count,
        ever_impossible: c.ever_impossible,
      })),
    });
    return true;
  } catch {
    return false;
  }
}

/** Sync every 10s and whenever the tab is hidden. Returns a function that stops it. */
export function startAutoSync(): () => void {
  const timer = setInterval(() => void requestSync(), SYNC_INTERVAL_MS);
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') void requestSync();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
