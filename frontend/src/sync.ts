import { dbPromise } from './store/useOcclusionStore';

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
