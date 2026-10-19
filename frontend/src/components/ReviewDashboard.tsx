import { useEffect, useState } from 'react';
import { API_URL } from '../api';
import { requestSync } from '../sync';
import Icon from './Icon';

interface DashboardCard {
  id: string;
  page_index: number;
  bounding_box: number[];
  note: string | null;
  ease_factor: number | null;
  interval_days: number | null;
  repetitions: number | null;
  next_review_at: string | null;
  last_grade: string | null;
  review_count: number | string; // COUNT(*) arrives from Postgres as a string
}

interface ReviewDashboardProps {
  fileHash: string;
  fileName: string;
  onClose: () => void;
  onJumpToPage: (pageIndex: number) => void;
}

interface CardStyle {
  swatch: string;
  text: string;
  label: string;
}

// Colours per last grade, from the theme tokens in index.css.
const GRADE_STYLES: Record<string, CardStyle> = {
  easy:       { swatch: 'var(--grade-easy)', text: 'var(--grade-easy-text)', label: 'Easy' },
  ok:         { swatch: 'var(--grade-ok)', text: 'var(--grade-ok-text)', label: 'OK' },
  hard:       { swatch: 'var(--grade-hard)', text: 'var(--grade-hard-text)', label: 'Hard' },
  impossible: { swatch: 'var(--grade-impossible)', text: 'var(--grade-impossible-text)', label: 'Impossible' },
};
const NEW_STYLE: CardStyle = { swatch: 'var(--mask-ungraded)', text: 'var(--text-muted)', label: 'New' };
const HIGHLIGHT_STYLE: CardStyle = { swatch: 'var(--highlight-border)', text: 'var(--grade-hard-text)', label: 'Highlight' };

function formatDueDate(dateStr: string | null): { label: string; tone: 'overdue' | 'soon' | 'later' | 'never' } {
  if (!dateStr) return { label: 'Never reviewed', tone: 'never' };
  const due = new Date(dateStr);
  const now = new Date();
  const diffMs = due.getTime() - now.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 0)  return { label: `Overdue ${Math.abs(diffDays)}d`, tone: 'overdue' };
  if (diffDays === 0) return { label: 'Due today', tone: 'soon' };
  if (diffDays === 1) return { label: 'Due tomorrow', tone: 'soon' };
  return { label: `Due in ${diffDays}d`, tone: 'later' };
}

const parseNote = (noteStr?: string | null): { text: string; type: 'occlusion' | 'highlight' } => {
  if (!noteStr) return { text: '', type: 'occlusion' };
  try {
    const parsed = JSON.parse(noteStr);
    if (parsed && typeof parsed === 'object' && parsed.type === 'highlight') {
      return { text: parsed.text || '', type: 'highlight' };
    }
  } catch {
    // plain-text note
  }
  return { text: noteStr, type: 'occlusion' };
};

export default function ReviewDashboard({ fileHash, fileName, onClose, onJumpToPage }: ReviewDashboardProps) {
  const [cards, setCards] = useState<DashboardCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'due' | 'page' | 'reps'>('due');

  useEffect(() => {
    setLoading(true);
    // Push local edits first so the dashboard never shows stale or undone masks.
    requestSync()
      .then(() => fetch(`${API_URL}/api/dashboard/${fileHash}`))
      .then(r => r.json())
      .then(data => {
        setCards(data.cards ?? []);
        setLoading(false);
      })
      .catch(() => {
        setError('Could not load dashboard — is the backend running?');
        setLoading(false);
      });
  }, [fileHash]);

  // Escape closes the dashboard.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const filtered = cards
    .filter(c => {
      const noteInfo = parseNote(c.note);
      return !search || noteInfo.text.toLowerCase().includes(search.toLowerCase()) || `Page ${c.page_index}`.includes(search);
    })
    .sort((a, b) => {
      if (sortBy === 'due') {
        if (!a.next_review_at && !b.next_review_at) return 0;
        if (!a.next_review_at) return -1;
        if (!b.next_review_at) return 1;
        return new Date(a.next_review_at).getTime() - new Date(b.next_review_at).getTime();
      }
      if (sortBy === 'page') return a.page_index - b.page_index;
      if (sortBy === 'reps') return (b.repetitions ?? 0) - (a.repetitions ?? 0);
      return 0;
    });

  // Highlights are never reviewed, so they don't count as due or new.
  const masks = cards.filter(c => parseNote(c.note).type !== 'highlight');
  const dueNow = masks.filter(c => !c.next_review_at || new Date(c.next_review_at) <= new Date()).length;
  const neverReviewed = masks.filter(c => !c.next_review_at).length;
  const totalReviews = masks.reduce((sum, c) => sum + Number(c.review_count || 0), 0);
  const distribution: [CardStyle, number][] = [
    [NEW_STYLE, masks.filter(c => !c.last_grade).length],
    ...Object.entries(GRADE_STYLES).map(([grade, style]): [CardStyle, number] => [style, masks.filter(c => c.last_grade === grade).length]),
  ];

  return (
    <div className="dashboard" role="dialog" aria-label="Review dashboard">
      <div className="dashboard-header">
        <div>
          <h2>Review dashboard</h2>
          <div className="subtitle">{fileName}</div>
        </div>
        <div className="dashboard-controls">
          <label className="search-field">
            <Icon name="search" size={14} />
            <input
              placeholder="Search notes or pages"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </label>
          <select
            className="filter-select"
            value={sortBy}
            onChange={e => setSortBy(e.target.value as 'due' | 'page' | 'reps')}
            aria-label="Sort cards"
          >
            <option value="due">Sort by due date</option>
            <option value="page">Sort by page</option>
            <option value="reps">Sort by repetitions</option>
          </select>
          <button className="btn" onClick={onClose}>
            <Icon name="x" size={14} />
            Close
          </button>
        </div>
      </div>

      <div className="dashboard-body">
        <div className="dashboard-inner">
          {loading && <div className="dash-message">Loading cards…</div>}
          {error && <div className="dash-message error">{error}</div>}
          {!loading && !error && (
            <>
              <div className="stat-tiles">
                <StatTile label="Due now" value={dueNow} className="due" />
                <StatTile label="New" value={neverReviewed} />
                <StatTile label="Masks" value={masks.length} />
                <StatTile label="Reviews logged" value={totalReviews} />
              </div>

              {masks.length > 0 && (
                <div className="grade-distribution">
                  <div className="title">Masks by last grade</div>
                  <div className="bar">
                    {distribution.filter(([, n]) => n > 0).map(([style, n]) => (
                      <span key={style.label} style={{ flexGrow: n, ['--swatch' as string]: style.swatch }} title={`${style.label}: ${n}`} />
                    ))}
                  </div>
                  <div className="legend">
                    {distribution.map(([style, n]) => (
                      <span key={style.label}>
                        <i className="swatch" style={{ ['--swatch' as string]: style.swatch }} />
                        {style.label} {n}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {filtered.length === 0 ? (
                <div className="dash-message">
                  {cards.length === 0
                    ? 'No masks yet. Press D to switch to Draw Mode and drag over the text you want to hide.'
                    : 'No cards match your search.'}
                </div>
              ) : (
                <div className="dash-grid">
                  {filtered.map(card => {
                    const { label: dueLabel, tone } = formatDueDate(card.next_review_at);
                    const noteInfo = parseNote(card.note);
                    const isHighlight = noteInfo.type === 'highlight';
                    const style = isHighlight ? HIGHLIGHT_STYLE : GRADE_STYLES[card.last_grade ?? ''] ?? NEW_STYLE;

                    return (
                      <div key={card.id} className="dash-card" style={{ ['--swatch' as string]: style.swatch }}>
                        <div className="dash-card-top">
                          <span className="dash-page">PAGE {card.page_index}</span>
                          <span className="grade-badge" style={{ ['--badge-text' as string]: style.text }}>{style.label}</span>
                        </div>

                        <div className={`dash-note ${noteInfo.text ? '' : 'empty'}`}>
                          {noteInfo.text || 'No note'}
                        </div>

                        {!isHighlight && (
                          <div className="stat-pills">
                            <StatPill label="Ease" value={card.ease_factor ? card.ease_factor.toFixed(2) : '—'} />
                            <StatPill label="Interval" value={card.interval_days != null ? `${card.interval_days}d` : '—'} />
                            <StatPill label="Reviews" value={String(card.review_count)} />
                          </div>
                        )}

                        <div className="dash-card-footer">
                          <span className={`due-label ${tone}`}>{!isHighlight && dueLabel}</span>
                          <button
                            className="btn btn-sm btn-primary"
                            onClick={() => { onJumpToPage(card.page_index); onClose(); }}
                          >
                            Go to page →
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function StatTile({ label, value, className = '' }: { label: string; value: number; className?: string }) {
  return (
    <div className={`stat-tile ${className}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-pill">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
    </div>
  );
}
