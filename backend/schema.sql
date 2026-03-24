-- PDF Occlusion Engine — Database Schema
-- Run this ONCE against your PostgreSQL database before starting the server:
--   psql -d occlusion_engine -f schema.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_hash VARCHAR(64) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS occlusions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    page_index INTEGER NOT NULL,
    bounding_box JSONB NOT NULL,
    note TEXT,
    is_deleted BOOLEAN DEFAULT FALSE,
    last_modified BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookmarks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    page_index INTEGER NOT NULL,
    title TEXT,
    is_deleted BOOLEAN DEFAULT FALSE,
    last_modified BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS srs_cards (
    occlusion_id UUID PRIMARY KEY REFERENCES occlusions(id) ON DELETE CASCADE,
    ease_factor REAL NOT NULL DEFAULT 2.5,
    interval_days INTEGER NOT NULL DEFAULT 0,
    repetitions INTEGER NOT NULL DEFAULT 0,
    next_review_at TIMESTAMP WITH TIME ZONE,
    last_modified BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS srs_reviews (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    occlusion_id UUID NOT NULL REFERENCES occlusions(id) ON DELETE CASCADE,
    grade VARCHAR(12) NOT NULL CHECK (grade IN ('easy', 'ok', 'hard', 'impossible')),
    reviewed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ease_factor_after REAL NOT NULL,
    interval_days_after INTEGER NOT NULL,
    last_modified BIGINT NOT NULL
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_occlusions_document_page ON occlusions(document_id, page_index);
CREATE INDEX IF NOT EXISTS idx_occlusions_last_modified ON occlusions(last_modified);
CREATE INDEX IF NOT EXISTS idx_bookmarks_document ON bookmarks(document_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_last_modified ON bookmarks(last_modified);
CREATE INDEX IF NOT EXISTS idx_srs_cards_next_review ON srs_cards(next_review_at);
CREATE INDEX IF NOT EXISTS idx_srs_cards_last_modified ON srs_cards(last_modified);
CREATE INDEX IF NOT EXISTS idx_srs_reviews_occlusion ON srs_reviews(occlusion_id);
CREATE INDEX IF NOT EXISTS idx_srs_reviews_last_modified ON srs_reviews(last_modified);
