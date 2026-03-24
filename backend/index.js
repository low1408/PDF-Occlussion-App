const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        user: 'harry',
        database: 'occlusion_engine',
        host: '/var/run/postgresql',   // Force Unix socket (peer auth, no password needed)
      }
);

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
// SM-2 Spaced Repetition Algorithm
// ---------------------------------------------------------------------------

const GRADE_MAP = { easy: 5, ok: 3, hard: 1, impossible: 0 };

/**
 * Compute the next SRS card state given a grade.
 * Based on SM-2: https://en.wikipedia.org/wiki/SuperMemo#Description_of_SM-2_algorithm
 *
 * @param {{ ease_factor: number, interval_days: number, repetitions: number }} card
 * @param {string} grade  — 'easy' | 'ok' | 'hard' | 'impossible'
 * @returns {{ ease_factor: number, interval_days: number, repetitions: number, next_review_at: string }}
 */
function computeSrs(card, grade) {
  const q = GRADE_MAP[grade];
  if (q === undefined) throw new Error(`Invalid grade: ${grade}`);

  let { ease_factor: ef, interval_days: interval, repetitions: reps } = card;

  // Update ease factor: EF' = EF + (0.1 - (5-q) * (0.08 + (5-q) * 0.02))
  ef = ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (ef < 1.3) ef = 1.3; // floor

  if (q < 3) {
    // Failed recall — reset
    reps = 0;
    interval = 0;
  } else {
    // Successful recall
    reps += 1;
    if (reps === 1) {
      interval = 1;
    } else if (reps === 2) {
      interval = 6;
    } else {
      interval = Math.round(interval * ef);
    }
  }

  const nextReview = new Date();
  nextReview.setDate(nextReview.getDate() + interval);

  return {
    ease_factor: Math.round(ef * 100) / 100,
    interval_days: interval,
    repetitions: reps,
    next_review_at: nextReview.toISOString(),
  };
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
// POST /api/srs/review  — record an SRS review grade (transactional)
// ---------------------------------------------------------------------------

const SRS_REVIEW_SCHEMA = {
  occlusion_id: 'string',
  grade: 'string',
};

app.post('/api/srs/review', async (req, res) => {
  const { occlusion_id, grade, reviewed_at, last_modified } = req.body;

  // ---- input validation ----
  if (!occlusion_id || typeof occlusion_id !== 'string') {
    return res.status(400).json({ error: '`occlusion_id` is required and must be a string' });
  }
  if (!grade || !GRADE_MAP.hasOwnProperty(grade)) {
    return res.status(400).json({ error: '`grade` must be one of: easy, ok, hard, impossible' });
  }
  const ts = typeof last_modified === 'number' ? last_modified : Date.now();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check the occlusion exists — it may not have synced yet from IDB
    const occRes = await client.query(
      'SELECT id FROM occlusions WHERE id = $1',
      [occlusion_id],
    );
    if (occRes.rows.length === 0) {
      await client.query('ROLLBACK');
      // Occlusion not in DB yet — sync worker will push it within 10s, client can retry
      return res.status(202).json({ queued: true, message: 'Occlusion not yet synced; review will be retried.' });
    }

    // Fetch current card state (or defaults for first review)
    const cardRes = await client.query(
      'SELECT ease_factor, interval_days, repetitions FROM srs_cards WHERE occlusion_id = $1',
      [occlusion_id],
    );
    const currentCard = cardRes.rows.length > 0
      ? cardRes.rows[0]
      : { ease_factor: 2.5, interval_days: 0, repetitions: 0 };

    const newState = computeSrs(currentCard, grade);

    // Upsert srs_cards
    await client.query(
      `INSERT INTO srs_cards (occlusion_id, ease_factor, interval_days, repetitions, next_review_at, last_modified)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (occlusion_id) DO UPDATE SET
         ease_factor   = EXCLUDED.ease_factor,
         interval_days = EXCLUDED.interval_days,
         repetitions   = EXCLUDED.repetitions,
         next_review_at = EXCLUDED.next_review_at,
         last_modified  = EXCLUDED.last_modified
       WHERE srs_cards.last_modified < EXCLUDED.last_modified`,
      [occlusion_id, newState.ease_factor, newState.interval_days, newState.repetitions, newState.next_review_at, ts],
    );

    // Insert review log
    await client.query(
      `INSERT INTO srs_reviews (occlusion_id, grade, reviewed_at, ease_factor_after, interval_days_after, last_modified)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [occlusion_id, grade, reviewed_at || new Date().toISOString(), newState.ease_factor, newState.interval_days, ts],
    );

    await client.query('COMMIT');
    res.json({ success: true, card: { occlusion_id, ...newState } });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[POST /api/srs/review] Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// GET /api/srs/cards/:file_hash  — fetch SRS card states for a document
// ---------------------------------------------------------------------------

app.get('/api/srs/cards/:file_hash', async (req, res) => {
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
      return res.json({ srs_cards: [] });
    }
    const documentId = docRes.rows[0].id;

    const srsRes = await pool.query(
      `SELECT sc.*
       FROM srs_cards sc
       JOIN occlusions o ON o.id = sc.occlusion_id
       WHERE o.document_id = $1 AND sc.last_modified > $2`,
      [documentId, since],
    );

    res.json({ srs_cards: srsRes.rows });
  } catch (error) {
    console.error('[GET /api/srs/cards] Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/srs/sync  — batch upsert pre-computed SRS card states
// ---------------------------------------------------------------------------

app.post('/api/srs/sync', async (req, res) => {
  const { cards } = req.body;

  if (!Array.isArray(cards) || cards.length === 0) {
    return res.status(400).json({ error: '`cards` must be a non-empty array' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const card of cards) {
      if (!card.occlusion_id || typeof card.occlusion_id !== 'string') continue;
      const ts = typeof card.last_modified === 'number' ? card.last_modified : Date.now();

      await client.query(
        `INSERT INTO srs_cards (occlusion_id, ease_factor, interval_days, repetitions, next_review_at, last_modified)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (occlusion_id) DO UPDATE SET
           ease_factor    = EXCLUDED.ease_factor,
           interval_days  = EXCLUDED.interval_days,
           repetitions    = EXCLUDED.repetitions,
           next_review_at = EXCLUDED.next_review_at,
           last_modified  = EXCLUDED.last_modified
         WHERE srs_cards.last_modified < EXCLUDED.last_modified`,
        [
          card.occlusion_id,
          card.ease_factor ?? 2.5,
          card.interval_days ?? 0,
          card.repetitions ?? 0,
          card.next_review_at ?? null,
          ts,
        ],
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, upserted: cards.length });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[POST /api/srs/sync] Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/:file_hash  — all occlusions + SRS state for dashboard
// ---------------------------------------------------------------------------

app.get('/api/dashboard/:file_hash', async (req, res) => {
  try {
    const { file_hash } = req.params;

    const docRes = await pool.query(
      'SELECT id FROM documents WHERE file_hash = $1',
      [file_hash],
    );
    if (docRes.rows.length === 0) {
      return res.json({ cards: [] });
    }
    const documentId = docRes.rows[0].id;

    // Join occlusions with their SRS card state and most recent review
    const result = await pool.query(
      `SELECT
         o.id,
         o.page_index,
         o.bounding_box,
         o.note,
         o.is_deleted,
         sc.ease_factor,
         sc.interval_days,
         sc.repetitions,
         sc.next_review_at,
         sc.last_modified AS card_last_modified,
         (SELECT grade FROM srs_reviews sr WHERE sr.occlusion_id = o.id ORDER BY sr.reviewed_at DESC LIMIT 1) AS last_grade,
         (SELECT COUNT(*) FROM srs_reviews sr WHERE sr.occlusion_id = o.id) AS review_count
       FROM occlusions o
       LEFT JOIN srs_cards sc ON sc.occlusion_id = o.id
       WHERE o.document_id = $1 AND o.is_deleted = FALSE
       ORDER BY sc.next_review_at ASC NULLS FIRST, o.page_index ASC`,
      [documentId],
    );

    res.json({ cards: result.rows });
  } catch (error) {
    console.error('[GET /api/dashboard] Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
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
