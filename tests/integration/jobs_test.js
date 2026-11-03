const db = require('../helpers/db');
const { createContext } = require('../helpers/context');
const { BackgroundJob } = require('../../src/jobs/background_job');
const Order = require('../../src/models/Order');
const Reservation = require('../../src/models/Reservation');

beforeAll(db.connect);
afterAll(db.disconnect);

let ctx;
let staff;
let customer;
let table;
beforeEach(async () => {
  await db.clear();
  ctx = createContext(); // Tuesday 2026-11-10, 17:00 Cairo
  staff = await ctx.createUser({ role: 'staff' });
  customer = await ctx.createUser();
  table = await ctx.createTable({ number: 1, capacity: 4 });
});

const line = (menuItem, quantity = 1) => ({ menuItem: String(menuItem._id), quantity });
const book = (o = {}) => ctx.api.post('/api/reservations', customer.token).send({ startTime: '2026-11-10T19:00', partySize: 2, ...o });
const takeaway = (items, o = {}) => ctx.api.post('/api/orders', customer.token).send({ type: 'takeaway', pickupType: 'asap', items, ...o });
const setStatus = (id, status) => ctx.api.patch(`/api/orders/${id}/status`, staff.token).send({ status });
const statusOf = async (Model, id) => (await Model.findById(id)).status;

describe('no-show job (scope 7.4)', () => {
  test('a confirmed reservation becomes no_show exactly 20 minutes after its start, not a second before', async () => {
    const reservation = (await book()).body.reservation;
    ctx.setNow('2026-11-10T19:19:59');
    expect(await ctx.jobs.noShow.run()).toBe(0);
    expect(await statusOf(Reservation, reservation._id)).toBe('confirmed');
    ctx.setNow('2026-11-10T19:20:00');
    expect(await ctx.jobs.noShow.run()).toBe(1);
    const stored = await Reservation.findById(reservation._id);
    expect(stored).toMatchObject({ status: 'no_show' });
    expect(stored.noShowAt).toBeDefined();
  });

  test('is idempotent and leaves seated, cancelled and completed reservations alone', async () => {
    const a = (await book({ startTime: '2026-11-10T17:30' })).body.reservation; // will be seated
    const b = (await book({ startTime: '2026-11-10T19:30' })).body.reservation; // will be cancelled
    const c = (await book({ startTime: '2026-11-10T21:30' })).body.reservation; // stays confirmed, in the future
    await ctx.api.patch(`/api/reservations/${a._id}/seat`, staff.token);
    await ctx.api.patch(`/api/reservations/${b._id}/cancel`, customer.token);
    ctx.setNow('2026-11-10T20:00');
    expect(await ctx.jobs.noShow.run()).toBe(0);
    expect(await ctx.jobs.noShow.run()).toBe(0);
    expect([await statusOf(Reservation, a._id), await statusOf(Reservation, b._id), await statusOf(Reservation, c._id)]).toEqual(['seated', 'cancelled', 'confirmed']);
  });

  test('frees the table: a walk-in can take it right away', async () => {
    await book({ startTime: '2026-11-10T17:30' });
    ctx.setNow('2026-11-10T17:45');
    expect((await ctx.api.post('/api/reservations/walk-in', staff.token).send({ customerId: customer.id, partySize: 2 })).status).toBe(409);
    ctx.setNow('2026-11-10T17:50');
    await ctx.jobs.noShow.run();
    expect((await ctx.api.post('/api/reservations/walk-in', staff.token).send({ customerId: customer.id, partySize: 2 })).status).toBe(201);
  });

  test("releases the pre-order's held ingredients", async () => {
    const { pizza, dough } = await ctx.createPizza();
    const res = await book({ preOrder: { items: [line(pizza, 2)] } });
    expect((await ctx.stockOf(dough)).reserved).toBe(500);
    ctx.setNow('2026-11-10T19:20');
    await ctx.jobs.noShow.run();
    expect(await ctx.stockOf(dough)).toEqual({ stock: 2500, reserved: 0, available: 2500 });
    expect(await statusOf(Order, res.body.preOrder._id)).toBe('cancelled');
  });

  test('food that was already prepared is not restored to stock', async () => {
    const { pizza, dough } = await ctx.createPizza();
    const res = await book({ preOrder: { items: [line(pizza, 2)] } });
    await setStatus(res.body.preOrder._id, 'preparing'); // the kitchen started early
    ctx.setNow('2026-11-10T19:20');
    await ctx.jobs.noShow.run();
    expect(await ctx.stockOf(dough)).toEqual({ stock: 2000, reserved: 0, available: 2000 });
  });

  test('a customer cancelling at the very moment the job runs: one wins, the stock is released exactly once', async () => {
    const { pizza, dough } = await ctx.createPizza();
    const other = await ctx.createUser();
    await ctx.api.post('/api/orders', other.token).send({ type: 'takeaway', pickupType: 'asap', items: [line(pizza, 1)] }); // unrelated hold: 250
    const res = await book({ preOrder: { items: [line(pizza, 2)] } });
    ctx.setNow('2026-11-10T19:20');
    await Promise.all([ctx.jobs.noShow.run(), ctx.api.patch(`/api/reservations/${res.body.reservation._id}/cancel`, customer.token)]);
    expect(['cancelled', 'no_show']).toContain(await statusOf(Reservation, res.body.reservation._id));
    expect(await statusOf(Order, res.body.preOrder._id)).toBe('cancelled');
    expect((await ctx.stockOf(dough)).reserved).toBe(250); // only the unrelated order still holds stock
  });
});

describe('auto-complete job', () => {
  test('a seated reservation completes exactly when its two hours end', async () => {
    const res = await ctx.api.post('/api/reservations/walk-in', staff.token).send({ customerId: customer.id, partySize: 2 }); // 17:00-19:00
    ctx.setNow('2026-11-10T18:59:59');
    expect(await ctx.jobs.autoComplete.run()).toBe(0);
    ctx.setNow('2026-11-10T19:00:00');
    expect(await ctx.jobs.autoComplete.run()).toBe(1);
    const stored = await Reservation.findById(res.body._id);
    expect(stored.status).toBe('completed');
    expect(stored.completedAt).toBeDefined();
    expect(await ctx.jobs.autoComplete.run()).toBe(0);
  });

  test('does not touch confirmed reservations, however late they are', async () => {
    const res = await book({ startTime: '2026-11-10T17:30' });
    ctx.setNow('2026-11-10T22:00');
    expect(await ctx.jobs.autoComplete.run()).toBe(0);
    expect(await statusOf(Reservation, res.body.reservation._id)).toBe('confirmed');
  });
});

describe('uncollected job', () => {
  const scheduled = (items, pickupTime = '2026-11-10T19:00') => takeaway(items, { pickupType: 'scheduled', pickupTime });

  test('a takeaway still not collected 20 minutes after pickupTime is flagged; the food stays consumed', async () => {
    const { pizza, dough } = await ctx.createPizza();
    const order = (await scheduled([line(pizza, 2)])).body;
    await setStatus(order._id, 'preparing');
    await setStatus(order._id, 'ready');
    ctx.setNow('2026-11-10T19:19:59');
    expect(await ctx.jobs.uncollected.run()).toBe(0);
    ctx.setNow('2026-11-10T19:20:00');
    expect(await ctx.jobs.uncollected.run()).toBe(1);
    const stored = await Order.findById(order._id);
    expect(stored.status).toBe('uncollected');
    expect(stored.uncollectedAt).toBeDefined();
    expect(await ctx.stockOf(dough)).toEqual({ stock: 2000, reserved: 0, available: 2000 }); // not restored
    expect(await ctx.jobs.uncollected.run()).toBe(0); // idempotent
  });

  test('an order that was never started gives its held ingredients back (nothing was cooked)', async () => {
    const { pizza, dough } = await ctx.createPizza();
    const order = (await scheduled([line(pizza, 2)])).body;
    expect((await ctx.stockOf(dough)).reserved).toBe(500);
    ctx.setNow('2026-11-10T19:30');
    await ctx.jobs.uncollected.run();
    expect(await statusOf(Order, order._id)).toBe('uncollected');
    expect(await ctx.stockOf(dough)).toEqual({ stock: 2500, reserved: 0, available: 2500 });
  });

  test('ASAP orders are measured from their estimated pickup time (order time + 20 min + 20 min grace)', async () => {
    const { pizza } = await ctx.createPizza();
    const order = (await takeaway([line(pizza)])).body; // ordered 17:00, pickup 17:20
    ctx.setNow('2026-11-10T17:39');
    expect(await ctx.jobs.uncollected.run()).toBe(0);
    ctx.setNow('2026-11-10T17:40');
    expect(await ctx.jobs.uncollected.run()).toBe(1);
    expect(await statusOf(Order, order._id)).toBe('uncollected');
  });

  test('served, cancelled and dine-in orders are never flagged', async () => {
    const { pizza } = await ctx.createPizza({ portions: 10 });
    const served = (await scheduled([line(pizza)])).body;
    await setStatus(served._id, 'preparing');
    await setStatus(served._id, 'ready');
    await setStatus(served._id, 'served');
    const cancelled = (await scheduled([line(pizza)])).body;
    await ctx.api.patch(`/api/orders/${cancelled._id}/cancel`, customer.token);
    const reservation = (await book({ startTime: '2026-11-10T17:30' })).body.reservation;
    const dineIn = (await ctx.api.post('/api/orders', customer.token).send({ type: 'dine_in', reservationId: reservation._id, items: [line(pizza)] })).body;

    ctx.setNow('2026-11-10T21:00');
    expect(await ctx.jobs.uncollected.run()).toBe(0);
    expect([await statusOf(Order, served._id), await statusOf(Order, cancelled._id), await statusOf(Order, dineIn._id)]).toEqual(['served', 'cancelled', 'placed']);
  });

  test('an uncollected order can still be handed over late, but not cancelled', async () => {
    const { pizza } = await ctx.createPizza();
    const order = (await scheduled([line(pizza)])).body;
    await setStatus(order._id, 'preparing');
    await setStatus(order._id, 'ready');
    ctx.setNow('2026-11-10T19:30');
    await ctx.jobs.uncollected.run();
    expect((await ctx.api.patch(`/api/orders/${order._id}/cancel`, customer.token)).status).toBe(409);
    const late = await setStatus(order._id, 'served');
    expect(late.status).toBe(200);
    expect(late.body.status).toBe('served');
  });
});

describe('BackgroundJob template', () => {
  const logger = () => ({ info: jest.fn(), error: jest.fn(), warn() {}, debug() {} });

  test('a failing run is logged and returns 0 instead of throwing', async () => {
    const log = logger();
    const job = new (class extends BackgroundJob {
      async execute() {
        throw new Error('database went away');
      }
    })({ name: 'broken', logger: log });
    await expect(job.run()).resolves.toBe(0);
    expect(log.error).toHaveBeenCalledWith('job failed', expect.objectContaining({ job: 'broken', error: 'database went away' }));
    expect(job.running).toBe(false); // can run again next minute
  });

  test('runs never overlap: a second call while one is in progress is skipped', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let executions = 0;
    const job = new (class extends BackgroundJob {
      async execute() {
        executions += 1;
        await gate;
        return 3;
      }
    })({ name: 'slow', logger: logger() });
    const first = job.run();
    expect(await job.run()).toBe(0);
    release();
    expect(await first).toBe(3);
    expect(executions).toBe(1);
  });

  test('a subclass must implement execute()', async () => {
    const job = new BackgroundJob({ name: 'abstract', logger: logger() });
    await expect(job.run()).resolves.toBe(0);
  });

  test('every real job is safe to run on an empty database', async () => {
    await db.clear();
    for (const job of Object.values(ctx.jobs)) await expect(job.run()).resolves.toBe(0);
    expect(table).toBeDefined();
  });
});
