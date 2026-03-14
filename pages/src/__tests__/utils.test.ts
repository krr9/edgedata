import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  escapeHtml,
  formatTimeCompact,
  sortEventsNewestFirst,
  readLevelCount,
  maxFacetCount,
  parseViewMode,
  readStoredThemePreference,
  readSystemPrefersDark,
  extractHighlightTerms,
  jsonSyntaxHtml
} from '../utils';
import { THEME_STORAGE_KEY } from '../constants';
import type { LogEvent, FacetItem } from '../types';

describe('escapeHtml', () => {
  it('escapes ampersand', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });
  it('escapes less-than and greater-than', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });
  it('escapes double and single quotes', () => {
    expect(escapeHtml('"foo" \'bar\'')).toBe('&quot;foo&quot; &#39;bar&#39;');
  });
  it('escapes all dangerous characters together', () => {
    expect(escapeHtml('& < > " \'')).toBe('&amp; &lt; &gt; &quot; &#39;');
  });
});

describe('formatTimeCompact', () => {
  it('formats ISO timestamp as HH:mm:ss.SSS', () => {
    const result = formatTimeCompact('2026-03-12T14:30:45.123Z');
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });
  it('pads single-digit hours, minutes, seconds', () => {
    const result = formatTimeCompact('2026-03-12T09:05:03.007Z');
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });
});

describe('sortEventsNewestFirst', () => {
  it('sorts events by ts descending', () => {
    const events: LogEvent[] = [
      { event_id: 'a', ts: '2026-03-12T10:00:00Z', service: 's', env: 'e', host: 'h', level: 'info', message: 'm' },
      { event_id: 'b', ts: '2026-03-12T12:00:00Z', service: 's', env: 'e', host: 'h', level: 'info', message: 'm' },
      { event_id: 'c', ts: '2026-03-12T11:00:00Z', service: 's', env: 'e', host: 'h', level: 'info', message: 'm' }
    ];
    const sorted = sortEventsNewestFirst(events);
    expect(sorted[0].ts).toBe('2026-03-12T12:00:00Z');
    expect(sorted[1].ts).toBe('2026-03-12T11:00:00Z');
    expect(sorted[2].ts).toBe('2026-03-12T10:00:00Z');
  });
  it('uses event_id as tiebreaker when ts is equal', () => {
    const events: LogEvent[] = [
      { event_id: 'a', ts: '2026-03-12T10:00:00Z', service: 's', env: 'e', host: 'h', level: 'info', message: 'm' },
      { event_id: 'c', ts: '2026-03-12T10:00:00Z', service: 's', env: 'e', host: 'h', level: 'info', message: 'm' },
      { event_id: 'b', ts: '2026-03-12T10:00:00Z', service: 's', env: 'e', host: 'h', level: 'info', message: 'm' }
    ];
    const sorted = sortEventsNewestFirst(events);
    expect(sorted.map((e) => e.event_id)).toEqual(['c', 'b', 'a']);
  });
});

describe('readLevelCount', () => {
  it('returns count for matching level', () => {
    const levels: FacetItem[] = [
      { value: 'error', count: 5 },
      { value: 'warn', count: 3 },
      { value: 'info', count: 10 }
    ];
    expect(readLevelCount(levels, 'error')).toBe(5);
    expect(readLevelCount(levels, 'warn')).toBe(3);
  });
  it('returns 0 for non-matching level', () => {
    const levels: FacetItem[] = [{ value: 'error', count: 5 }];
    expect(readLevelCount(levels, 'info')).toBe(0);
  });
  it('returns 0 for empty levels', () => {
    expect(readLevelCount([], 'error')).toBe(0);
  });
});

describe('maxFacetCount', () => {
  it('returns max count from items', () => {
    const items: FacetItem[] = [
      { value: 'a', count: 2 },
      { value: 'b', count: 10 },
      { value: 'c', count: 5 }
    ];
    expect(maxFacetCount(items)).toBe(10);
  });
  it('returns at least 1 for empty items', () => {
    expect(maxFacetCount([])).toBe(1);
  });
  it('returns at least 1 when all counts are 0', () => {
    expect(maxFacetCount([{ value: 'a', count: 0 }])).toBe(1);
  });
});

describe('parseViewMode', () => {
  it('returns valid view mode when input matches', () => {
    expect(parseViewMode('search')).toBe('search');
    expect(parseViewMode('dashboard')).toBe('dashboard');
    expect(parseViewMode('saved')).toBe('saved');
    expect(parseViewMode('scheduled')).toBe('scheduled');
    expect(parseViewMode('alerts')).toBe('alerts');
    expect(parseViewMode('admin')).toBe('admin');
    expect(parseViewMode('livetail')).toBe('livetail');
    expect(parseViewMode('workspace')).toBe('workspace');
  });
  it('trims and strips leading #', () => {
    expect(parseViewMode('  search  ')).toBe('search');
    expect(parseViewMode('#search')).toBe('search');
  });
  it('returns null for empty or invalid input', () => {
    expect(parseViewMode(null)).toBe(null);
    expect(parseViewMode('')).toBe(null);
    expect(parseViewMode('invalid')).toBe(null);
  });
  it('extracts nested tab param from hash-like string', () => {
    expect(parseViewMode('?tab=search')).toBe('search');
    expect(parseViewMode('?tab=dashboard')).toBe('dashboard');
  });
  it('returns null for invalid nested tab', () => {
    expect(parseViewMode('?tab=invalid')).toBe(null);
  });
});

describe('readStoredThemePreference', () => {
  it('returns light when localStorage has light', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => 'light'
    });
    expect(readStoredThemePreference()).toBe('light');
    vi.unstubAllGlobals();
  });
  it('returns dark when localStorage has dark', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => 'dark'
    });
    expect(readStoredThemePreference()).toBe('dark');
    vi.unstubAllGlobals();
  });
  it('returns system for other or missing values', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null
    });
    expect(readStoredThemePreference()).toBe('system');
    vi.stubGlobal('localStorage', {
      getItem: () => 'invalid'
    });
    expect(readStoredThemePreference()).toBe('system');
    vi.unstubAllGlobals();
  });
});

describe('readSystemPrefersDark', () => {
  const originalMatchMedia = globalThis.matchMedia;

  afterEach(() => {
    vi.stubGlobal('matchMedia', originalMatchMedia);
  });

  it('returns true when matchMedia reports dark preference', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(readSystemPrefersDark()).toBe(true);
  });
  it('returns false when matchMedia reports light preference', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(readSystemPrefersDark()).toBe(false);
  });
});

describe('extractHighlightTerms', () => {
  it('extracts free-text tokens from query', () => {
    expect(extractHighlightTerms('error timeout 500')).toContain('error');
    expect(extractHighlightTerms('error timeout 500')).toContain('timeout');
  });
  it('extracts terms from quoted phrases', () => {
    const terms = extractHighlightTerms('"connection refused"');
    expect(terms).toContain('connection');
    expect(terms).toContain('refused');
  });
  it('filters out operators and short tokens', () => {
    const terms = extractHighlightTerms('status=500 x=1 ab');
    expect(terms).not.toContain('status');
    expect(terms).not.toContain('500');
    expect(terms).not.toContain('x');
    expect(terms).not.toContain('1');
  });
  it('returns empty array for empty query', () => {
    expect(extractHighlightTerms('')).toEqual([]);
    expect(extractHighlightTerms('   ')).toEqual([]);
  });
  it('deduplicates and lowercases', () => {
    const terms = extractHighlightTerms('Error ERROR error');
    expect(terms).toHaveLength(1);
    expect(terms[0]).toBe('error');
  });
});

describe('jsonSyntaxHtml', () => {
  it('escapes raw JSON for XSS safety (lt and gt)', () => {
    const raw = '{"key": "<script>alert(1)</script>"}';
    const result = jsonSyntaxHtml(raw);
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });
  it('escapes ampersand, less-than, greater-than, and quotes', () => {
    const raw = '{"x": "a & b < >"}';
    const result = jsonSyntaxHtml(raw);
    expect(result).toContain('&amp;');
    expect(result).toContain('&lt;');
    expect(result).toContain('&gt;');
    expect(result).toContain('&quot;');
    expect(result).not.toContain('<script>');
  });
  it('applies syntax highlighting for numbers, booleans, and null', () => {
    const result = jsonSyntaxHtml('{"num": 42, "bool": true, "n": null}');
    expect(result).toContain('json-number');
    expect(result).toContain('json-bool');
    expect(result).toContain('json-null');
  });
});
