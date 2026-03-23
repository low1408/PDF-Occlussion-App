const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/occlusion_engine',
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Initialize Database Schema
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        file_hash TEXT UNIQUE NOT NULL
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS occlusions (
        id UUID PRIMARY KEY,
        document_id UUID REFERENCES documents(id),
        page_index INT NOT NULL,
        bounding_box JSONB NOT NULL,
        is_deleted BOOLEAN DEFAULT FALSE,
        last_modified BIGINT NOT NULL
      );
    `);
    
    // Add note column to occlusions if it doesn't exist
    await pool.query(`ALTER TABLE occlusions ADD COLUMN IF NOT EXISTS note TEXT;`).catch(() => {});
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bookmarks (
        id UUID PRIMARY KEY,
        document_id UUID REFERENCES documents(id),
        page_index INT NOT NULL,
        title TEXT,
        created_at BIGINT NOT NULL
      );
    `);
    console.log("Database initialized successfully.");
  } catch (error) {
    console.error("Database initialization failed:", error);
  }
};
initDB();

// Sync GET endpoint
app.get('/api/sync/:file_hash', async (req, res) => {
  try {
    const { file_hash } = req.params;
    const since = parseInt(req.query.since || '0', 10);

    // Check if doc exists
    const docRes = await pool.query('SELECT id FROM documents WHERE file_hash = $1', [file_hash]);
    if (docRes.rows.length === 0) {
      return res.json({ occlusions: [] });
    }
    const documentId = docRes.rows[0].id;

    const occRes = await pool.query(
      'SELECT * FROM occlusions WHERE document_id = $1 AND last_modified > $2',
      [documentId, since]
    );
    res.json({ occlusions: occRes.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Sync POST endpoint for batch upsert
app.post('/api/sync', async (req, res) => {
  try {
    const { file_hash, occlusions } = req.body;
    if (!file_hash || !occlusions || !Array.isArray(occlusions)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    // Upsert Document
    const docRes = await pool.query(
      `INSERT INTO documents (file_hash) VALUES ($1)
       ON CONFLICT (file_hash) DO UPDATE SET file_hash = EXCLUDED.file_hash
       RETURNING id`,
      [file_hash]
    );
    const documentId = docRes.rows[0].id;

    // Batch upsert occlusions (Last-Write-Wins handling via application logic or direct upsert if timestamps are strictly monotonic)
    // To implement true LWW in SQL, you would conditionally update. For simplicity, we assume client timestamp is latest.
    for (const occ of occlusions) {
      await pool.query(
        `INSERT INTO occlusions (id, document_id, page_index, bounding_box, is_deleted, last_modified, note)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (id) DO UPDATE SET 
            document_id = EXCLUDED.document_id,
            page_index = EXCLUDED.page_index,
            bounding_box = EXCLUDED.bounding_box,
            is_deleted = EXCLUDED.is_deleted,
            last_modified = EXCLUDED.last_modified,
            note = EXCLUDED.note
          WHERE occlusions.last_modified < EXCLUDED.last_modified`,
        [occ.id, documentId, occ.page_index, occ.bounding_box, occ.is_deleted || false, occ.last_modified, occ.note]
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Sync Bookmarks GET
app.get('/api/bookmarks/:file_hash', async (req, res) => {
  try {
    const { file_hash } = req.params;
    const docRes = await pool.query('SELECT id FROM documents WHERE file_hash = $1', [file_hash]);
    if (docRes.rows.length === 0) {
      return res.json({ bookmarks: [] });
    }
    const documentId = docRes.rows[0].id;
    const bookRes = await pool.query('SELECT * FROM bookmarks WHERE document_id = $1', [documentId]);
    res.json({ bookmarks: bookRes.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Sync Bookmarks POST
app.post('/api/bookmarks/sync', async (req, res) => {
  try {
    const { file_hash, bookmarks } = req.body;
    if (!file_hash || !bookmarks || !Array.isArray(bookmarks)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const docRes = await pool.query(
      `INSERT INTO documents (file_hash) VALUES ($1)
       ON CONFLICT (file_hash) DO UPDATE SET file_hash = EXCLUDED.file_hash
       RETURNING id`,
      [file_hash]
    );
    const documentId = docRes.rows[0].id;

    for (const bm of bookmarks) {
      if (bm.is_deleted) {
        await pool.query('DELETE FROM bookmarks WHERE id = $1', [bm.id]);
      } else {
        await pool.query(
          `INSERT INTO bookmarks (id, document_id, page_index, title, created_at)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (id) DO UPDATE SET 
              page_index = EXCLUDED.page_index,
              title = EXCLUDED.title,
              created_at = EXCLUDED.created_at`,
          [bm.id, documentId, bm.page_index, bm.title, bm.created_at]
        );
      }
    }
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
