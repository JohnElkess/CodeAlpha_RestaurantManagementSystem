const db = require('../helpers/db');
const { createContext } = require('../helpers/context');
const Reservation = require('../../src/models/Reservation');

beforeAll(db.connect);
afterAll(db.disconnect);

let ctx;
let staff;
let customer;
beforeEach(async () => {
  await db.clear();
  ctx = createContext(); // Tuesday 2026-11-10, 17:00 Cairo
  staff = await ctx.createUser({ role: 'staff' });
  customer = await ctx.createUser();
});

const book = (token, o = {}) => ctx.api.post('/api/reservations', token).send({ startTime: '2026-11-10T19:00', partySize: 2, ...o });
const walkIn = (o = {}) => ctx.api.post('/api/reservations/walk-in', staff.token).send(o);
const reservationOf = (res) => res.body.reservation;

describe('discovering slots and availability', () => {
  test('GET /slots lists the 13 bookable starts of a day', async () => {
    const res = await ctx.api.get('/api/reservations/slots?date=2026-11-10', customer.token);
    expect(res.status).toBe(200);
    expect(res.body.slots).toHaveLength(13);
    expect(res.body.slots[0]).toBe(ctx.local('2026-11-10T16:00').toISOString());
    expect(res.body.slots[12]).toBe(ctx.local('2026-11-10T22:00').toISOString());
    expect((await ctx.api.get('/api/reservations/slots?date=2026-02-30', customer.token)).status).toBe(400);
    expect((await ctx.api.get('/api/reservations/slots', customer.token)).status).toBe(400);
  });

  test('availability returns tables that fit, smallest first, and suggests the first', async () => {
    await ctx.createTable({ number: 1, capacity: 6, zone: 'vip' });
    await ctx.createTable({ number: 2, capacity: 2 });
    await ctx.createTable({ number: 3, capacity: 4 });
    const res = await ctx.api.get('/api/reservations/availability?start=2026-11-10T19:00&partySize=3', customer.token);
    expect(res.status).toBe(200);
    expect(res.body.tables.map((t) => t.number)).toEqual([3, 1]); // capacity 4 before 6; the 2-seater cannot fit 3
    expect(res.body.suggestedTable.number).toBe(3);
    expect(res.body.end).toBe(ctx.local('2026-11-10T21:00').toISOString());
  });

  test('availability can be limited to a zone', async () => {
    await ctx.createTable({ number: 1, capacity: 4, zone: 'window' });
    await ctx.createTable({ number: 2, capacity: 4, zone: 'vip' });
    const res = await ctx.api.get('/api/reservations/availability?start=2026-11-10T19:00&partySize=2&zone=vip', customer.token);
    expect(res.body.tables.map((t) => t.number)).toEqual([2]);
  });

  test('availability uses the booking rules: bad slots and too-large parties are 400, a full house is an empty list', async () => {
    await ctx.createTable({ number: 1, capacity: 4 });
    const check = (q) => ctx.api.get(`/api/reservations/availability?${q}`, customer.token);
    expect((await check('start=2026-11-10T19:15&partySize=2')).body.error.code).toBe('NOT_ON_SLOT_BOUNDARY');
    expect((await check('start=2026-11-10T19:00&partySize=9')).body.error.code).toBe('PARTY_TOO_LARGE');
    expect((await check('start=2026-11-10T19:00')).status).toBe(400);
    await book(customer.token, { partySize: 4 });
    const full = await check('start=2026-11-10T19:00&partySize=2');
    expect(full.status).toBe(200);
    expect(full.body.tables).toEqual([]);
    expect(full.body.suggestedTable).toBeNull();
  });
});

describe('booking a table', () => {
  test('auto-assigns the smallest table that fits and sets a two-hour stay', async () => {
    await ctx.createTable({ number: 1, capacity: 6 });
    await ctx.createTable({ number: 2, capacity: 2 });
    await ctx.createTable({ number: 3, capacity: 4 });
    const one = reservationOf(await book(customer.token, { partySize: 2 }));
    const three = reservationOf(await book(customer.token, { partySize: 3 }));
    const five = reservationOf(await book(customer.token, { partySize: 5 }));
    expect([one, three, five].map((r) => r.table.number)).toEqual([2, 3, 1]);
    expect(one).toMatchObject({ status: 'confirmed', source: 'online', partySize: 2 });
    expect(one.startTime).toBe(ctx.local('2026-11-10T19:00').toISOString());
    expect(one.endTime).toBe(ctx.local('2026-11-10T21:00').toISOString());
    expect(one.customer).toMatchObject({ _id: customer.id, name: customer.name });
  });

  test('the response never leaks the internal guard fields', async () => {
    await ctx.createTable({ number: 1 });
    const res = await book(customer.token);
    expect(JSON.stringify(res.body)).not.toMatch(/occupancy|holdsTable/);
    expect(res.body.preOrder).toBeNull();
  });

  test('inactive tables are never assigned', async () => {
    await ctx.createTable({ number: 1, capacity: 2, isActive: false });
    const res = await book(customer.token);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_TABLE_AVAILABLE');
  });

  test('zone preference is honoured, and a missing zone is a 409', async () => {
    await ctx.createTable({ number: 1, capacity: 2, zone: 'normal' });
    expect((await book(customer.token, { zone: 'vip' })).status).toBe(409);
    await ctx.createTable({ number: 2, capacity: 4, zone: 'vip' });
    expect(reservationOf(await book(customer.token, { zone: 'vip' })).table.number).toBe(2);
  });

  test.each([
    ['2026-11-10T19:15', 'NOT_ON_SLOT_BOUNDARY'],
    ['2026-11-10T15:30', 'OUTSIDE_BOOKING_HOURS'],
    ['2026-11-10T22:30', 'OUTSIDE_BOOKING_HOURS'],
    ['2026-11-10T16:30', 'START_IN_PAST'],
    ['2026-12-10T17:30', 'BEYOND_BOOKING_HORIZON'],
  ])('start %s is rejected with %s and nothing is booked', async (startTime, code) => {
    await ctx.createTable({ number: 1 });
    const res = await book(customer.token, { startTime });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect(await Reservation.countDocuments()).toBe(0);
  });

  test('malformed input is a field-level 400', async () => {
    await ctx.createTable({ number: 1 });
    for (const bad of [{ partySize: 0 }, { partySize: 'two' }, { startTime: 'soon' }, { tableId: 'abc' }, { zone: 'roof' }]) {
      const res = await book(customer.token, bad);
      expect([bad, res.status, res.body.error.code]).toEqual([bad, 400, 'VALIDATION_ERROR']);
    }
  });

  test('a party larger than every table is a clear 400, not a vague "no table"', async () => {
    await ctx.createTable({ number: 1, capacity: 4 });
    const res = await book(customer.token, { partySize: 12 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PARTY_TOO_LARGE');
  });

  test('a specific table can be requested if it fits and is free', async () => {
    const small = await ctx.createTable({ number: 1, capacity: 2 });
    const big = await ctx.createTable({ number: 2, capacity: 6 });
    expect(reservationOf(await book(customer.token, { partySize: 2, tableId: String(big._id) })).table.number).toBe(2);
    const tooSmall = await book(customer.token, { partySize: 4, tableId: String(small._id) });
    expect(tooSmall.body.error.code).toBe('PARTY_EXCEEDS_CAPACITY');
    const taken = await book(customer.token, { partySize: 2, tableId: String(big._id) });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('TABLE_NOT_AVAILABLE');
    await ctx.createTable({ number: 3, isActive: false }).then(async (off) => {
      expect((await book(customer.token, { tableId: String(off._id) })).body.error.code).toBe('TABLE_INACTIVE');
    });
    expect((await book(customer.token, { tableId: '507f1f77bcf86cd799439011' })).body.error.code).toBe('TABLE_NOT_FOUND');
  });

  test('works across a DST change: local 19:00 stays 19:00 and the stay is exactly two real hours', async () => {
    ctx.setNow('2026-04-20T12:00');
    await ctx.createTable({ number: 1 });
    const res = await book(customer.token, { startTime: '2026-04-24T19:00' }); // Egypt moved to summer time at midnight
    expect(res.status).toBe(201);
    const r = reservationOf(res);
    expect(r.startTime).toBe('2026-04-24T16:00:00.000Z'); // UTC+3
    expect(new Date(r.endTime) - new Date(r.startTime)).toBe(2 * 3600 * 1000);
  });
});

describe('the overlap rule (scope 2.2)', () => {
  // One table, one booking 19:00-21:00. Which other starts can still be booked?
  beforeEach(async () => {
    await ctx.createTable({ number: 1, capacity: 4 });
    expect((await book(customer.token, { startTime: '2026-11-10T19:00' })).status).toBe(201);
  });

  test.each([
    ['18:00', 409], // 18:00-20:00 overlaps
    ['18:30', 409],
    ['19:00', 409], // same slot
    ['19:30', 409],
    ['20:30', 409], // 20:30-22:30 overlaps the last half hour
    ['17:00', 201], // 17:00-19:00 ends exactly when the other starts: allowed
    ['21:00', 201], // starts exactly when the other ends: allowed
  ])('a booking at %s gives %i', async (time, expected) => {
    const res = await book(customer.token, { startTime: `2026-11-10T${time}` });
    expect(res.status).toBe(expected);
    if (expected === 409) expect(res.body.error.code).toBe('NO_TABLE_AVAILABLE');
  });

  test('a seated reservation blocks the table too', async () => {
    const seated = await walkIn({ customerId: customer.id, partySize: 2 }); // 17:00-19:00 touches 19:00: fits
    expect(seated.status).toBe(201);
    expect((await book(customer.token, { startTime: '2026-11-10T17:30' })).status).toBe(409);
  });
});

describe('what frees a table', () => {
  async function oneTableBooked() {
    const table = await ctx.createTable({ number: 1, capacity: 4 });
    const res = await book(customer.token);
    return { table, reservation: reservationOf(res) };
  }
  const stillFull = async () => (await book(customer.token)).status === 409;

  test('cancelling frees it at once', async () => {
    const { reservation } = await oneTableBooked();
    expect(await stillFull()).toBe(true);
    await ctx.api.patch(`/api/reservations/${reservation._id}/cancel`, customer.token);
    expect(await stillFull()).toBe(false);
  });

  test('completing early frees the rest of the two hours', async () => {
    const { reservation } = await oneTableBooked();
    await ctx.api.patch(`/api/reservations/${reservation._id}/seat`, staff.token);
    expect(await stillFull()).toBe(true); // seated still blocks
    await ctx.api.patch(`/api/reservations/${reservation._id}/complete`, staff.token);
    expect(await stillFull()).toBe(false);
  });

  test('a no-show frees the table (and a walk-in then only has to fit before the next booking)', async () => {
    const table = await ctx.createTable({ number: 1, capacity: 4 });
    await book(customer.token, { startTime: '2026-11-10T17:30' }); // confirmed 17:30-19:30
    await book(customer.token, { startTime: '2026-11-10T20:00' }); // confirmed 20:00-22:00 on the same table? only if free
    expect(table).toBeDefined();
    ctx.setNow('2026-11-10T17:51'); // 21 minutes after the first start
    expect(await ctx.jobs.noShow.run()).toBe(1);
    // free from 17:51; the next booking starts at 20:00, so a 17:51-19:51 walk-in fits just before it
    expect((await walkIn({ customerId: customer.id, partySize: 2 })).status).toBe(201);
  });
});

describe('staff booking for a customer', () => {
  beforeEach(() => ctx.createTable({ number: 1, capacity: 4 }));

  test('staff must name the customer; the booking is recorded as a phone booking made by staff', async () => {
    expect((await book(staff.token)).body.error.code).toBe('CUSTOMER_REQUIRED');
    const res = await book(staff.token, { customerId: customer.id });
    expect(res.status).toBe(201);
    expect(reservationOf(res)).toMatchObject({ source: 'phone', customer: { _id: customer.id } });
    expect((await Reservation.findOne()).createdBy.toString()).toBe(staff.id);
  });

  test('the target must be a real customer account', async () => {
    const other = await ctx.createUser({ role: 'staff' });
    expect((await book(staff.token, { customerId: other.id })).body.error.code).toBe('CUSTOMER_NOT_FOUND');
    expect((await book(staff.token, { customerId: '507f1f77bcf86cd799439011' })).body.error.code).toBe('CUSTOMER_NOT_FOUND');
  });

  test('a customer cannot book on behalf of someone else', async () => {
    const other = await ctx.createUser();
    expect((await book(customer.token, { customerId: other.id })).status).toBe(403);
    expect((await book(customer.token, { customerId: customer.id })).status).toBe(201); // naming yourself is fine
  });
});

describe('viewing reservations', () => {
  let other;
  let mine;
  let theirs;
  beforeEach(async () => {
    other = await ctx.createUser();
    await ctx.createTable({ number: 1, capacity: 4 });
    await ctx.createTable({ number: 2, capacity: 4 });
    mine = reservationOf(await book(customer.token));
    theirs = reservationOf(await book(other.token, { startTime: '2026-11-11T19:00' }));
  });

  test('customers see only their own reservations; staff see everything', async () => {
    const asCustomer = await ctx.api.get('/api/reservations', customer.token);
    expect(asCustomer.body.items.map((r) => r._id)).toEqual([mine._id]);
    expect((await ctx.api.get('/api/reservations', staff.token)).body.total).toBe(2);
  });

  test("a customer cannot read someone else's reservation, and cannot widen the list with customerId", async () => {
    expect((await ctx.api.get(`/api/reservations/${theirs._id}`, customer.token)).status).toBe(404);
    expect((await ctx.api.get(`/api/reservations/${mine._id}`, customer.token)).status).toBe(200);
    expect((await ctx.api.get(`/api/reservations/${theirs._id}`, staff.token)).status).toBe(200);
    const widened = await ctx.api.get(`/api/reservations?customerId=${other.id}`, customer.token);
    expect(widened.body.items.map((r) => r._id)).toEqual([mine._id]);
  });

  test('staff can filter by day, status, customer and table, with pagination', async () => {
    const byDay = await ctx.api.get('/api/reservations?date=2026-11-11', staff.token);
    expect(byDay.body.items.map((r) => r._id)).toEqual([theirs._id]);
    expect((await ctx.api.get(`/api/reservations?customerId=${customer.id}`, staff.token)).body.total).toBe(1);
    expect((await ctx.api.get('/api/reservations?status=cancelled', staff.token)).body.total).toBe(0);
    const page = await ctx.api.get('/api/reservations?limit=1&page=2', staff.token);
    expect(page.body).toMatchObject({ page: 2, limit: 1, total: 2, pages: 2 });
    expect(page.body.items).toHaveLength(1);
  });

  test('bad filters are 400, unknown ids 404, malformed ids 400', async () => {
    expect((await ctx.api.get('/api/reservations?status=lost', staff.token)).status).toBe(400);
    expect((await ctx.api.get('/api/reservations?date=yesterday', staff.token)).status).toBe(400);
    expect((await ctx.api.get('/api/reservations/507f1f77bcf86cd799439011', staff.token)).status).toBe(404);
    expect((await ctx.api.get('/api/reservations/xyz', staff.token)).status).toBe(400);
  });
});

describe('cancel, seat and complete', () => {
  let reservation;
  beforeEach(async () => {
    await ctx.createTable({ number: 1, capacity: 4 });
    reservation = reservationOf(await book(customer.token));
  });
  const patch = (action, token) => ctx.api.patch(`/api/reservations/${reservation._id}/${action}`, token);

  test('the owner cancels; a second cancel is a 409 that lists what is still possible', async () => {
    const res = await patch('cancel', customer.token);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.cancelledAt).toBeDefined();
    const again = await patch('cancel', customer.token);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'INVALID_STATUS_TRANSITION', details: { from: 'cancelled', allowedNext: [] } });
  });

  test("another customer cannot cancel it (404), staff can", async () => {
    const other = await ctx.createUser();
    expect((await patch('cancel', other.token)).status).toBe(404);
    expect((await patch('cancel', staff.token)).status).toBe(200);
  });

  test('staff seat and complete in order; skipping or repeating steps is a 409', async () => {
    expect((await patch('complete', staff.token)).status).toBe(409); // not seated yet
    const seated = await patch('seat', staff.token);
    expect(seated.body.status).toBe('seated');
    expect(seated.body.seatedAt).toBeDefined();
    expect((await patch('seat', staff.token)).status).toBe(409);
    expect((await patch('cancel', staff.token)).status).toBe(409); // a seated party is completed, not cancelled
    const done = await patch('complete', staff.token);
    expect(done.body.status).toBe('completed');
    expect(done.body.completedAt).toBeDefined();
    expect((await patch('seat', staff.token)).status).toBe(409);
  });

  test('a no-show cannot be seated afterwards (the guest becomes a walk-in)', async () => {
    ctx.setNow('2026-11-10T19:20');
    await ctx.jobs.noShow.run();
    const res = await patch('seat', staff.token);
    expect(res.status).toBe(409);
    expect(res.body.error.details.from).toBe('no_show');
  });

  test('unknown reservation: 404', async () => {
    expect((await ctx.api.patch('/api/reservations/507f1f77bcf86cd799439011/seat', staff.token)).status).toBe(404);
  });
});

describe('walk-ins (scope 2.3 and 7.2)', () => {
  beforeEach(() => ctx.createTable({ number: 1, capacity: 4 }));

  test('starts now (not on a slot boundary), lasts two hours and is seated immediately', async () => {
    ctx.setNow('2026-11-10T18:07');
    const res = await walkIn({ customerId: customer.id, partySize: 2 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'seated', source: 'walk_in' });
    expect(res.body.startTime).toBe(ctx.local('2026-11-10T18:07').toISOString());
    expect(res.body.endTime).toBe(ctx.local('2026-11-10T20:07').toISOString());
    expect(res.body.seatedAt).toBeDefined();
  });

  test('a walk-in at 18:00 cannot take the table that is reserved at 19:00', async () => {
    await book(customer.token, { startTime: '2026-11-10T19:00' });
    ctx.setNow('2026-11-10T18:00');
    const res = await walkIn({ customerId: customer.id, partySize: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_TABLE_AVAILABLE');
  });

  test('a walk-in at 17:00 fits before a 19:00 booking (the two hours end exactly at 19:00)', async () => {
    await book(customer.token, { startTime: '2026-11-10T19:00' });
    expect((await walkIn({ customerId: customer.id, partySize: 2 })).status).toBe(201);
  });

  test('a 9 PM walk-in ends at 11 PM and a 10 PM walk-in ends at midnight', async () => {
    ctx.setNow('2026-11-10T21:00');
    expect((await walkIn({ customerId: customer.id, partySize: 2 })).body.endTime).toBe(ctx.local('2026-11-10T23:00').toISOString());
    await ctx.api.patch(`/api/reservations/${(await Reservation.findOne())._id}/complete`, staff.token);
    ctx.setNow('2026-11-10T22:00');
    expect((await walkIn({ customerId: customer.id, partySize: 2 })).body.endTime).toBe(ctx.local('2026-11-11T00:00').toISOString());
  });

  test('no new seatings after 10 PM and none before opening', async () => {
    ctx.setNow('2026-11-10T22:01');
    expect((await walkIn({ customerId: customer.id, partySize: 2 })).body.error.code).toBe('NO_NEW_SEATINGS');
    ctx.setNow('2026-11-10T15:59');
    expect((await walkIn({ customerId: customer.id, partySize: 2 })).body.error.code).toBe('RESTAURANT_CLOSED');
  });

  test('staff must name the guest, and the party must fit a table', async () => {
    expect((await walkIn({ partySize: 2 })).body.error.code).toBe('CUSTOMER_REQUIRED');
    expect((await walkIn({ customerId: customer.id, partySize: 9 })).body.error.code).toBe('PARTY_TOO_LARGE');
    expect((await walkIn({ customerId: customer.id, partySize: 0 })).status).toBe(400);
  });
});

describe('two guests racing for the same table (the database enforces it)', () => {
  const distinctCustomers = (n) => Promise.all(Array.from({ length: n }, () => ctx.createUser()));
  const codes = (results) => results.map((r) => r.status).sort();

  test('six simultaneous requests for one table: exactly one wins', async () => {
    await ctx.createTable({ number: 1, capacity: 4 });
    const people = await distinctCustomers(6);
    const results = await Promise.all(people.map((p) => book(p.token)));
    expect(codes(results)).toEqual([201, 409, 409, 409, 409, 409]);
    expect(await Reservation.countDocuments({ status: 'confirmed' })).toBe(1);
  });

  test('six requests for two tables: exactly two win', async () => {
    await ctx.createTable({ number: 1, capacity: 4 });
    await ctx.createTable({ number: 2, capacity: 4 });
    const people = await distinctCustomers(6);
    const results = await Promise.all(people.map((p) => book(p.token)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    const tables = (await Reservation.find()).map((r) => String(r.table));
    expect(new Set(tables).size).toBe(2); // never the same table twice
  });

  test('overlapping but not identical windows race too: 19:00 and 20:00 cannot both get the table', async () => {
    await ctx.createTable({ number: 1, capacity: 4 });
    const [a, b] = await distinctCustomers(2);
    const results = await Promise.all([book(a.token, { startTime: '2026-11-10T19:00' }), book(b.token, { startTime: '2026-11-10T20:00' })]);
    expect(codes(results)).toEqual([201, 409]);
  });

  test('back-to-back bookings (19:00 and 21:00) both succeed even when sent together', async () => {
    await ctx.createTable({ number: 1, capacity: 4 });
    const [a, b] = await distinctCustomers(2);
    const results = await Promise.all([book(a.token, { startTime: '2026-11-10T19:00' }), book(b.token, { startTime: '2026-11-10T21:00' })]);
    expect(codes(results)).toEqual([201, 201]);
  });

  test('a walk-in and an online booking racing for the last table cannot both get it', async () => {
    await ctx.createTable({ number: 1, capacity: 4 });
    const [a] = await distinctCustomers(1);
    const results = await Promise.all([book(a.token, { startTime: '2026-11-10T17:00' }), walkIn({ customerId: customer.id, partySize: 2 })]);
    expect(codes(results)).toEqual([201, 409]);
  });

  test('the database itself refuses an overlapping hold even if the application check is bypassed', async () => {
    const table = await ctx.createTable({ number: 1, capacity: 4 });
    const repo = ctx.container.repos.reservationRepo;
    const base = { customer: customer.id, table: table._id, partySize: 2, source: 'phone' };
    const first = await repo.insertHolding({ ...base, startTime: ctx.local('2026-11-10T19:00'), endTime: ctx.local('2026-11-10T21:00') });
    const overlap = await repo.insertHolding({ ...base, startTime: ctx.local('2026-11-10T20:00'), endTime: ctx.local('2026-11-10T22:00') });
    const adjacent = await repo.insertHolding({ ...base, startTime: ctx.local('2026-11-10T21:00'), endTime: ctx.local('2026-11-10T23:00') });
    expect([first.ok, overlap.ok, adjacent.ok]).toEqual([true, false, true]);
  });

  test('after a table is released, the same minutes can be booked again', async () => {
    await ctx.createTable({ number: 1, capacity: 4 });
    const first = reservationOf(await book(customer.token));
    await ctx.api.patch(`/api/reservations/${first._id}/cancel`, customer.token);
    expect((await book(customer.token)).status).toBe(201);
  });
});
