const db = require('../helpers/db');
const { createContext } = require('../helpers/context');
const Order = require('../../src/models/Order');
const Ingredient = require('../../src/models/Ingredient');

beforeAll(db.connect);
afterAll(db.disconnect);

let ctx;
let admin;
let staff;
let customer;
beforeEach(async () => {
  await db.clear();
  ctx = createContext(); // Tuesday 2026-11-10, 17:00 Cairo
  admin = await ctx.createUser({ role: 'admin' });
  staff = await ctx.createUser({ role: 'staff' });
  customer = await ctx.createUser();
});

const line = (menuItem, quantity = 1) => ({ menuItem: String(menuItem._id), quantity });
const takeaway = (items, o = {}) => ctx.api.post('/api/orders', customer.token).send({ type: 'takeaway', pickupType: 'asap', items, ...o });
const sales = (date) => ctx.api.get(`/api/reports/daily-sales${date ? `?date=${date}` : ''}`, admin.token);

async function menu() {
  const stuff = await ctx.createIngredient({ name: 'Stuff', stock: 1000000 });
  const pizza = await ctx.createMenuItem({ name: 'Pizza', price: 100, recipe: [[stuff, 10]] });
  const salad = await ctx.createMenuItem({ name: 'Salad', price: 19.99, recipe: [[stuff, 10]] });
  return { pizza, salad };
}

describe('daily sales (scope 6)', () => {
  test('total, order count and a per-item breakdown; cancelled orders are excluded', async () => {
    const { pizza, salad } = await menu();
    await takeaway([line(pizza, 2), line(salad, 3)]); // 200 + 59.97
    const doomed = (await takeaway([line(salad, 1)])).body;
    await ctx.api.patch(`/api/orders/${doomed._id}/cancel`, customer.token);

    const res = await sales('2026-11-10');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ date: '2026-11-10', timezone: 'Africa/Cairo', totalSales: 259.97, orderCount: 1, byType: { takeaway: 1 }, byStatus: { placed: 1 } });
    expect(res.body.items).toEqual([
      { menuItem: String(salad._id), name: 'Salad', quantity: 3, revenue: 59.97 },
      { menuItem: String(pizza._id), name: 'Pizza', quantity: 2, revenue: 200 },
    ]);
  });

  test('the same dish across several orders is summed, and money stays exact', async () => {
    const { salad } = await menu();
    for (let i = 0; i < 3; i += 1) await takeaway([line(salad, 3)]); // 3 x 59.97
    const res = await sales('2026-11-10');
    expect(res.body.totalSales).toBe(179.91);
    expect(res.body.items).toEqual([expect.objectContaining({ quantity: 9, revenue: 179.91 })]);
  });

  test('an order counts on the day it is FOR: pre-orders on the reservation day, scheduled takeaways on pickup day', async () => {
    const { pizza } = await menu();
    await ctx.createTable({ number: 1, capacity: 4 });
    await ctx.api.post('/api/reservations', customer.token).send({ startTime: '2026-11-11T19:00', partySize: 2, preOrder: { items: [line(pizza)] } });
    await takeaway([line(pizza)], { pickupType: 'scheduled', pickupTime: '2026-11-12T19:00' });

    expect((await sales('2026-11-10')).body.orderCount).toBe(0); // nothing is for today
    expect(await sales('2026-11-11').then((r) => r.body)).toMatchObject({ orderCount: 1, totalSales: 100, byType: { dine_in: 1 } });
    expect(await sales('2026-11-12').then((r) => r.body)).toMatchObject({ orderCount: 1, totalSales: 100, byType: { takeaway: 1 } });
  });

  test('day boundaries follow the restaurant timezone, not UTC', async () => {
    const { pizza } = await menu();
    const base = { customer: customer.id, type: 'takeaway', pickupType: 'asap', pickupTime: ctx.local('2026-11-11T12:00'), items: [{ menuItem: pizza._id, name: 'Pizza', quantity: 1, unitPrice: 100 }], total: 100 };
    await Order.create({ ...base, scheduledFor: ctx.local('2026-11-10T23:59:59') });
    await Order.create({ ...base, scheduledFor: ctx.local('2026-11-11T00:00:00') }); // exactly midnight belongs to the next day
    await Order.create({ ...base, scheduledFor: ctx.local('2026-11-11T00:30:00') }); // 22:30 UTC on the 10th
    expect((await sales('2026-11-10')).body.orderCount).toBe(1);
    expect((await sales('2026-11-11')).body.orderCount).toBe(2);
  });

  test('statuses other than cancelled are all included, with a breakdown by status', async () => {
    const { pizza } = await menu();
    const a = (await takeaway([line(pizza)])).body;
    const b = (await takeaway([line(pizza)])).body;
    await takeaway([line(pizza)]);
    await ctx.api.patch(`/api/orders/${a._id}/status`, staff.token).send({ status: 'preparing' });
    await ctx.api.patch(`/api/orders/${b._id}/status`, staff.token).send({ status: 'preparing' });
    await ctx.api.patch(`/api/orders/${b._id}/status`, staff.token).send({ status: 'ready' });
    const res = await sales('2026-11-10');
    expect(res.body.orderCount).toBe(3);
    expect(res.body.byStatus).toEqual({ placed: 1, preparing: 1, ready: 1 });
  });

  test('items keep the name they were ordered under, even after a rename', async () => {
    const { pizza } = await menu();
    await takeaway([line(pizza)]);
    await require('../../src/models/MenuItem').updateOne({ _id: pizza._id }, { name: 'Renamed pizza' });
    expect((await sales('2026-11-10')).body.items[0].name).toBe('Pizza');
  });

  test('an empty day returns zeros, and a missing date means today in the restaurant timezone', async () => {
    const empty = await sales('2026-01-01');
    expect(empty.body).toMatchObject({ totalSales: 0, orderCount: 0, items: [], byType: {}, byStatus: {} });
    ctx.setNow('2026-11-10T01:30'); // 23:30 UTC on the 9th, but already the 10th in Cairo
    expect((await sales()).body.date).toBe('2026-11-10');
  });

  test('bad dates are 400, and only admins may read reports', async () => {
    for (const date of ['2026-02-30', 'yesterday', '10-11-2026']) expect((await sales(date)).status).toBe(400);
    expect((await ctx.api.get('/api/reports/daily-sales?date=2026-11-10', staff.token)).status).toBe(403);
    expect((await ctx.api.get('/api/reports/daily-sales?date=2026-11-10', customer.token)).status).toBe(403);
  });
});

describe('low-stock report', () => {
  test('lists short ingredients, worst first, with the menu items they affect', async () => {
    const flour = await ctx.createIngredient({ name: 'Flour', stock: 100, lowStockThreshold: 500 }); // shortfall 400
    const salt = await ctx.createIngredient({ name: 'Salt', stock: 90, lowStockThreshold: 100 }); // shortfall 10
    await ctx.createIngredient({ name: 'Water', stock: 9000, lowStockThreshold: 100 }); // fine
    await ctx.createMenuItem({ name: 'Bread', recipe: [[flour, 10], [salt, 1]] });
    await ctx.createMenuItem({ name: 'Cake', recipe: [[flour, 20]] });

    const res = await ctx.api.get('/api/reports/low-stock', admin.token);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.generatedAt).toBe(ctx.local('2026-11-10T17:00').toISOString());
    expect(res.body.ingredients.map((i) => i.name)).toEqual(['Flour', 'Salt']);
    expect(res.body.ingredients[0]).toMatchObject({ available: 100, shortfall: 400, affectedMenuItems: expect.arrayContaining(['Bread', 'Cake']) });
    expect(res.body.ingredients[1].affectedMenuItems).toEqual(['Bread']);
  });

  test('held stock counts against availability, and the report is empty when all is well', async () => {
    const flour = await ctx.createIngredient({ name: 'Flour', stock: 1000, lowStockThreshold: 200 });
    expect((await ctx.api.get('/api/reports/low-stock', admin.token)).body.count).toBe(0);
    await Ingredient.updateOne({ _id: flour._id }, { reserved: 900 }); // available 100 <= 200
    expect((await ctx.api.get('/api/reports/low-stock', admin.token)).body.count).toBe(1);
    expect((await ctx.api.get('/api/reports/low-stock', staff.token)).status).toBe(403);
  });
});
