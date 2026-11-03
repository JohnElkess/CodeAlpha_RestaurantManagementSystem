const db = require('../helpers/db');
const { createContext } = require('../helpers/context');
const { seed } = require('../../src/seed/seed');
const data = require('../../src/seed/data');
const Ingredient = require('../../src/models/Ingredient');
const MenuItem = require('../../src/models/MenuItem');
const Table = require('../../src/models/Table');
const User = require('../../src/models/User');

beforeAll(db.connect);
afterAll(db.disconnect);

let ctx;
beforeEach(async () => {
  await db.clear();
  ctx = createContext();
});

describe('seed script', () => {
  test('creates the admin, ingredients, menu with recipes and tables', async () => {
    const created = await seed();
    expect(created).toEqual({ admin: 1, ingredients: data.ingredients.length, menu: data.menu.length, tables: data.tables.length });
    expect(await Ingredient.countDocuments()).toBe(data.ingredients.length);
    expect(await Table.countDocuments()).toBe(data.tables.length);
    const admin = await User.findOne({ role: 'admin' });
    expect(admin.phone).toBe('+201000000000');
    expect(admin.email).toBe('admin@example.com');
  });

  test('every recipe points at a real ingredient and every item starts available', async () => {
    await seed();
    const ids = new Set((await Ingredient.find()).map((i) => String(i._id)));
    const items = await MenuItem.find();
    expect(items).toHaveLength(data.menu.length);
    for (const item of items) {
      expect(item.recipe.length).toBeGreaterThan(0);
      for (const lineItem of item.recipe) expect(ids.has(String(lineItem.ingredient))).toBe(true);
      expect(item.isAvailable).toBe(true);
    }
  });

  test('is idempotent and never overwrites stock the restaurant has since changed', async () => {
    await seed();
    await Ingredient.updateOne({ name: data.ingredients[0].name }, { stock: 7 });
    await MenuItem.updateOne({ name: data.menu[0].name }, { price: 1 });
    expect(await seed()).toEqual({ admin: 0, ingredients: 0, menu: 0, tables: 0 });
    expect((await Ingredient.findOne({ name: data.ingredients[0].name })).stock).toBe(7);
    expect((await MenuItem.findOne({ name: data.menu[0].name })).price).toBe(1);
    expect(await User.countDocuments({ role: 'admin' })).toBe(1);
  });

  test('the seeded admin can log in with the configured password and reach admin routes', async () => {
    await seed();
    const login = await ctx.api.post('/api/auth/login').send({ identifier: '01000000000', password: 'AdminPass123' });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('admin');
    expect((await ctx.api.get('/api/ingredients', login.body.token)).body.items).toHaveLength(data.ingredients.length);
  });

  test('a customer can order from the seeded menu end to end', async () => {
    await seed();
    const customer = await ctx.createUser();
    const menu = (await ctx.api.get('/api/menu')).body.items;
    const res = await ctx.api.post('/api/orders', customer.token).send({ type: 'takeaway', pickupType: 'asap', items: [{ menuItem: menu[0]._id, quantity: 1 }] });
    expect(res.status).toBe(201);
  });

  test('the seed data itself is consistent: unique names and table numbers, whole-number quantities', () => {
    const unique = (list) => new Set(list).size === list.length;
    expect(unique(data.ingredients.map((i) => i.name))).toBe(true);
    expect(unique(data.menu.map((m) => m.name))).toBe(true);
    expect(unique(data.tables.map((t) => t.number))).toBe(true);
    for (const item of data.menu) for (const [, quantity] of item.recipe) expect(Number.isInteger(quantity)).toBe(true);
  });
});
