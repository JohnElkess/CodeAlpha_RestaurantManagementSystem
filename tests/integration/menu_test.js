const db = require('../helpers/db');
const { createContext } = require('../helpers/context');
const MenuItem = require('../../src/models/MenuItem');

beforeAll(db.connect);
afterAll(db.disconnect);

let ctx;
let admin;
beforeEach(async () => {
  await db.clear();
  ctx = createContext();
  admin = await ctx.createUser({ role: 'admin' });
});

const payload = (ingredient, o = {}) => ({
  name: 'Margherita',
  description: 'Classic',
  price: 120.5,
  category: 'Pizza',
  recipe: [{ ingredient: String(ingredient._id), quantityPerPortion: 250 }],
  ...o,
});

describe('who sees what', () => {
  test('the public menu hides recipes and internal flags; admins see everything', async () => {
    const dough = await ctx.createIngredient({ name: 'Dough', stock: 5000 });
    await ctx.createMenuItem({ name: 'Pizza', recipe: [[dough, 250]] });

    const publicView = await ctx.api.get('/api/menu');
    expect(publicView.status).toBe(200);
    expect(Object.keys(publicView.body.items[0]).sort()).toEqual(['_id', 'category', 'description', 'isAvailable', 'name', 'price']);

    const customer = await ctx.createUser();
    const asCustomer = await ctx.api.get('/api/menu', customer.token);
    expect(asCustomer.body.items[0].recipe).toBeUndefined();

    const asAdmin = await ctx.api.get('/api/menu', admin.token);
    expect(asAdmin.body.items[0]).toMatchObject({ recipe: [{ ingredient: { name: 'Dough', unit: 'g' }, quantityPerPortion: 250 }], manuallyDisabled: false, outOfStock: false });
  });

  test('a bad token on the optional-auth menu is rejected instead of silently ignored', async () => {
    expect((await ctx.api.get('/api/menu', 'garbage')).status).toBe(401);
  });

  test('only admins can create, update or toggle', async () => {
    const dough = await ctx.createIngredient();
    const staff = await ctx.createUser({ role: 'staff' });
    const customer = await ctx.createUser();
    for (const token of [staff.token, customer.token]) {
      expect((await ctx.api.post('/api/menu', token).send(payload(dough))).status).toBe(403);
    }
    expect((await ctx.api.post('/api/menu').send(payload(dough))).status).toBe(401);
  });
});

describe('creating and updating', () => {
  test('creates an item with a recipe', async () => {
    const dough = await ctx.createIngredient({ stock: 5000 });
    const res = await ctx.api.post('/api/menu', admin.token).send(payload(dough));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Margherita', price: 120.5, isAvailable: true, recipe: [{ quantityPerPortion: 250 }] });
  });

  test.each([
    ['a price with 3 decimals', { price: 1.005 }],
    ['a negative price', { price: -1 }],
    ['a price sent as text', { price: '10' }],
    ['an empty recipe', { recipe: [] }],
    ['a fractional quantity', { recipe: [{ ingredient: '507f1f77bcf86cd799439011', quantityPerPortion: 2.5 }] }],
    ['a zero quantity', { recipe: [{ ingredient: '507f1f77bcf86cd799439011', quantityPerPortion: 0 }] }],
    ['a missing name', { name: ' ' }],
  ])('rejects %s with 400', async (_label, override) => {
    const dough = await ctx.createIngredient();
    const res = await ctx.api.post('/api/menu', admin.token).send(payload(dough, override));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('a recipe cannot list an ingredient twice or reference an unknown one', async () => {
    const dough = await ctx.createIngredient();
    const twice = await ctx.api.post('/api/menu', admin.token).send(
      payload(dough, { recipe: [{ ingredient: String(dough._id), quantityPerPortion: 1 }, { ingredient: String(dough._id), quantityPerPortion: 2 }] })
    );
    expect(twice.body.error.code).toBe('DUPLICATE_RECIPE_INGREDIENT');
    const unknown = await ctx.api.post('/api/menu', admin.token).send(payload(dough, { recipe: [{ ingredient: '507f1f77bcf86cd799439011', quantityPerPortion: 1 }] }));
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('UNKNOWN_INGREDIENT');
  });

  test('a duplicate name is a 409', async () => {
    const dough = await ctx.createIngredient();
    await ctx.api.post('/api/menu', admin.token).send(payload(dough));
    const res = await ctx.api.post('/api/menu', admin.token).send(payload(dough));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MENU_ITEM_EXISTS');
  });

  test('PUT replaces details and recipe, and keeps a manual disable', async () => {
    const dough = await ctx.createIngredient({ stock: 5000 });
    const cheese = await ctx.createIngredient({ stock: 5000 });
    const created = (await ctx.api.post('/api/menu', admin.token).send(payload(dough))).body;
    await ctx.api.patch(`/api/menu/${created._id}/availability`, admin.token).send({ isAvailable: false });

    const res = await ctx.api.put(`/api/menu/${created._id}`, admin.token).send(
      payload(dough, { price: 99, recipe: [{ ingredient: String(cheese._id), quantityPerPortion: 80 }] })
    );
    expect(res.status).toBe(200);
    expect(res.body.price).toBe(99);
    expect(res.body.recipe).toHaveLength(1);
    expect(res.body.recipe[0].ingredient._id).toBe(String(cheese._id));
    expect(res.body.isAvailable).toBe(false); // still switched off by the admin
  });

  test('PUT to an unknown item is 404; renaming onto an existing name is 409', async () => {
    const dough = await ctx.createIngredient({ stock: 5000 });
    expect((await ctx.api.put('/api/menu/507f1f77bcf86cd799439011', admin.token).send(payload(dough))).status).toBe(404);
    await ctx.api.post('/api/menu', admin.token).send(payload(dough, { name: 'One' }));
    const two = (await ctx.api.post('/api/menu', admin.token).send(payload(dough, { name: 'Two' }))).body;
    expect((await ctx.api.put(`/api/menu/${two._id}`, admin.token).send(payload(dough, { name: 'One' }))).status).toBe(409);
  });

  test('GET one: 200, 404 for unknown, 400 for a malformed id', async () => {
    const dough = await ctx.createIngredient({ stock: 5000 });
    const item = await ctx.createMenuItem({ recipe: [[dough, 10]] });
    expect((await ctx.api.get(`/api/menu/${item._id}`)).status).toBe(200);
    expect((await ctx.api.get('/api/menu/507f1f77bcf86cd799439011')).status).toBe(404);
    expect((await ctx.api.get('/api/menu/not-an-id')).status).toBe(400);
  });
});

describe('availability (scope section 4)', () => {
  test('an item is unavailable while any ingredient is short for one portion, and returns after a restock', async () => {
    const dough = await ctx.createIngredient({ name: 'Dough', stock: 100 }); // a portion needs 250
    const created = (await ctx.api.post('/api/menu', admin.token).send(payload(dough))).body;
    expect(created.isAvailable).toBe(false);
    expect(created.outOfStock).toBe(true);
    expect((await ctx.api.get('/api/menu')).body.items[0].isAvailable).toBe(false);

    const restock = await ctx.api.patch(`/api/ingredients/${dough._id}/stock`, admin.token).send({ delta: 200, reason: 'restock' });
    expect(restock.status).toBe(200);
    expect((await ctx.api.get(`/api/menu/${created._id}`, admin.token)).body).toMatchObject({ isAvailable: true, outOfStock: false });
  });

  test('exactly one portion of stock is enough (the rule is "below", not "at or below")', async () => {
    const dough = await ctx.createIngredient({ stock: 250 });
    const created = (await ctx.api.post('/api/menu', admin.token).send(payload(dough))).body;
    expect(created.isAvailable).toBe(true);
  });

  test('a manual disable survives restocking; enabling again needs stock', async () => {
    const dough = await ctx.createIngredient({ stock: 5000 });
    const item = await ctx.createMenuItem({ recipe: [[dough, 250]] });

    const off = await ctx.api.patch(`/api/menu/${item._id}/availability`, admin.token).send({ isAvailable: false });
    expect(off.body).toMatchObject({ isAvailable: false, manuallyDisabled: true });

    await ctx.api.patch(`/api/ingredients/${dough._id}/stock`, admin.token).send({ delta: 1000, reason: 'restock' });
    expect((await MenuItem.findById(item._id)).isAvailable).toBe(false); // restock did not re-enable it

    const on = await ctx.api.patch(`/api/menu/${item._id}/availability`, admin.token).send({ isAvailable: true });
    expect(on.body.isAvailable).toBe(true);
  });

  test('enabling an item with no stock leaves it unavailable', async () => {
    const dough = await ctx.createIngredient({ stock: 10 });
    const item = await ctx.createMenuItem({ recipe: [[dough, 250]] });
    const res = await ctx.api.patch(`/api/menu/${item._id}/availability`, admin.token).send({ isAvailable: true });
    expect(res.body).toMatchObject({ isAvailable: false, outOfStock: true });
  });

  test('the toggle needs a boolean', async () => {
    const dough = await ctx.createIngredient();
    const item = await ctx.createMenuItem({ recipe: [[dough, 1]] });
    expect((await ctx.api.patch(`/api/menu/${item._id}/availability`, admin.token).send({ isAvailable: 'no' })).status).toBe(400);
  });

  test('an item sharing an ingredient becomes unavailable together with its sibling', async () => {
    const dough = await ctx.createIngredient({ stock: 400 });
    const a = await ctx.createMenuItem({ name: 'A', recipe: [[dough, 250]] });
    const b = await ctx.createMenuItem({ name: 'B', recipe: [[dough, 300]] });
    expect((await MenuItem.findById(a._id)).isAvailable).toBe(true);
    expect((await MenuItem.findById(b._id)).isAvailable).toBe(true);
    await ctx.api.patch(`/api/ingredients/${dough._id}/stock`, admin.token).send({ delta: -150, reason: 'waste' }); // 250 left
    expect((await MenuItem.findById(a._id)).isAvailable).toBe(true);
    expect((await MenuItem.findById(b._id)).isAvailable).toBe(false);
  });
});
