import { describe, expect, it } from 'vitest';
import { hungarianToday, toHeaderTimestamp, toNavDate, toSignatureTimestamp } from '../src/time.js';

describe('hungarianToday', () => {
  it('is the Hungarian date, not the UTC date, just after local midnight (CEST)', () => {
    // 22:30Z in September is 00:30 the next day in Hungary (UTC+2).
    expect(hungarianToday(new Date('2026-09-03T22:30:00Z'))).toBe('2026-09-04');
  });

  it('is the Hungarian date just after local midnight in winter (CET)', () => {
    // 23:30Z in January is 00:30 the next day in Hungary (UTC+1).
    expect(hungarianToday(new Date('2026-01-03T23:30:00Z'))).toBe('2026-01-04');
  });

  it('agrees with the UTC date during the Hungarian day', () => {
    expect(hungarianToday(new Date('2026-09-04T09:00:00Z'))).toBe('2026-09-04');
  });
});

describe('timestamp rendering', () => {
  const instant = '2026-09-03T14:25:11.482Z';

  it('renders the header timestamp in UTC with milliseconds', () => {
    expect(toHeaderTimestamp(instant)).toBe('2026-09-03T14:25:11.482Z');
  });

  it('renders the signature timestamp as whole seconds, no separators', () => {
    expect(toSignatureTimestamp(instant)).toBe('20260903142511');
  });

  it('passes through an already-formatted NAV date', () => {
    expect(toNavDate('2026-09-03')).toBe('2026-09-03');
  });
});
