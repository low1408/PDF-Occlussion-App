# PDF Occlusion App

A PDF occlusion study app with a React + Vite frontend and an Express + PostgreSQL backend. It supports occlusions, bookmarks, and spaced‑repetition (SM‑2) review data.

## Features
- Create and sync PDF occlusions per document
- Bookmark pages
- Spaced repetition (SM‑2) review scheduling
- Local/offline‑friendly sync primitives

## Tech Stack
- **Frontend:** React, TypeScript, Vite, Zustand, pdfjs
- **Backend:** Node.js, Express, PostgreSQL
- **Storage:** PostgreSQL schema in `backend/schema.sql`

## Repository Layout
```
.
├── backend
│   ├── index.js
│   ├── package.json
│   └── schema.sql
└── frontend
    ├── package.json
    ├── vite.config.ts
    └── src/
```

## Prerequisites
- Node.js 18+ (recommended)
- PostgreSQL 14+ (recommended)

## Quick Start

### 1) Backend (API + DB)
```bash
cd backend
npm install
```

Initialize the database:
```bash
psql -d occlusion_engine -f schema.sql
```

Run the server:
```bash
node index.js
```

By default the server connects via local Unix socket using:
- **user:** `harry`
- **database:** `occlusion_engine`
- **host:** `/var/run/postgresql`

To override, set `DATABASE_URL`:
```bash
export DATABASE_URL="postgres://user:pass@localhost:5432/occlusion_engine"
```

The server runs on `PORT=3000` by default.

### 2) Frontend (UI)
```bash
cd frontend
npm install
npm run dev
```

Vite will print the local dev URL.

## API Overview

### Health
- `GET /health` — DB connectivity check

### Occlusions
- `GET /api/sync/:file_hash?since=TIMESTAMP`
- `POST /api/sync`

### Bookmarks
- `GET /api/bookmarks/:file_hash?since=TIMESTAMP`
- `POST /api/bookmarks/sync`

### Spaced Repetition (SRS)
- `POST /api/srs/review`
- `GET /api/srs/cards/:file_hash?since=TIMESTAMP`
- `POST /api/srs/sync`
- `GET /api/dashboard/:file_hash`

> All sync endpoints expect timestamps in milliseconds and use last‑write‑wins logic where applicable.

## Development Notes
- The backend verifies DB connectivity at startup and exits with a helpful message if the schema isn’t initialized.
- Frontend uses Vite + React with TypeScript and Zustand for state management.

## Contributing
Pull requests and issues are welcome. Please include context, reproduction steps, and screenshots where helpful.

## License
No license has been specified yet.
