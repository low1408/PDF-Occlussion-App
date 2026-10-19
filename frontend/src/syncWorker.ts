import { openDB } from 'idb';
import { API_URL } from './api';

// Highest last_modified the backend has accepted, per store and document. Kept in
// memory only, so the first sync after a page load pushes everything again; the
// backend's last-write-wins upserts make that harmless.
const pushedUpTo = new Map<string, number>();
let lastSyncOk = true;
let queue: Promise<unknown> = Promise.resolve();

async function post(path: string, body: unknown) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} responded ${res.status}`);
}

/** Send each document's records modified since its last successful push. Returns how many were sent. */
async function pushChanges<T extends { document_id: string }>(
  store: string,
  items: T[],
  modifiedAt: (item: T) => number,
  send: (documentId: string, changed: T[]) => Promise<void>,
): Promise<number> {
  const byDoc = new Map<string, T[]>();
  for (const item of items) {
    const list = byDoc.get(item.document_id);
    if (list) list.push(item);
    else byDoc.set(item.document_id, [item]);
  }

  let sent = 0;
  for (const [documentId, docItems] of byDoc) {
    const key = `${store}:${documentId}`;
    const since = pushedUpTo.get(key) ?? 0;
    const changed = docItems.filter(item => modifiedAt(item) > since);
    if (changed.length === 0) continue;
    await send(documentId, changed);
    pushedUpTo.set(key, changed.reduce((max, item) => Math.max(max, modifiedAt(item)), since));
    sent += changed.length;
  }
  return sent;
}

async function sync(): Promise<boolean> {
  try {
    const db = await openDB('occlusion_engine', 4);
    const [boxes, bookmarks, cards] = await Promise.all([
      db.getAll('occlusions'),
      db.getAll('bookmarks'),
      db.getAll('srs_cards'),
    ]);
    db.close();

    let sent = 0;

    // Remap pdfRect → bounding_box for the backend schema
    sent += await pushChanges('occlusions', boxes, b => b.last_modified, (docId, changed) =>
      post('/api/sync', {
        file_hash: docId,
        occlusions: changed.map(b => ({
          id: b.id,
          page_index: b.page_index,
          bounding_box: b.pdfRect,
          note: b.note ?? null,
          is_deleted: b.is_deleted ?? false,
          last_modified: b.last_modified,
        })),
      }));

    // Bookmarks saved before soft-delete existed have no last_modified; fall back to created_at.
    sent += await pushChanges('bookmarks', bookmarks, b => b.last_modified ?? b.created_at, (docId, changed) =>
      post('/api/bookmarks/sync', {
        file_hash: docId,
        bookmarks: changed.map(b => ({
          id: b.id,
          page_index: b.page_index,
          title: b.title ?? null,
          is_deleted: b.is_deleted ?? false,
          last_modified: b.last_modified ?? b.created_at,
        })),
      }));

    sent += await pushChanges('srs_cards', cards, c => c.last_modified, (_docId, changed) =>
      post('/api/srs/sync', {
        cards: changed.map(c => ({
          occlusion_id: c.occlusion_id,
          ease_factor: c.ease_factor,
          interval_days: c.interval_days,
          repetitions: c.repetitions,
          next_review_at: c.next_review_at,
          last_modified: c.last_modified,
        })),
      }));

    // Nothing to push: still confirm the backend is reachable so callers get an honest result.
    if (sent === 0) {
      const res = await fetch(`${API_URL}/health`);
      if (!res.ok) throw new Error(`GET /health responded ${res.status}`);
    }

    if (!lastSyncOk) console.info('[Sync] Backend reachable again.');
    lastSyncOk = true;
    return true;
  } catch (err) {
    // Log once per outage rather than on every 10s attempt.
    if (lastSyncOk) console.warn('[Sync] Sync failed; will keep retrying:', err);
    lastSyncOk = false;
    return false;
  }
}

self.addEventListener('message', (event: MessageEvent<{ type: string; id: number }>) => {
  if (event.data?.type !== 'sync') return;
  const { id } = event.data;
  // Run syncs one at a time so two requests never push the same changes concurrently.
  const run = queue.then(sync);
  queue = run;
  run.then(ok => self.postMessage({ id, ok }));
});
