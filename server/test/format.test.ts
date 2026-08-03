import { describe, expect, it } from 'vitest';
import { localResetTime, parseResetTime } from '../src/ui/format.js';

// Mid-window reference point, so year inference has no edge case to hit.
const NOW = new Date('2026-08-03T00:30:00Z');

describe('parseResetTime', () => {
  it('reads the CLI format as UTC', () => {
    expect(parseResetTime('Aug 3, 1:09am (UTC)', NOW)?.toISOString()).toBe(
      '2026-08-03T01:09:00.000Z',
    );
  });

  it('reads an hour with no minutes and a pm meridiem', () => {
    expect(parseResetTime('Aug 7, 8pm (UTC)', NOW)?.toISOString()).toBe('2026-08-07T20:00:00.000Z');
  });

  it('handles noon and midnight', () => {
    expect(parseResetTime('Aug 3, 12:00am (UTC)', NOW)?.getUTCHours()).toBe(0);
    expect(parseResetTime('Aug 3, 12:00pm (UTC)', NOW)?.getUTCHours()).toBe(12);
  });

  it('infers the nearest year across a December boundary', () => {
    const december = new Date('2026-12-31T23:00:00Z');
    expect(parseResetTime('Jan 1, 4:00am (UTC)', december)?.toISOString()).toBe(
      '2027-01-01T04:00:00.000Z',
    );
    const january = new Date('2027-01-01T02:00:00Z');
    expect(parseResetTime('Dec 31, 11:00pm (UTC)', january)?.toISOString()).toBe(
      '2026-12-31T23:00:00.000Z',
    );
  });

  it('returns null for anything not in the expected shape', () => {
    expect(parseResetTime('soon', NOW)).toBeNull();
    expect(parseResetTime('Aug 3, 1:09am', NOW)).toBeNull(); // no (UTC) marker
    expect(parseResetTime('Foo 3, 1:09am (UTC)', NOW)).toBeNull();
  });
});

describe('localResetTime', () => {
  it('converts UTC to the viewer time zone, including the date rolling back', () => {
    expect(
      localResetTime('Aug 3, 1:09am (UTC)', {
        now: NOW,
        timeZone: 'America/Los_Angeles',
        locale: 'en-US',
      }),
    ).toBe('Aug 2, 6:09pm PDT');
  });

  it('rolls the date forward for zones ahead of UTC', () => {
    expect(
      localResetTime('Aug 7, 8pm (UTC)', {
        now: NOW,
        timeZone: 'Asia/Tokyo',
        locale: 'en-US',
      }),
    ).toMatch(/^Aug 8, 5:00am/);
  });

  it('still renders sensibly for a viewer already on UTC', () => {
    expect(
      localResetTime('Aug 3, 1:09am (UTC)', { now: NOW, timeZone: 'UTC', locale: 'en-US' }),
    ).toBe('Aug 3, 1:09am UTC');
  });

  it('passes unparseable text through rather than dropping it', () => {
    expect(localResetTime('resets when it resets', { now: NOW })).toBe('resets when it resets');
  });
});
