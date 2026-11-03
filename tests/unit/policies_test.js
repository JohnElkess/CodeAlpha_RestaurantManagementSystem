const business = require('../../src/config/business');
const { FixedClock } = require('../../src/utils/clock');
const { parseInstant } = require('../../src/utils/time');
const { ReservationPolicyFactory } = require('../../src/policies/reservation_policy');
const { TakeawayOrderPolicy } = require('../../src/policies/order_policy');

const local = (text) => parseInstant(text, business.timezone);
const clockAt = (text) => new FixedClock(local(text));

const slotPolicy = (now) => new ReservationPolicyFactory({ clock: clockAt(now), business }).forSource('online');
const walkInPolicy = (now) => new ReservationPolicyFactory({ clock: clockAt(now), business }).forSource('walk_in');
const takeaway = (now) => new TakeawayOrderPolicy({ clock: clockAt(now), business });

const codeOf = (fn) => {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
};
const asyncCodeOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err.code;
  }
  return null;
};

describe('reservation policy: online and phone bookings (scope 2.2)', () => {
  const NOW = '2026-11-10T17:00';

  test('a valid slot gets a fixed two-hour stay', () => {
    const { start, end } = slotPolicy(NOW).resolveWindow({ startTime: '2026-11-10T19:00' });
    expect(start).toEqual(local('2026-11-10T19:00'));
    expect(end).toEqual(local('2026-11-10T21:00'));
  });

  test('the first (16:00) and last (22:00) slots are bookable, and the last stay ends exactly at midnight', () => {
    expect(slotPolicy(NOW).resolveWindow({ startTime: '2026-11-11T16:00' }).start).toEqual(local('2026-11-11T16:00'));
    const last = slotPolicy(NOW).resolveWindow({ startTime: '2026-11-11T22:00' });
    expect(last.end).toEqual(local('2026-11-12T00:00'));
  });

  test.each([
    ['2026-11-11T19:15', 'NOT_ON_SLOT_BOUNDARY'],
    ['2026-11-11T19:00:30', 'NOT_ON_SLOT_BOUNDARY'],
    ['2026-11-11T15:30', 'OUTSIDE_BOOKING_HOURS'],
    ['2026-11-11T22:30', 'OUTSIDE_BOOKING_HOURS'],
    ['2026-11-11T23:00', 'OUTSIDE_BOOKING_HOURS'],
    ['2026-11-11T00:00', 'OUTSIDE_BOOKING_HOURS'],
    ['2026-11-10T16:30', 'START_IN_PAST'],
    ['2026-11-09T19:00', 'START_IN_PAST'],
    ['not a date', 'INVALID_START_TIME'],
  ])('%s is rejected with %s', (startTime, code) => {
    expect(codeOf(() => slotPolicy(NOW).resolveWindow({ startTime }))).toBe(code);
  });

  test('the booking horizon is 30 days: exactly 30 days ahead is fine, one slot later is not', () => {
    expect(codeOf(() => slotPolicy(NOW).resolveWindow({ startTime: '2026-12-10T17:00' }))).toBeNull();
    expect(codeOf(() => slotPolicy(NOW).resolveWindow({ startTime: '2026-12-10T17:30' }))).toBe('BEYOND_BOOKING_HORIZON');
  });

  test('a slot starting right now is not "in the past"', () => {
    expect(codeOf(() => slotPolicy(NOW).resolveWindow({ startTime: '2026-11-10T17:00' }))).toBeNull();
  });
});

describe('reservation policy: walk-ins (scope 2.3)', () => {
  test('starts now, not on a slot boundary, and lasts two hours', () => {
    const { start, end } = walkInPolicy('2026-11-10T18:07').resolveWindow();
    expect(start).toEqual(local('2026-11-10T18:07'));
    expect(end).toEqual(local('2026-11-10T20:07'));
  });

  test('the start is floored to the minute (seconds are dropped)', () => {
    const policy = new ReservationPolicyFactory({ clock: new FixedClock(local('2026-11-10T18:07:42')), business }).forSource('walk_in');
    expect(policy.resolveWindow().start).toEqual(local('2026-11-10T18:07'));
  });

  test('a 9:00 PM walk-in ends at 11:00 PM; a 10:00 PM walk-in ends exactly at midnight', () => {
    expect(walkInPolicy('2026-11-10T21:00').resolveWindow().end).toEqual(local('2026-11-10T23:00'));
    expect(walkInPolicy('2026-11-10T22:00').resolveWindow().end).toEqual(local('2026-11-11T00:00'));
  });

  test('no new seatings after 10:00 PM, even one second after', () => {
    const late = new ReservationPolicyFactory({ clock: new FixedClock(local('2026-11-10T22:00:01')), business }).forSource('walk_in');
    expect(codeOf(() => late.resolveWindow())).toBe('NO_NEW_SEATINGS');
    expect(codeOf(() => walkInPolicy('2026-11-10T23:30').resolveWindow())).toBe('NO_NEW_SEATINGS');
    expect(codeOf(() => walkInPolicy('2026-11-11T00:30').resolveWindow())).toBe('RESTAURANT_CLOSED');
  });

  test('nobody can be seated before opening time', () => {
    expect(codeOf(() => walkInPolicy('2026-11-10T15:59').resolveWindow())).toBe('RESTAURANT_CLOSED');
    expect(codeOf(() => walkInPolicy('2026-11-10T16:00').resolveWindow())).toBeNull();
  });

  test('the strategy is chosen by booking source; phone bookings use the slot rules', () => {
    const factory = new ReservationPolicyFactory({ clock: clockAt('2026-11-10T17:00'), business });
    expect(factory.forSource('phone')).toBe(factory.forSource('online'));
    expect(factory.forSource('walk_in')).not.toBe(factory.forSource('online'));
  });
});

describe('takeaway order policy (scope 2.4)', () => {
  const NOW = '2026-11-10T17:00';

  test('ASAP: estimated pickup is "now + preparation time" and the order is for now', async () => {
    const result = await takeaway(NOW).prepare({ input: { pickupType: 'asap' } });
    expect(result.pickupType).toBe('asap');
    expect(result.pickupTime).toEqual(local('2026-11-10T17:20'));
    expect(result.scheduledFor).toEqual(local(NOW));
  });

  test('ASAP is accepted from opening until 11:30 PM sharp', async () => {
    expect(await asyncCodeOf(takeaway('2026-11-10T16:00').prepare({ input: { pickupType: 'asap' } }))).toBeNull();
    expect(await asyncCodeOf(takeaway('2026-11-10T23:30').prepare({ input: { pickupType: 'asap' } }))).toBeNull();
    const late = new TakeawayOrderPolicy({ clock: new FixedClock(local('2026-11-10T23:30:01')), business });
    expect(await asyncCodeOf(late.prepare({ input: { pickupType: 'asap' } }))).toBe('OUTSIDE_ORDERING_HOURS');
    expect(await asyncCodeOf(takeaway('2026-11-10T15:59').prepare({ input: { pickupType: 'asap' } }))).toBe('OUTSIDE_ORDERING_HOURS');
  });

  test('ASAP orders cannot also carry a pickup time', async () => {
    expect(await asyncCodeOf(takeaway(NOW).prepare({ input: { pickupType: 'asap', pickupTime: '2026-11-10T19:00' } }))).toBe('PICKUP_TIME_NOT_ALLOWED');
  });

  test('scheduled: needs 30 minutes of lead time (exactly 30 is fine)', async () => {
    expect(await asyncCodeOf(takeaway(NOW).prepare({ input: { pickupType: 'scheduled', pickupTime: '2026-11-10T17:30' } }))).toBeNull();
    expect(await asyncCodeOf(takeaway(NOW).prepare({ input: { pickupType: 'scheduled', pickupTime: '2026-11-10T17:00' } }))).toBe('PICKUP_TOO_SOON');
  });

  test.each([
    ['2026-11-11T18:15', 'NOT_ON_SLOT_BOUNDARY'],
    ['2026-11-11T15:30', 'OUTSIDE_PICKUP_HOURS'],
    ['2026-11-11T00:00', 'OUTSIDE_PICKUP_HOURS'],
    ['2026-11-11T23:45', 'NOT_ON_SLOT_BOUNDARY'],
    ['garbage', 'INVALID_PICKUP_TIME'],
  ])('scheduled pickup %s is rejected with %s', async (pickupTime, code) => {
    expect(await asyncCodeOf(takeaway(NOW).prepare({ input: { pickupType: 'scheduled', pickupTime } }))).toBe(code);
  });

  test('the last pickup is 11:30 PM, 16:00 is the first', async () => {
    expect(await asyncCodeOf(takeaway(NOW).prepare({ input: { pickupType: 'scheduled', pickupTime: '2026-11-11T23:30' } }))).toBeNull();
    expect(await asyncCodeOf(takeaway(NOW).prepare({ input: { pickupType: 'scheduled', pickupTime: '2026-11-11T16:00' } }))).toBeNull();
  });

  test('the scheduling horizon is 7 days', async () => {
    expect(await asyncCodeOf(takeaway(NOW).prepare({ input: { pickupType: 'scheduled', pickupTime: '2026-11-17T17:00' } }))).toBeNull();
    expect(await asyncCodeOf(takeaway(NOW).prepare({ input: { pickupType: 'scheduled', pickupTime: '2026-11-17T17:30' } }))).toBe('BEYOND_PICKUP_HORIZON');
  });

  test('missing pickup information is reported', async () => {
    expect(await asyncCodeOf(takeaway(NOW).prepare({ input: {} }))).toBe('PICKUP_TYPE_REQUIRED');
    expect(await asyncCodeOf(takeaway(NOW).prepare({ input: { pickupType: 'scheduled' } }))).toBe('PICKUP_TIME_REQUIRED');
  });

  test('a scheduled order is "for" its pickup time', async () => {
    const result = await takeaway(NOW).prepare({ input: { pickupType: 'scheduled', pickupTime: '2026-11-11T19:00' } });
    expect(result.scheduledFor).toEqual(local('2026-11-11T19:00'));
    expect(result.pickupTime).toEqual(local('2026-11-11T19:00'));
  });
});
