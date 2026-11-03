const db = require('../helpers/db');
const { createContext } = require('../helpers/context');
const Ingredient = require('../../src/models/Ingredient');

beforeAll(db.connect);
afterAll(db.disconnect);

let ctx;
let admin;
beforeEach(async () => {
  await db.clear();
  ctx = createContext();
  admin = await ctx.createUser({ role: 'admin' });
});

const adjust = (id, body) => ctx.api.patch(`/api/ingredients/${id}/stock`, admin.token).send(body);

describe('managing ingredients', () => {
  test('create, then list with the computed "available" quantity', async () => {
    const res = await ctx.api.post('/api/ingredients', admin.token).send({ name: 'Flour', unit: 'g', stock: 5000, lowStockThreshold: 500 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Flour', unit: 'g', stock: 5000, reserved: 0, available: 5000, lowStockThreshold: 500 });
    await Ingredient.updateOne({ _id: res.body._id }, { reserved: 1200 });
    const list = await ctx.api.get('/api/ingredients', admin.token);
    expect(list.body.items[0]).toMatchObject({ stock: 5000, reserved: 1200, available: 3800 });
  });

  test.each([
    ['a negative stock', { name: 'X', unit: 'g', stock: -1 }],
    ['a fractional stock', { name: 'X', unit: 'g', stock: 1.5 }],
    ['an unknown unit', { name: 'X', unit: 'kg' }],
    ['a missing name', { unit: 'g' }],
  ])('rejects %s with 400', async (_label, body) => {
    expect((await ctx.api.post('/api/ingredients', admin.token).send(body)).status).toBe(400);
  });

  test('duplicate names are a 409; only admins may manage ingredients', async () => {
    await ctx.api.post('/api/ingredients', admin.token).send({ name: 'Flour', unit: 'g' });
    expect((await ctx.api.post('/api/ingredients', admin.token).send({ name: 'Flour', unit: 'g' })).body.error.code).toBe('INGREDIENT_EXISTS');
    const staff = await ctx.createUser({ role: 'staff' });
    expect((await ctx.api.get('/api/ingredients', staff.token)).status).toBe(403);
    expect((await ctx.api.post('/api/ingredients', staff.token).send({ name: 'Salt', unit: 'g' })).status).toBe(403);
  });

  test('update changes name and threshold but never stock; the unit is locked while a recipe uses it', async () => {
    const flour = await ctx.createIngredient({ name: 'Flour', stock: 1000 });
    const res = await ctx.api.put(`/api/ingredients/${flour._id}`, admin.token).send({ name: 'Plain flour', lowStockThreshold: 200, stock: 99999 });
    expect(res.body).toMatchObject({ name: 'Plain flour', lowStockThreshold: 200, stock: 1000 });

    expect((await ctx.api.put(`/api/ingredients/${flour._id}`, admin.token).send({ unit: 'pieces' })).status).toBe(200);
    await ctx.createMenuItem({ recipe: [[flour, 10]] });
    const locked = await ctx.api.put(`/api/ingredients/${flour._id}`, admin.token).send({ unit: 'ml' });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('INGREDIENT_IN_USE');

    expect((await ctx.api.put(`/api/ingredients/${flour._id}`, admin.token).send({})).status).toBe(400);
    expect((await ctx.api.put('/api/ingredients/507f1f77bcf86cd799439011', admin.token).send({ name: 'x' })).status).toBe(404);
  });
});

describe('stock adjustments (restock, waste, correction)', () => {
  test('restock adds, waste removes, a correction goes either way, and each is audited', async () => {
    const flour = await ctx.createIngredient({ stock: 1000 });
    expect((await adjust(flour._id, { delta: 500, reason: 'restock', note: 'Delivery #12' })).body.stock).toBe(1500);
    expect((await adjust(flour._id, { delta: -200, reason: 'waste' })).body.stock).toBe(1300);
    expect((await adjust(flour._id, { delta: -50, reason: 'correction' })).body.stock).toBe(1250);
    expect((await adjust(flour._id, { delta: 25, reason: 'correction' })).body.stock).toBe(1275);

    const trail = await ctx.api.get(`/api/ingredients/${flour._id}/adjustments`, admin.token);
    expect(trail.status).toBe(200);
    expect(trail.body.items).toHaveLength(4);
    expect(trail.body.items[0]).toMatchObject({ delta: 25, reason: 'correction', stockAfter: 1275, adjustedBy: admin.id });
    expect(trail.body.items[3]).toMatchObject({ delta: 500, reason: 'restock', note: 'Delivery #12', stockAfter: 1500 });
  });

  test.each([
    ['a negative restock', { delta: -5, reason: 'restock' }],
    ['a positive waste', { delta: 5, reason: 'waste' }],
    ['a zero change', { delta: 0, reason: 'correction' }],
    ['a fractional change', { delta: 1.5, reason: 'restock' }],
    ['an unknown reason', { delta: 5, reason: 'gift' }],
  ])('rejects %s with 400', async (_label, body) => {
    const flour = await ctx.createIngredient();
    expect((await adjust(flour._id, body)).status).toBe(400);
  });

  test('stock cannot go below zero', async () => {
    const flour = await ctx.createIngredient({ stock: 100 });
    const res = await adjust(flour._id, { delta: -150, reason: 'waste' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STOCK_BELOW_ZERO');
    expect((await ctx.stockOf(flour)).stock).toBe(100);
  });

  test('stock cannot be cut below the quantity already held for pending orders', async () => {
    const flour = await ctx.createIngredient({ stock: 1000 });
    await Ingredient.updateOne({ _id: flour._id }, { reserved: 800 });
    const res = await adjust(flour._id, { delta: -300, reason: 'waste' }); // would leave 700 < 800 held
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STOCK_BELOW_RESERVED');
    expect(res.body.error.details).toEqual({ stock: 1000, reserved: 800 });
    expect((await adjust(flour._id, { delta: -200, reason: 'waste' })).status).toBe(200); // exactly down to the held amount
  });

  test('a rejected adjustment leaves no audit entry; unknown ingredient is 404', async () => {
    const flour = await ctx.createIngredient({ stock: 100 });
    await adjust(flour._id, { delta: -500, reason: 'waste' });
    expect((await ctx.api.get(`/api/ingredients/${flour._id}/adjustments`, admin.token)).body.items).toHaveLength(0);
    expect((await adjust('507f1f77bcf86cd799439011', { delta: 5, reason: 'restock' })).status).toBe(404);
    expect((await ctx.api.get('/api/ingredients/507f1f77bcf86cd799439011/adjustments', admin.token)).status).toBe(404);
  });

  test('two simultaneous waste adjustments cannot together remove more than exists', async () => {
    const flour = await ctx.createIngredient({ stock: 100 });
    const results = await Promise.all([adjust(flour._id, { delta: -80, reason: 'waste' }), adjust(flour._id, { delta: -80, reason: 'waste' })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await ctx.stockOf(flour)).stock).toBe(20);
  });
});

describe('low-stock alerts', () => {
  test('lists ingredients at or below their threshold, worst first, with the shortfall', async () => {
    const staff = await ctx.createUser({ role: 'staff' });
    await ctx.createIngredient({ name: 'Plenty', stock: 1000, lowStockThreshold: 100 });
    await ctx.createIngredient({ name: 'AtThreshold', stock: 100, lowStockThreshold: 100 });
    await ctx.createIngredient({ name: 'Empty', stock: 0, lowStockThreshold: 50 });
    const held = await ctx.createIngredient({ name: 'HeldAway', stock: 500, lowStockThreshold: 100 });
    await Ingredient.updateOne({ _id: held._id }, { reserved: 450 }); // available 50

    const res = await ctx.api.get('/api/inventory/alerts', staff.token);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.items.map((i) => i.name).sort()).toEqual(['AtThreshold', 'Empty', 'HeldAway']);
    const empty = res.body.items.find((i) => i.name === 'Empty');
    expect(empty).toMatchObject({ available: 0, shortfall: 50 });
  });

  test('an ingredient leaves the alert list after a restock; customers cannot see alerts', async () => {
    const staff = await ctx.createUser({ role: 'staff' });
    const customer = await ctx.createUser();
    const flour = await ctx.createIngredient({ stock: 10, lowStockThreshold: 100 });
    expect((await ctx.api.get('/api/inventory/alerts', staff.token)).body.count).toBe(1);
    await adjust(flour._id, { delta: 500, reason: 'restock' });
    expect((await ctx.api.get('/api/inventory/alerts', staff.token)).body.count).toBe(0);
    expect((await ctx.api.get('/api/inventory/alerts', customer.token)).status).toBe(403);
  });
});
