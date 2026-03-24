import { openDB } from 'idb';

async function sync() {
  try {
    const db = await openDB('occlusion_engine', 3);

    // ---- Sync occlusions ----
    const occTx = db.transaction('occlusions', 'readonly');
    const allBoxes = await occTx.store.getAll();

    const byDoc: Record<string, any[]> = {};
    for (const box of allBoxes) {
      if (!byDoc[box.document_id]) {
        byDoc[box.document_id] = [];
      }
      byDoc[box.document_id].push(box);
    }

    for (const [docId, boxes] of Object.entries(byDoc)) {
      try {
        // Remap pdfRect → bounding_box for the backend schema
        const mapped = boxes.map(b => ({
          id: b.id,
          page_index: b.page_index,
          bounding_box: b.pdfRect,
          note: b.note ?? null,
          is_deleted: b.is_deleted ?? false,
          last_modified: b.last_modified,
        }));

        await fetch('http://localhost:3000/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_hash: docId, occlusions: mapped })
        });
        console.log(`Synced ${boxes.length} occlusions for document ${docId}`);
      } catch (err) {
        console.error(`Failed to sync occlusions for document ${docId}:`, err);
      }
    }

    // ---- Sync bookmarks ----
    const bmTx = db.transaction('bookmarks', 'readonly');
    const allBookmarks = await bmTx.store.getAll();

    const bmByDoc: Record<string, any[]> = {};
    for (const bm of allBookmarks) {
      if (!bmByDoc[bm.document_id]) {
        bmByDoc[bm.document_id] = [];
      }
      bmByDoc[bm.document_id].push(bm);
    }

    for (const [docId, bookmarks] of Object.entries(bmByDoc)) {
      try {
        const mapped = bookmarks.map(b => ({
          id: b.id,
          page_index: b.page_index,
          title: b.title ?? null,
          is_deleted: b.is_deleted ?? false,
          last_modified: b.created_at ?? Date.now(),
        }));

        await fetch('http://localhost:3000/api/bookmarks/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_hash: docId, bookmarks: mapped })
        });
        console.log(`Synced ${bookmarks.length} bookmarks for document ${docId}`);
      } catch (err) {
        console.error(`Failed to sync bookmarks for document ${docId}:`, err);
      }
    }

    // ---- Sync SRS cards ----
    const srsTx = db.transaction('srs_cards', 'readonly');
    const allSrsCards = await srsTx.store.getAll();

    if (allSrsCards.length > 0) {
      try {
        const mapped = allSrsCards.map(c => ({
          occlusion_id: c.occlusion_id,
          ease_factor: c.ease_factor,
          interval_days: c.interval_days,
          repetitions: c.repetitions,
          next_review_at: c.next_review_at,
          last_modified: c.last_modified,
        }));

        await fetch('http://localhost:3000/api/srs/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cards: mapped })
        });
        console.log(`Synced ${allSrsCards.length} SRS cards`);
      } catch (err) {
        console.error('Failed to sync SRS cards:', err);
      }
    }

  } catch (err) {
    console.error('Sync worker encountered an error reading IDB:', err);
  }
}

// Run sync every 10 seconds
setInterval(sync, 10000);

// Initial sync
sync();
