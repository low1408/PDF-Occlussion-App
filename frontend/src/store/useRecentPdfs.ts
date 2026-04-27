import { dbPromise } from './useOcclusionStore';
import type { RecentPdfEntry } from './useOcclusionStore';

const MAX_RECENTS = 10;

/** Metadata-only projection (everything except pdfData) for the landing page list. */
export type RecentPdfMeta = Omit<RecentPdfEntry, 'pdfData'>;

/**
 * Get the shared DB connection from useOcclusionStore.
 * This ensures we always use the same openDB call that has the upgrade handler,
 * preventing race conditions where a second openDB without an upgrade handler
 * could skip store creation.
 */
async function getDb() {
  if (!dbPromise) throw new Error('IndexedDB not available');
  return dbPromise;
}

/**
 * Load all recent PDFs sorted by lastOpenedAt descending.
 * Returns metadata only — pdfData is excluded to keep memory low.
 */
export async function loadRecents(): Promise<RecentPdfMeta[]> {
  const db = await getDb();
  const tx = db.transaction('recent_pdfs', 'readonly');
  const index = tx.store.index('by-lastOpened');
  const all: RecentPdfMeta[] = [];

  // Walk the index in reverse (newest first)
  let cursor = await index.openCursor(null, 'prev');
  while (cursor) {
    const { pdfData, ...meta } = cursor.value as RecentPdfEntry;
    all.push(meta);
    cursor = await cursor.continue();
  }

  return all;
}

/**
 * Save (upsert) a recent PDF entry. If the total exceeds MAX_RECENTS,
 * the oldest entries are evicted.
 */
export async function saveRecent(entry: RecentPdfEntry): Promise<void> {
  const db = await getDb();

  // Upsert
  const tx = db.transaction('recent_pdfs', 'readwrite');
  await tx.store.put(entry);
  await tx.done;

  // Evict oldest if over limit
  const evictTx = db.transaction('recent_pdfs', 'readwrite');
  const index = evictTx.store.index('by-lastOpened');
  const count = await evictTx.store.count();

  if (count > MAX_RECENTS) {
    const toRemove = count - MAX_RECENTS;
    let cursor = await index.openCursor(); // ascending = oldest first
    let removed = 0;
    while (cursor && removed < toRemove) {
      await cursor.delete();
      removed++;
      cursor = await cursor.continue();
    }
  }
  await evictTx.done;
}

/**
 * Load just the pdfData ArrayBuffer for a given file hash.
 * Returns null if not found (e.g. entry was evicted).
 */
export async function loadPdfData(fileHash: string): Promise<ArrayBuffer | null> {
  const db = await getDb();
  const entry = await db.get('recent_pdfs', fileHash);
  return entry?.pdfData ?? null;
}

/**
 * Update the lastViewedPage for a given file hash.
 * This is called frequently (on scroll), so it's a lightweight partial update.
 */
export async function updateLastViewedPage(fileHash: string, page: number): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('recent_pdfs', 'readwrite');
  const existing = await tx.store.get(fileHash);
  if (existing) {
    existing.lastViewedPage = page;
    existing.lastOpenedAt = Date.now();
    await tx.store.put(existing);
  }
  await tx.done;
}

/**
 * Delete a recent PDF entry (user-initiated, frees IDB storage).
 */
export async function deleteRecent(fileHash: string): Promise<void> {
  const db = await getDb();
  await db.delete('recent_pdfs', fileHash);
}
