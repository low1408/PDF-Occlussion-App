// SM-2 scheduling with Anki-style grades: Impossible is a lapse; Hard, OK and Easy all pass.
// Keep in sync with computeSrs in backend/index.js (used when a client sends no card state).

export type SrsGrade = 'easy' | 'ok' | 'hard' | 'impossible';

export interface SrsState {
  ease_factor: number;
  interval_days: number;
  repetitions: number;
}

export const NEW_CARD: SrsState = { ease_factor: 2.5, interval_days: 0, repetitions: 0 };

// SM-2 quality (0–5) per grade: Hard lowers the ease factor, OK keeps it, Easy raises it.
const QUALITY: Record<SrsGrade, number> = { easy: 5, ok: 4, hard: 3, impossible: 0 };

// Hard passes but grows the interval far less than OK's ease-factor multiplier.
const HARD_INTERVAL_FACTOR = 1.2;

export function computeSrs(card: SrsState, grade: SrsGrade, now = new Date()) {
  const q = QUALITY[grade];
  const ef = Math.max(1.3, card.ease_factor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));

  // OK and Easy always land at least a day past Hard; at low ease, interval × ease can round down to it.
  const hardInterval = Math.max(card.interval_days + 1, Math.round(card.interval_days * HARD_INTERVAL_FACTOR));

  let reps = 0;
  let interval = 0; // lapse: due again straight away
  if (grade !== 'impossible') {
    reps = card.repetitions + 1;
    if (reps === 1) interval = 1;
    else if (grade === 'hard') interval = hardInterval;
    else interval = Math.max(hardInterval + 1, reps === 2 ? 6 : Math.round(card.interval_days * ef));
  }

  const nextReview = new Date(now);
  nextReview.setDate(nextReview.getDate() + interval);

  return {
    ease_factor: Math.round(ef * 100) / 100,
    interval_days: interval,
    repetitions: reps,
    next_review_at: nextReview.toISOString(),
  };
}

/** Short label for an interval, e.g. "now", "6d", "3mo", "1.2y". */
export function formatInterval(days: number): string {
  if (days <= 0) return 'now';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${Math.round((days / 365) * 10) / 10}y`;
}
