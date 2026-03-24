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
        await fetch('http://localhost:3000/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_hash: docId, occlusions: boxes })
        });
        console.log(`Synced ${boxes.length} occlusions for document ${docId}`);
      } catch (err) {
        console.error(`Failed to sync occlusions for document ${docId}:`, err);
      }
    }

    // ---- Sync SRS cards ----
    const srsTx = db.transaction('srs_cards', 'readonly');
    const allSrsCards = await srsTx.store.getAll();

    for (const card of allSrsCards) {
      try {
        await fetch('http://localhost:3000/api/srs/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            occlusion_id: card.occlusion_id,
            grade: 'ok', // The actual grade was already applied locally; re-sync the card state
            reviewed_at: card.next_review_at,
            last_modified: card.last_modified,
          })
        });
        console.log(`Synced SRS card for occlusion ${card.occlusion_id}`);
      } catch (err) {
        console.error(`Failed to sync SRS card ${card.occlusion_id}:`, err);
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
