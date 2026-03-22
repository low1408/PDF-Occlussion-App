import { openDB } from 'idb';

async function sync() {
  try {
    const db = await openDB('occlusion_engine', 1);
    const tx = db.transaction('occlusions', 'readonly');
    const allBoxes = await tx.store.getAll();
    
    // Group occlusions by document
    const byDoc: Record<string, any[]> = {};
    for (const box of allBoxes) {
      if (!byDoc[box.document_id]) {
        byDoc[box.document_id] = [];
      }
      byDoc[box.document_id].push(box);
    }

    // Sync each document's occlusions
    for (const [docId, boxes] of Object.entries(byDoc)) {
      try {
        await fetch('http://localhost:3000/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_hash: docId, occlusions: boxes })
        });
        console.log(`Synced ${boxes.length} occlusions for document ${docId}`);
      } catch (err) {
        console.error(`Failed to sync document ${docId}:`, err);
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
