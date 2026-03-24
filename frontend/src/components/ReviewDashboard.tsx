import { useEffect, useState } from 'react';

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
  review_count: number;
}

interface ReviewDashboardProps {
  fileHash: string;
  onClose: () => void;
  onJumpToPage: (pageIndex: number) => void;
}

const GRADE_COLORS: Record<string, string> = {
  easy:       '#22c55e',
  ok:         '#3b82f6',
  hard:       '#f59e0b',
  impossible: '#ef4444',
};

function formatDueDate(dateStr: string | null): { label: string; color: string } {
  if (!dateStr) return { label: 'Never reviewed', color: '#94a3b8' };
  const due = new Date(dateStr);
  const now = new Date();
  const diffMs = due.getTime() - now.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 0)  return { label: `Overdue ${Math.abs(diffDays)}d`, color: '#ef4444' };
  if (diffDays === 0) return { label: 'Due today', color: '#f59e0b' };
  if (diffDays === 1) return { label: 'Due tomorrow', color: '#f59e0b' };
  return { label: `Due in ${diffDays}d`, color: '#22c55e' };
}

export default function ReviewDashboard({ fileHash, onClose, onJumpToPage }: ReviewDashboardProps) {
  const [cards, setCards] = useState<DashboardCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'due' | 'page' | 'reps'>('due');

  useEffect(() => {
    setLoading(true);
    fetch(`http://localhost:3000/api/dashboard/${fileHash}`)
      .then(r => r.json())
      .then(data => {
        setCards(data.cards ?? []);
        setLoading(false);
      })
      .catch(_err => {
        setError('Could not load dashboard — is the backend running?');
        setLoading(false);
      });
  }, [fileHash]);

  const filtered = cards
    .filter(c => !search || c.note?.toLowerCase().includes(search.toLowerCase()) || `Page ${c.page_index}`.includes(search))
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

  const dueNow = cards.filter(c => !c.next_review_at || new Date(c.next_review_at) <= new Date()).length;
  const neverReviewed = cards.filter(c => !c.next_review_at).length;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 10000,
      background: 'rgba(0,0,0,0.85)',
      display: 'flex', flexDirection: 'column',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '16px',
        padding: '16px 24px', background: '#0f172a',
        borderBottom: '1px solid #1e293b', flexShrink: 0,
      }}>
        <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f1f5f9' }}>
          📊 SRS Dashboard
        </div>
        <div style={{ display: 'flex', gap: '12px', marginLeft: '8px' }}>
          <span style={{ background: '#ef4444', color: '#fff', borderRadius: '8px', padding: '2px 10px', fontSize: '0.85rem', fontWeight: 600 }}>
            {dueNow} due
          </span>
          <span style={{ background: '#475569', color: '#cbd5e1', borderRadius: '8px', padding: '2px 10px', fontSize: '0.85rem' }}>
            {cards.length} total
          </span>
          {neverReviewed > 0 && (
            <span style={{ background: '#1e293b', color: '#94a3b8', borderRadius: '8px', padding: '2px 10px', fontSize: '0.85rem' }}>
              {neverReviewed} new
            </span>
          )}
        </div>

        {/* Controls */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '12px', alignItems: 'center' }}>
          <input
            placeholder="🔍 Search by note or page..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              background: '#1e293b', border: '1px solid #334155', color: '#f1f5f9',
              borderRadius: '8px', padding: '6px 12px', fontSize: '0.9rem', width: '220px',
            }}
          />
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value as any)}
            style={{
              background: '#1e293b', border: '1px solid #334155', color: '#f1f5f9',
              borderRadius: '8px', padding: '6px 10px', fontSize: '0.9rem',
            }}
          >
            <option value="due">Sort: Due date</option>
            <option value="page">Sort: Page</option>
            <option value="reps">Sort: Repetitions</option>
          </select>
          <button
            onClick={onClose}
            style={{
              background: '#334155', color: '#f1f5f9', border: 'none',
              borderRadius: '8px', padding: '6px 16px', cursor: 'pointer',
              fontSize: '0.95rem', fontWeight: 600,
            }}
          >
            ✕ Close
          </button>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
        {loading && (
          <div style={{ color: '#94a3b8', textAlign: 'center', marginTop: '60px', fontSize: '1.1rem' }}>
            Loading cards...
          </div>
        )}
        {error && (
          <div style={{ color: '#ef4444', textAlign: 'center', marginTop: '60px', fontSize: '1rem' }}>
            {error}
          </div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <div style={{ color: '#64748b', textAlign: 'center', marginTop: '60px', fontSize: '1rem' }}>
            {cards.length === 0
              ? 'No occlusions synced to backend yet. Make sure the server is running and wait 10s for the sync.'
              : 'No cards match your search.'}
          </div>
        )}
        {!loading && !error && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '16px' }}>
            {filtered.map(card => {
              const { label: dueLabel, color: dueColor } = formatDueDate(card.next_review_at);
              return (
                <div
                  key={card.id}
                  style={{
                    background: '#1e293b', borderRadius: '12px',
                    border: '1px solid #334155', padding: '18px',
                    display: 'flex', flexDirection: 'column', gap: '10px',
                    transition: 'border-color 0.15s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = '#60a5fa')}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = '#334155')}
                >
                  {/* Top row */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <span style={{ color: '#94a3b8', fontSize: '0.82rem', fontWeight: 600, letterSpacing: '0.05em' }}>
                      PAGE {card.page_index}
                    </span>
                    {card.last_grade && (
                      <span style={{
                        background: GRADE_COLORS[card.last_grade] + '22',
                        color: GRADE_COLORS[card.last_grade],
                        border: `1px solid ${GRADE_COLORS[card.last_grade]}55`,
                        borderRadius: '6px', padding: '2px 8px',
                        fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase',
                      }}>
                        {card.last_grade}
                      </span>
                    )}
                    {!card.last_grade && (
                      <span style={{ color: '#475569', fontSize: '0.78rem' }}>New card</span>
                    )}
                  </div>

                  {/* Note */}
                  <div style={{
                    color: card.note ? '#e2e8f0' : '#475569',
                    fontSize: '0.95rem', minHeight: '40px',
                    fontStyle: card.note ? 'normal' : 'italic',
                  }}>
                    {card.note || 'No note'}
                  </div>

                  {/* Stats row */}
                  <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                    <StatPill label="Ease" value={card.ease_factor ? card.ease_factor.toFixed(2) : '—'} />
                    <StatPill label="Interval" value={card.interval_days != null ? `${card.interval_days}d` : '—'} />
                    <StatPill label="Reviews" value={String(card.review_count)} />
                  </div>

                  {/* Due date + jump button */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                    <span style={{ color: dueColor, fontSize: '0.85rem', fontWeight: 600 }}>
                      ⏰ {dueLabel}
                    </span>
                    <button
                      onClick={() => { onJumpToPage(card.page_index); onClose(); }}
                      style={{
                        background: '#3b82f6', color: '#fff', border: 'none',
                        borderRadius: '8px', padding: '5px 14px',
                        cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600,
                      }}
                    >
                      Go to page →
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      background: '#0f172a', borderRadius: '6px', padding: '3px 10px',
      display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: '52px',
    }}>
      <span style={{ color: '#64748b', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase' }}>{label}</span>
      <span style={{ color: '#94a3b8', fontSize: '0.9rem', fontWeight: 700 }}>{value}</span>
    </div>
  );
}
