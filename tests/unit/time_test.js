const t = require('../../src/utils/time');
const business = require('../../src/config/business');

const zone = 'Africa/Cairo';
const d = (iso) => new Date(iso);

describe('parseInstant', () => {
  test('reads a time without offset as local Cairo time', () => {
    expect(t.parseInstant('2026-11-10T19:00', zone)).toEqual(d('2026-11-10T17:00:00Z')); // UTC+2 in winter
    expect(t.parseInstant('2026-07-10T19:00', zone)).toEqual(d('2026-07-10T16:00:00Z')); // UTC+3 in summer (DST)
  });
  test('respects an explicit offset or Z', () => {
    expect(t.parseInstant('2026-11-10T19:00:00Z', zone)).toEqual(d('2026-11-10T19:00:00Z'));
    expect(t.parseInstant('2026-11-10T19:00:00+05:00', zone)).toEqual(d('2026-11-10T14:00:00Z'));
  });
  test.each([['nonsense'], [''], [null], [undefined], [12345], ['2026-13-40T10:00']])('rejects %p', (value) => {
    expect(t.parseInstant(value, zone)).toBeNull();
  });
});

describe('slot helpers', () => {
  const at = (iso) => t.zoned(t.parseInstant(iso, zone), zone);

  test('isOnSlotBoundary needs :00 or :30 with no seconds', () => {
    expect(t.isOnSlotBoundary(at('2026-11-10T19:00'), 30)).toBe(true);
    expect(t.isOnSlotBoundary(at('2026-11-10T19:30'), 30)).toBe(true);
    expect(t.isOnSlotBoundary(at('2026-11-10T19:15'), 30)).toBe(false);
    expect(t.isOnSlotBoundary(at('2026-11-10T19:00:30'), 30)).toBe(false);
  });

  test('reservationSlots lists 13 slots from 16:00 to 22:00', () => {
    const slots = t.reservationSlots('2026-11-10', { zone, ...business });
    expect(slots).toHaveLength(13);
    expect(slots[0]).toEqual(t.parseInstant('2026-11-10T16:00', zone));
    expect(slots[12]).toEqual(t.parseInstant('2026-11-10T22:00', zone));
    expect(t.reservationSlots('not-a-date', { zone, ...business })).toEqual([]);
  });

  test('localTime(1440) is the start of the next day, the closing instant', () => {
    expect(t.localTime(at('2026-11-10T19:00'), 1440)).toEqual(t.zoned(t.parseInstant('2026-11-11T00:00', zone), zone));
    expect(t.localTime(at('2026-11-10T19:00'), 960).toJSDate()).toEqual(t.parseInstant('2026-11-10T16:00', zone));
  });
});

describe('dayBounds', () => {
  test('a normal day is 24 hours', () => {
    const { start, end } = t.dayBounds('2026-11-10', zone);
    expect(end - start).toBe(24 * 3600 * 1000);
    expect(start).toEqual(d('2026-11-09T22:00:00Z'));
  });
  test('DST days are 23 or 25 hours long, never assumed to be 24', () => {
    const spring = t.dayBounds('2026-04-24', zone); // Egypt moves clocks forward at midnight
    expect((spring.end - spring.start) / 3600000).toBe(23);
    const autumn = t.dayBounds('2026-10-29', zone); // and back one hour at the end of that Thursday
    expect((autumn.end - autumn.start) / 3600000).toBe(25);
  });
  test('stays correct on a DST day: 16:00 is still 16:00 local, midnight is still the day end', () => {
    const day = t.zoned(t.dayBounds('2026-04-24', zone).start, zone);
    expect(t.localTime(day, 960).hour).toBe(16);
    expect(t.localTime(day, 1440).toJSDate()).toEqual(t.dayBounds('2026-04-24', zone).end);
  });
  test('rejects malformed or impossible dates', () => {
    expect(t.dayBounds('2026-02-30', zone)).toBeNull();
    expect(t.dayBounds('10/11/2026', zone)).toBeNull();
    expect(t.dayBounds(undefined, zone)).toBeNull();
  });
});

describe('misc', () => {
  test('floorToMinute / addMinutes / addDays', () => {
    expect(t.floorToMinute(d('2026-11-10T17:00:45.500Z'))).toEqual(d('2026-11-10T17:00:00Z'));
    expect(t.addMinutes(d('2026-11-10T17:00:00Z'), 120)).toEqual(d('2026-11-10T19:00:00Z'));
    expect(t.addDays(d('2026-11-10T17:00:00Z'), 30)).toEqual(d('2026-12-10T17:00:00Z'));
  });
  test('localDateString formats in the business zone, not UTC', () => {
    expect(t.localDateString(d('2026-11-10T22:30:00Z'), zone)).toBe('2026-11-11'); // already tomorrow in Cairo
  });
  test('minuteBuckets covers [start, end) minute by minute', () => {
    const start = d('2026-11-10T17:00:00Z');
    const buckets = t.minuteBuckets(start, t.addMinutes(start, 120));
    expect(buckets).toHaveLength(120);
    expect(buckets[0]).toBe(Math.floor(start / 60000));
    expect(buckets[119]).toBe(Math.floor(start / 60000) + 119);
  });
  test('adjacent windows share no bucket, overlapping windows do', () => {
    const a = d('2026-11-10T17:00:00Z');
    const b = t.addMinutes(a, 120); // starts exactly when a ends
    const c = t.addMinutes(a, 119);
    const bucketsA = new Set(t.minuteBuckets(a, t.addMinutes(a, 120)));
    expect(t.minuteBuckets(b, t.addMinutes(b, 120)).some((m) => bucketsA.has(m))).toBe(false);
    expect(t.minuteBuckets(c, t.addMinutes(c, 120)).some((m) => bucketsA.has(m))).toBe(true);
  });
});
