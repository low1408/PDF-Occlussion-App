import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'theme';
const listeners = new Set<() => void>();

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // storage blocked: fall back to the system preference
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

let theme: Theme = initialTheme();
// Applied at import time so the first paint already uses the right colours.
document.documentElement.dataset.theme = theme;

function setTheme(next: Theme) {
  theme = next;
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // not remembered, but still applied for this session
  }
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The app-wide theme and a toggle. Defaults to the system setting; the user's choice is remembered. */
export function useTheme(): [Theme, () => void] {
  const current = useSyncExternalStore(subscribe, () => theme);
  return [current, () => setTheme(current === 'dark' ? 'light' : 'dark')];
}
