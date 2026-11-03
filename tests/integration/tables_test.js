const db = require('../helpers/db');
const { createContext } = require('../helpers/context');

beforeAll(db.connect);
afterAll(db.disconnect);

let ctx;
let admin;
beforeEach(async () => {
  await db.clear();
  ctx = createContext();
  admin = await ctx.createUser({ role: 'admin' });
});

describe('access', () => {
  test('staff and admins can list, only admins can change; customers and anonymous are refused', async () => {
    const staff = await ctx.createUser({ role: 'staff' });
    const customer = await ctx.createUser();
    expect((await ctx.api.get('/api/tables', staff.token)).status).toBe(200);
    expect((await ctx.api.get('/api/tables', customer.token)).status).toBe(403);
    expect((await ctx.api.get('/api/tables')).status).toBe(401);
    expect((await ctx.api.post('/api/tables', staff.token).send({ number: 1, capacity: 2 })).status).toBe(403);
  });
});

describe('CRUD', () => {
  test('create with defaults, list sorted by number, and filter by zone and activity', async () => {
    await ctx.api.post('/api/tables', admin.token).send({ number: 2, capacity: 4, zone: 'vip' });
    const created = await ctx.api.post('/api/tables', admin.token).send({ number: 1, capacity: 2 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ number: 1, capacity: 2, zone: 'normal', isActive: true });

    const all = await ctx.api.get('/api/tables', admin.token);
    expect(all.body.items.map((t) => t.number)).toEqual([1, 2]);
    expect((await ctx.api.get('/api/tables?zone=vip', admin.token)).body.items).toHaveLength(1);

    await ctx.api.put(`/api/tables/${created.body._id}`, admin.token).send({ isActive: false });
    expect((await ctx.api.get('/api/tables?isActive=false', admin.token)).body.items.map((t) => t.number)).toEqual([1]);
    expect((await ctx.api.get('/api/tables?isActive=true', admin.token)).body.items.map((t) => t.number)).toEqual([2]);
  });

  test.each([
    ['capacity 0', { number: 1, capacity: 0 }],
    ['a fractional capacity', { number: 1, capacity: 2.5 }],
    ['number 0', { number: 0, capacity: 2 }],
    ['an unknown zone', { number: 1, capacity: 2, zone: 'roof' }],
    ['a missing number', { capacity: 2 }],
  ])('rejects %s with 400', async (_label, body) => {
    expect((await ctx.api.post('/api/tables', admin.token).send(body)).status).toBe(400);
  });

  test('a duplicate table number is a 409', async () => {
    await ctx.api.post('/api/tables', admin.token).send({ number: 1, capacity: 2 });
    const res = await ctx.api.post('/api/tables', admin.token).send({ number: 1, capacity: 6 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TABLE_NUMBER_TAKEN');
  });

  test('updating one field never resets the others (regression: zone used to fall back to its default)', async () => {
    const vip = (await ctx.api.post('/api/tables', admin.token).send({ number: 9, capacity: 8, zone: 'vip' })).body;
    const res = await ctx.api.put(`/api/tables/${vip._id}`, admin.token).send({ capacity: 10 });
    expect(res.body).toMatchObject({ number: 9, capacity: 10, zone: 'vip', isActive: true });
    const off = await ctx.api.put(`/api/tables/${vip._id}`, admin.token).send({ isActive: false });
    expect(off.body).toMatchObject({ capacity: 10, zone: 'vip', isActive: false });
  });

  test('update changes only the given fields; empty body is 400; unknown id is 404; number clash is 409', async () => {
    const a = (await ctx.api.post('/api/tables', admin.token).send({ number: 1, capacity: 2 })).body;
    const b = (await ctx.api.post('/api/tables', admin.token).send({ number: 2, capacity: 4 })).body;
    const res = await ctx.api.put(`/api/tables/${a._id}`, admin.token).send({ capacity: 3 });
    expect(res.body).toMatchObject({ number: 1, capacity: 3, zone: 'normal' });
    expect((await ctx.api.put(`/api/tables/${a._id}`, admin.token).send({})).status).toBe(400);
    expect((await ctx.api.put('/api/tables/507f1f77bcf86cd799439011', admin.token).send({ capacity: 3 })).status).toBe(404);
    expect((await ctx.api.put(`/api/tables/${b._id}`, admin.token).send({ number: 1 })).status).toBe(409);
  });
});

describe('protecting guests who are coming', () => {
  async function bookedTable() {
    const table = await ctx.createTable({ number: 1, capacity: 4 });
    const customer = await ctx.createUser();
    const res = await ctx.api.post('/api/reservations', customer.token).send({ startTime: '2026-11-10T19:00', partySize: 4, tableId: String(table._id) });
    expect(res.status).toBe(201);
    return { table, customer, reservation: res.body.reservation };
  }

  test('a table with an upcoming reservation cannot be deactivated', async () => {
    const { table } = await bookedTable();
    const res = await ctx.api.put(`/api/tables/${table._id}`, admin.token).send({ isActive: false });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TABLE_HAS_RESERVATIONS');
  });

  test('once the reservation is cancelled it can be deactivated', async () => {
    const { table, customer, reservation } = await bookedTable();
    await ctx.api.patch(`/api/reservations/${reservation._id}/cancel`, customer.token);
    expect((await ctx.api.put(`/api/tables/${table._id}`, admin.token).send({ isActive: false })).status).toBe(200);
  });

  test('capacity cannot drop below an upcoming party, but can drop if everyone still fits', async () => {
    const { table } = await bookedTable(); // party of 4
    expect((await ctx.api.put(`/api/tables/${table._id}`, admin.token).send({ capacity: 3 })).status).toBe(409);
    expect((await ctx.api.put(`/api/tables/${table._id}`, admin.token).send({ capacity: 6 })).status).toBe(200);
  });

  test('a table that was booked once is never deleted, only a never-booked one is', async () => {
    const { table, customer, reservation } = await bookedTable();
    await ctx.api.patch(`/api/reservations/${reservation._id}/cancel`, customer.token);
    const refused = await ctx.api.delete(`/api/tables/${table._id}`, admin.token);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('TABLE_IN_USE');

    const fresh = await ctx.createTable({ number: 2 });
    expect((await ctx.api.delete(`/api/tables/${fresh._id}`, admin.token)).status).toBe(204);
    expect((await ctx.api.delete(`/api/tables/${fresh._id}`, admin.token)).status).toBe(404);
  });
});
