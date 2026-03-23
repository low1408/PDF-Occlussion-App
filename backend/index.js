const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/occlusion_engine',
});

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Parse the `since` query-param into a safe integer.
 * Returns null if the value is missing/invalid so the caller can 400.
 */
function parseSince(raw) {
  if (raw === undefined || raw === null || raw === '') return 0; // default
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null; // bad input
  return Math.floor(n);
}

/**
 * Validate that every object in `items` has the required keys and that each
 * value passes a basic type check.  Returns null on success, or a string
 * describing the first violation.
 */
function validateItems(items, schema) {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    for (const [key, type] of Object.entries(schema)) {
      if (item[key] === undefined || item[key] === null) {
        return `Item at index ${i} is missing required field "${key}"`;
      }
      // eslint-disable-next-line valid-typeof
      if (typeof item[key] !== type && type !== 'any') {
        return `Item at index ${i}: field "${key}" expected ${type}, got ${typeof item[key]}`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'unhealthy' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/sync/:file_hash  — pull changes since a timestamp
// ---------------------------------------------------------------------------

app.get('/api/sync/:file_hash', async (req, res) => {
  try {
    const { file_hash } = req.params;
    const since = parseSince(req.query.since);
    if (since === null) {
      return res.status(400).json({ error: '`since` must be a non-negative integer' });
    }

    const docRes = await pool.query(
      'SELECT id FROM documents WHERE file_hash = $1',
      [file_hash],
    );
    if (docRes.rows.length === 0) {
      return res.json({ occlusions: [], bookmarks: [] });
    }
    const documentId = docRes.rows[0].id;

    const [occRes, bmRes] = await Promise.all([
      pool.query(
        'SELECT * FROM occlusions WHERE document_id = $1 AND last_modified > $2',
        [documentId, since],
      ),
      pool.query(
        'SELECT * FROM bookmarks WHERE document_id = $1 AND last_modified > $2',
        [documentId, since],
      ),
    ]);

    res.json({ occlusions: occRes.rows, bookmarks: bmRes.rows });
  } catch (error) {
    console.error('[GET /api/sync] Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/sync  — batch upsert occlusions (transactional, batched)
// ---------------------------------------------------------------------------

const OCCLUSION_SCHEMA = {
  id: 'string',
  page_index: 'number',
  bounding_box: 'any', // JSONB — object or already stringified
  last_modified: 'number',
};

app.post('/api/sync', async (req, res) => {
  const { file_hash, occlusions } = req.body;

  // ---- input validation ----
  if (!file_hash || typeof file_hash !== 'string') {
    return res.status(400).json({ error: '`file_hash` is required and must be a string' });
  }
  if (!Array.isArray(occlusions) || occlusions.length === 0) {
    return res.status(400).json({ error: '`occlusions` must be a non-empty array' });
  }
  const validationError = validateItems(occlusions, OCCLUSION_SCHEMA);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert document
    const docRes = await client.query(
      `INSERT INTO documents (file_hash) VALUES ($1)
       ON CONFLICT (file_hash) DO UPDATE SET file_hash = EXCLUDED.file_hash
       RETURNING id`,
      [file_hash],
    );
    const documentId = docRes.rows[0].id;

    // --- Batch upsert using UNNEST arrays ---
    const ids = [];
    const pageIndexes = [];
    const boundingBoxes = [];
    const notes = [];
    const isDeletedFlags = [];
    const lastModifiedTs = [];

    for (const occ of occlusions) {
      ids.push(occ.id);
      pageIndexes.push(occ.page_index);
      boundingBoxes.push(
        typeof occ.bounding_box === 'string'
          ? occ.bounding_box
          : JSON.stringify(occ.bounding_box),
      );
      notes.push(occ.note ?? null);
      isDeletedFlags.push(occ.is_deleted ?? false);
      lastModifiedTs.push(occ.last_modified);
    }

    await client.query(
      `INSERT INTO occlusions (id, document_id, page_index, bounding_box, note, is_deleted, last_modified)
       SELECT
         unnest($1::uuid[]),
         $2::uuid,
         unnest($3::int[]),
         unnest($4::jsonb[]),
         unnest($5::text[]),
         unnest($6::boolean[]),
         unnest($7::bigint[])
       ON CONFLICT (id) DO UPDATE SET
         document_id  = EXCLUDED.document_id,
         page_index   = EXCLUDED.page_index,
         bounding_box = EXCLUDED.bounding_box,
         note         = EXCLUDED.note,
         is_deleted   = EXCLUDED.is_deleted,
         last_modified = EXCLUDED.last_modified
       WHERE occlusions.last_modified < EXCLUDED.last_modified`,
      [ids, documentId, pageIndexes, boundingBoxes, notes, isDeletedFlags, lastModifiedTs],
    );

    await client.query('COMMIT');
    res.json({ success: true, upserted: occlusions.length });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[POST /api/sync] Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// GET /api/bookmarks/:file_hash  — pull bookmarks
// ---------------------------------------------------------------------------

app.get('/api/bookmarks/:file_hash', async (req, res) => {
  try {
    const { file_hash } = req.params;
    const since = parseSince(req.query.since);
    if (since === null) {
      return res.status(400).json({ error: '`since` must be a non-negative integer' });
    }

    const docRes = await pool.query(
      'SELECT id FROM documents WHERE file_hash = $1',
      [file_hash],
    );
    if (docRes.rows.length === 0) {
      return res.json({ bookmarks: [] });
    }
    const documentId = docRes.rows[0].id;

    const bmRes = await pool.query(
      'SELECT * FROM bookmarks WHERE document_id = $1 AND last_modified > $2',
      [documentId, since],
    );
    res.json({ bookmarks: bmRes.rows });
  } catch (error) {
    console.error('[GET /api/bookmarks] Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/bookmarks/sync  — batch upsert bookmarks (transactional, LWW)
// ---------------------------------------------------------------------------

const BOOKMARK_SCHEMA = {
  id: 'string',
  page_index: 'number',
  last_modified: 'number',
};

app.post('/api/bookmarks/sync', async (req, res) => {
  const { file_hash, bookmarks } = req.body;

  // ---- input validation ----
  if (!file_hash || typeof file_hash !== 'string') {
    return res.status(400).json({ error: '`file_hash` is required and must be a string' });
  }
  if (!Array.isArray(bookmarks) || bookmarks.length === 0) {
    return res.status(400).json({ error: '`bookmarks` must be a non-empty array' });
  }
  const validationError = validateItems(bookmarks, BOOKMARK_SCHEMA);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert document
    const docRes = await client.query(
      `INSERT INTO documents (file_hash) VALUES ($1)
       ON CONFLICT (file_hash) DO UPDATE SET file_hash = EXCLUDED.file_hash
       RETURNING id`,
      [file_hash],
    );
    const documentId = docRes.rows[0].id;

    // --- Batch upsert using UNNEST arrays ---
    const ids = [];
    const pageIndexes = [];
    const titles = [];
    const isDeletedFlags = [];
    const lastModifiedTs = [];

    for (const bm of bookmarks) {
      ids.push(bm.id);
      pageIndexes.push(bm.page_index);
      titles.push(bm.title ?? null);
      isDeletedFlags.push(bm.is_deleted ?? false);
      lastModifiedTs.push(bm.last_modified);
    }

    await client.query(
      `INSERT INTO bookmarks (id, document_id, page_index, title, is_deleted, last_modified)
       SELECT
         unnest($1::uuid[]),
         $2::uuid,
         unnest($3::int[]),
         unnest($4::text[]),
         unnest($5::boolean[]),
         unnest($6::bigint[])
       ON CONFLICT (id) DO UPDATE SET
         page_index    = EXCLUDED.page_index,
         title         = EXCLUDED.title,
         is_deleted    = EXCLUDED.is_deleted,
         last_modified = EXCLUDED.last_modified
       WHERE bookmarks.last_modified < EXCLUDED.last_modified`,
      [ids, documentId, pageIndexes, titles, isDeletedFlags, lastModifiedTs],
    );

    await client.query('COMMIT');
    res.json({ success: true, upserted: bookmarks.length });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[POST /api/bookmarks/sync] Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Start server AFTER verifying database connectivity
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    // Verify the database is reachable and the schema is in place
    await pool.query('SELECT 1 FROM documents LIMIT 0');
    console.log('Database connection verified.');
  } catch (error) {
    console.error(
      'FATAL: Cannot reach the database or schema is missing.\n' +
      'Run `psql -d occlusion_engine -f schema.sql` to initialize the schema.\n',
      error.message,
    );
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start();
