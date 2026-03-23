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
    id UUID PRIMARY KEY,
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    page_index INTEGER NOT NULL,
    bounding_box JSONB NOT NULL,
    note TEXT,
    is_deleted BOOLEAN DEFAULT FALSE,
    last_modified BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookmarks (
    id UUID PRIMARY KEY,
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    page_index INTEGER NOT NULL,
    title TEXT,
    is_deleted BOOLEAN DEFAULT FALSE,
    last_modified BIGINT NOT NULL
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_occlusions_document_page ON occlusions(document_id, page_index);
CREATE INDEX IF NOT EXISTS idx_occlusions_last_modified ON occlusions(last_modified);
CREATE INDEX IF NOT EXISTS idx_bookmarks_document ON bookmarks(document_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_last_modified ON bookmarks(last_modified);
