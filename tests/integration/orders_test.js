const db = require('../helpers/db');
const { createContext } = require('../helpers/context');
const Order = require('../../src/models/Order');
const MenuItem = require('../../src/models/MenuItem');

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

const place = (token, body) => ctx.api.post('/api/orders', token).send(body);
const line = (menuItem, quantity = 1) => ({ menuItem: String(menuItem._id), quantity });
const takeaway = (token, items, o = {}) => place(token, { type: 'takeaway', pickupType: 'asap', items, ...o });
const setStatus = (id, status, token = staff.token) => ctx.api.patch(`/api/orders/${id}/status`, token).send({ status });
const cancel = (id, token = customer.token) => ctx.api.patch(`/api/orders/${id}/cancel`, token);
const edit = (id, items, token = customer.token) => ctx.api.put(`/api/orders/${id}/items`, token).send({ items });

describe('placing takeaway orders', () => {
  test('ASAP: snapshots, total, estimated pickup, and an ingredient hold', async () => {
    const { pizza, dough, cheese } = await ctx.createPizza({ portions: 10, price: 100 });
    const res = await takeaway(customer.token, [line(pizza, 2)]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'takeaway', status: 'placed', pickupType: 'asap', total: 200, customer: { _id: customer.id } });
    expect(res.body.items).toEqual([{ menuItem: String(pizza._id), name: pizza.name, quantity: 2, unitPrice: 100 }]);
    expect(res.body.pickupTime).toBe(ctx.local('2026-11-10T17:20').toISOString());
    expect(res.body.scheduledFor).toBe(ctx.local('2026-11-10T17:00').toISOString());
    expect(res.body.hold).toBeUndefined();
    expect(await ctx.stockOf(dough)).toEqual({ stock: 2500, reserved: 500, available: 2000 }); // held, not yet used
    expect(await ctx.stockOf(cheese)).toEqual({ stock: 1000, reserved: 200, available: 800 });
  });

  test('scheduled pickup is accepted when it follows the slot and lead-time rules', async () => {
    const { pizza } = await ctx.createPizza();
    const res = await takeaway(customer.token, [line(pizza)], { pickupType: 'scheduled', pickupTime: '2026-11-11T19:00' });
    expect(res.status).toBe(201);
    expect(res.body.pickupTime).toBe(ctx.local('2026-11-11T19:00').toISOString());
    expect(res.body.scheduledFor).toBe(ctx.local('2026-11-11T19:00').toISOString());
  });

  test.each([
    [{ pickupType: undefined }, 'PICKUP_TYPE_REQUIRED'],
    [{ pickupType: 'scheduled' }, 'PICKUP_TIME_REQUIRED'],
    [{ pickupType: 'scheduled', pickupTime: '2026-11-10T17:15' }, 'NOT_ON_SLOT_BOUNDARY'],
    [{ pickupType: 'scheduled', pickupTime: '2026-11-10T17:00' }, 'PICKUP_TOO_SOON'],
    [{ pickupType: 'scheduled', pickupTime: '2026-11-18T19:00' }, 'BEYOND_PICKUP_HORIZON'],
    [{ pickupType: 'scheduled', pickupTime: '2026-11-11T23:45' }, 'NOT_ON_SLOT_BOUNDARY'],
    [{ pickupType: 'scheduled', pickupTime: '2026-11-12T00:00' }, 'OUTSIDE_PICKUP_HOURS'],
    [{ pickupType: 'asap', pickupTime: '2026-11-11T19:00' }, 'PICKUP_TIME_NOT_ALLOWED'],
  ])('pickup %j is rejected with %s and holds nothing', async (override, code) => {
    const { pizza, dough } = await ctx.createPizza();
    const res = await takeaway(customer.token, [line(pizza)], override);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect((await ctx.stockOf(dough)).reserved).toBe(0);
    expect(await Order.countDocuments()).toBe(0);
  });

  test('ASAP orders are refused outside opening hours and after 11:30 PM', async () => {
    const { pizza } = await ctx.createPizza();
    ctx.setNow('2026-11-10T15:30');
    expect((await takeaway(customer.token, [line(pizza)])).body.error.code).toBe('OUTSIDE_ORDERING_HOURS');
    ctx.setNow('2026-11-10T23:31');
    expect((await takeaway(customer.token, [line(pizza)])).body.error.code).toBe('OUTSIDE_ORDERING_HOURS');
    ctx.setNow('2026-11-10T23:30');
    expect((await takeaway(customer.token, [line(pizza)])).status).toBe(201);
  });

  test('staff order on behalf of a customer; a customer cannot order for someone else', async () => {
    const { pizza } = await ctx.createPizza();
    expect((await takeaway(staff.token, [line(pizza)])).body.error.code).toBe('CUSTOMER_REQUIRED');
    const onBehalf = await takeaway(staff.token, [line(pizza)], { customerId: customer.id });
    expect(onBehalf.status).toBe(201);
    expect(onBehalf.body.customer._id).toBe(customer.id);
    expect((await Order.findOne()).createdBy.toString()).toBe(staff.id);
    const other = await ctx.createUser();
    expect((await takeaway(customer.token, [line(pizza)], { customerId: other.id })).status).toBe(403);
  });
});

describe('items, prices and validation', () => {
  test('the total is exact in money terms (19.99 x 3 = 59.97) and sums several lines', async () => {
    const dough = await ctx.createIngredient({ stock: 100000 });
    const a = await ctx.createMenuItem({ price: 19.99, recipe: [[dough, 10]] });
    const b = await ctx.createMenuItem({ price: 5.01, recipe: [[dough, 10]] });
    expect((await takeaway(customer.token, [line(a, 3)])).body.total).toBe(59.97);
    expect((await takeaway(customer.token, [line(a, 3), line(b, 2)])).body.total).toBe(69.99);
  });

  test('later menu changes never alter an existing order (name and price are snapshots)', async () => {
    const { pizza } = await ctx.createPizza({ price: 100 });
    const placed = (await takeaway(customer.token, [line(pizza)])).body;
    await MenuItem.updateOne({ _id: pizza._id }, { price: 999, name: 'Renamed' });
    const fetched = await ctx.api.get(`/api/orders/${placed._id}`, customer.token);
    expect(fetched.body.items[0]).toMatchObject({ name: pizza.name, unitPrice: 100 });
    expect(fetched.body.total).toBe(100);
  });

  test('the same item on two lines is merged into one', async () => {
    const { pizza, dough } = await ctx.createPizza();
    const res = await takeaway(customer.token, [line(pizza, 1), line(pizza, 2)]);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].quantity).toBe(3);
    expect((await ctx.stockOf(dough)).reserved).toBe(750);
  });

  test.each([
    ['no items', []],
    ['a zero quantity', [{ quantity: 0 }]],
    ['a fractional quantity', [{ quantity: 1.5 }]],
    ['a quantity above 50', [{ quantity: 51 }]],
    ['a malformed menu item id', [{ menuItem: 'abc', quantity: 1 }]],
  ])('rejects %s with 400', async (_label, items) => {
    const { pizza } = await ctx.createPizza();
    const body = items.map((i) => ({ menuItem: String(pizza._id), quantity: 1, ...i }));
    expect((await takeaway(customer.token, body)).status).toBe(400);
  });

  test('an unknown menu item is a 400 with the missing id; an unknown order type is a 400', async () => {
    const res = await takeaway(customer.token, [{ menuItem: '507f1f77bcf86cd799439011', quantity: 1 }]);
    expect(res.body.error).toMatchObject({ code: 'MENU_ITEM_NOT_FOUND', details: { missing: ['507f1f77bcf86cd799439011'] } });
    expect((await place(customer.token, { type: 'delivery', items: [] })).status).toBe(400);
  });

  test('merged quantity above 50 portions of one item is refused', async () => {
    const { pizza } = await ctx.createPizza({ portions: 200 });
    const res = await takeaway(customer.token, [line(pizza, 30), line(pizza, 30)]);
    expect(res.body.error.code).toBe('QUANTITY_TOO_LARGE');
  });

  test('an item the admin switched off cannot be ordered, and nothing is held', async () => {
    const { pizza, dough } = await ctx.createPizza();
    await MenuItem.updateOne({ _id: pizza._id }, { manuallyDisabled: true, isAvailable: false });
    const res = await takeaway(customer.token, [line(pizza)]);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'MENU_ITEM_UNAVAILABLE', details: { items: [{ name: pizza.name }] } });
    expect((await ctx.stockOf(dough)).reserved).toBe(0);
  });
});

describe('dine-in orders', () => {
  let table;
  beforeEach(async () => {
    table = await ctx.createTable({ number: 1, capacity: 4 });
  });
  const reserve = async (token = customer.token) =>
    (await ctx.api.post('/api/reservations', token).send({ startTime: '2026-11-10T19:00', partySize: 2, tableId: String(table._id) })).body.reservation;
  const dineIn = (token, reservationId, items, o = {}) => place(token, { type: 'dine_in', reservationId, items, ...o });

  test('needs a reservation of the same customer; the order is "for" the reservation start', async () => {
    const { pizza } = await ctx.createPizza();
    const reservation = await reserve();
    expect((await dineIn(customer.token, undefined, [line(pizza)])).body.error.code).toBe('RESERVATION_REQUIRED');
    const res = await dineIn(customer.token, reservation._id, [line(pizza)]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'dine_in', reservation: reservation._id, status: 'placed' });
    expect(res.body.scheduledFor).toBe(ctx.local('2026-11-10T19:00').toISOString());
    expect(res.body.pickupType).toBeUndefined();
  });

  test("someone else's reservation looks like a missing one", async () => {
    const { pizza } = await ctx.createPizza();
    const reservation = await reserve();
    const stranger = await ctx.createUser();
    const res = await dineIn(stranger.token, reservation._id, [line(pizza)]);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RESERVATION_NOT_FOUND');
  });

  test('a seated guest can order again (a second round); cancelled and completed reservations cannot', async () => {
    const { pizza } = await ctx.createPizza({ portions: 10 });
    const reservation = await reserve();
    await ctx.api.patch(`/api/reservations/${reservation._id}/seat`, staff.token);
    expect((await dineIn(customer.token, reservation._id, [line(pizza)])).status).toBe(201);
    expect((await dineIn(customer.token, reservation._id, [line(pizza)])).status).toBe(201);
    await ctx.api.patch(`/api/reservations/${reservation._id}/complete`, staff.token);
    const res = await dineIn(customer.token, reservation._id, [line(pizza)]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RESERVATION_NOT_ACTIVE');
  });

  test('staff order on behalf of the reservation holder, but only for that customer', async () => {
    const { pizza } = await ctx.createPizza();
    const reservation = await reserve();
    const stranger = await ctx.createUser();
    expect((await dineIn(staff.token, reservation._id, [line(pizza)], { customerId: customer.id })).status).toBe(201);
    expect((await dineIn(staff.token, reservation._id, [line(pizza)], { customerId: stranger.id })).status).toBe(404);
  });
});

describe('stock: hold, shortage and automatic availability', () => {
  test('an order larger than the stock is a 409 that names the short ingredients and holds nothing', async () => {
    const { pizza, dough, cheese } = await ctx.createPizza({ portions: 3 });
    const res = await takeaway(customer.token, [line(pizza, 4)]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(res.body.error.details.shortages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: dough.name, needed: 1000, available: 750 }),
        expect.objectContaining({ name: cheese.name, needed: 400, available: 300 }),
      ])
    );
    expect((await ctx.stockOf(dough)).reserved).toBe(0);
    expect((await ctx.stockOf(cheese)).reserved).toBe(0);
    expect(await Order.countDocuments()).toBe(0);
  });

  test('an order that needs several ingredients is all-or-nothing: a shortage on one releases the others', async () => {
    const plenty = await ctx.createIngredient({ name: 'Plenty', stock: 100000 });
    const scarce = await ctx.createIngredient({ name: 'Scarce', stock: 50 });
    const easy = await ctx.createMenuItem({ name: 'Easy', recipe: [[plenty, 100]] });
    const hard = await ctx.createMenuItem({ name: 'Hard', recipe: [[plenty, 100], [scarce, 20]] });
    const res = await takeaway(customer.token, [line(easy, 3), line(hard, 3)]); // Scarce: needs 60, has 50
    expect(res.status).toBe(409);
    expect(res.body.error.details.shortages.map((s) => s.name)).toEqual(['Scarce']);
    expect(await ctx.stockOf(plenty)).toEqual({ stock: 100000, reserved: 0, available: 100000 });
    expect(await ctx.stockOf(scarce)).toEqual({ stock: 50, reserved: 0, available: 50 });
  });

  test('two dishes sharing an ingredient are added together when checking stock', async () => {
    const dough = await ctx.createIngredient({ stock: 500 });
    const a = await ctx.createMenuItem({ recipe: [[dough, 250]] });
    const b = await ctx.createMenuItem({ recipe: [[dough, 300]] });
    expect((await takeaway(customer.token, [line(a), line(b)])).status).toBe(409); // 550 > 500, though each alone fits
    expect((await takeaway(customer.token, [line(a, 2)])).status).toBe(201);
  });

  test('taking the last portion switches the item off, and cancelling brings it back', async () => {
    const { pizza } = await ctx.createPizza({ portions: 2 });
    const order = (await takeaway(customer.token, [line(pizza, 2)])).body;
    expect((await ctx.api.get('/api/menu')).body.items[0].isAvailable).toBe(false);
    const blocked = await takeaway(customer.token, [line(pizza)]);
    expect(blocked.body.error.code).toBe('MENU_ITEM_UNAVAILABLE');
    await cancel(order._id);
    expect((await ctx.api.get('/api/menu')).body.items[0].isAvailable).toBe(true);
    expect((await takeaway(customer.token, [line(pizza)])).status).toBe(201);
  });

  test('stock that is only held for others is not available to a new order', async () => {
    const { pizza } = await ctx.createPizza({ portions: 3 });
    await takeaway(customer.token, [line(pizza, 2)]);
    const res = await takeaway(customer.token, [line(pizza, 2)]);
    expect(res.status).toBe(409);
    const doughShortage = res.body.error.details.shortages.find((s) => s.name.startsWith('Dough'));
    expect(doughShortage).toMatchObject({ needed: 500, available: 250 }); // 750 in stock - 500 held for the first order
  });
});

describe('preparing, ready, served', () => {
  let pizza;
  let dough;
  let order;
  beforeEach(async () => {
    ({ pizza, dough } = await ctx.createPizza({ portions: 10 }));
    order = (await takeaway(customer.token, [line(pizza, 2)])).body;
  });

  test('preparing turns the hold into a real deduction; ready and served keep stock unchanged', async () => {
    expect(await ctx.stockOf(dough)).toEqual({ stock: 2500, reserved: 500, available: 2000 });
    const preparing = await setStatus(order._id, 'preparing');
    expect(preparing.status).toBe(200);
    expect(preparing.body.status).toBe('preparing');
    expect(preparing.body.preparingAt).toBeDefined();
    expect(await ctx.stockOf(dough)).toEqual({ stock: 2000, reserved: 0, available: 2000 });

    expect((await setStatus(order._id, 'ready')).body.readyAt).toBeDefined();
    expect((await setStatus(order._id, 'served')).body.servedAt).toBeDefined();
    expect(await ctx.stockOf(dough)).toEqual({ stock: 2000, reserved: 0, available: 2000 });
  });

  test('steps cannot be skipped or repeated, and the error lists what is allowed next', async () => {
    const skip = await setStatus(order._id, 'ready');
    expect(skip.status).toBe(409);
    expect(skip.body.error).toMatchObject({ code: 'INVALID_STATUS_TRANSITION', details: { from: 'placed', to: 'ready', allowedNext: ['preparing', 'cancelled', 'uncollected'] } });
    expect((await setStatus(order._id, 'served')).status).toBe(409);
    await setStatus(order._id, 'preparing');
    expect((await setStatus(order._id, 'preparing')).status).toBe(409);
    expect((await setStatus(order._id, 'served')).status).toBe(409); // must be ready first
  });

  test('"cancelled" and "uncollected" are not valid targets of the status endpoint; unknown orders are 404', async () => {
    expect((await setStatus(order._id, 'cancelled')).status).toBe(400);
    expect((await setStatus(order._id, 'uncollected')).status).toBe(400);
    expect((await setStatus('507f1f77bcf86cd799439011', 'preparing')).status).toBe(404);
  });

  test('two staff pressing "preparing" at once deduct the stock only once', async () => {
    const results = await Promise.all([setStatus(order._id, 'preparing'), setStatus(order._id, 'preparing')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await ctx.stockOf(dough)).toEqual({ stock: 2000, reserved: 0, available: 2000 });
  });
});

describe('cancelling', () => {
  let pizza;
  let dough;
  let order;
  beforeEach(async () => {
    ({ pizza, dough } = await ctx.createPizza({ portions: 10 }));
    order = (await takeaway(customer.token, [line(pizza, 2)])).body;
  });

  test('before preparing the hold is released and the stock is untouched', async () => {
    const res = await cancel(order._id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.cancelledAt).toBeDefined();
    expect(await ctx.stockOf(dough)).toEqual({ stock: 2500, reserved: 0, available: 2500 });
  });

  test.each(['preparing', 'ready'])('after "%s" the food is made, so the stock is NOT restored', async (stage) => {
    await setStatus(order._id, 'preparing');
    if (stage === 'ready') await setStatus(order._id, 'ready');
    const res = await cancel(order._id);
    expect(res.status).toBe(200);
    expect(await ctx.stockOf(dough)).toEqual({ stock: 2000, reserved: 0, available: 2000 });
  });

  test('a served or already cancelled order cannot be cancelled', async () => {
    await setStatus(order._id, 'preparing');
    await setStatus(order._id, 'ready');
    await setStatus(order._id, 'served');
    const served = await cancel(order._id);
    expect(served.status).toBe(409);
    expect(served.body.error.code).toBe('ORDER_NOT_CANCELLABLE');

    const other = (await takeaway(customer.token, [line(pizza)])).body;
    await cancel(other._id);
    expect((await cancel(other._id)).status).toBe(409);
  });

  test("other customers get 404, staff can cancel anyone's order", async () => {
    const stranger = await ctx.createUser();
    expect((await cancel(order._id, stranger.token)).status).toBe(404);
    expect((await cancel(order._id, staff.token)).status).toBe(200);
  });

  test('cancelling twice at the same moment releases the hold once, so other orders keep theirs', async () => {
    await takeaway(customer.token, [line(pizza, 1)]); // a second order holding 250 dough
    const results = await Promise.all([cancel(order._id), cancel(order._id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await ctx.stockOf(dough)).reserved).toBe(250); // only the other order's hold remains
  });

  test('cancel racing with "preparing": the hold is released or consumed, never both', async () => {
    for (let i = 0; i < 8; i += 1) {
      const fresh = (await takeaway(customer.token, [line(pizza, 1)])).body;
      const before = await ctx.stockOf(dough);
      const [prep, canc] = await Promise.all([setStatus(fresh._id, 'preparing'), cancel(fresh._id)]);
      const after = await ctx.stockOf(dough);
      expect(canc.status).toBe(200); // cancelling is allowed in both orders of events
      expect(after.reserved).toBe(before.reserved - 250); // this order's hold is gone either way
      expect(after.stock).toBe(prep.status === 200 ? before.stock - 250 : before.stock); // consumed only if preparing won
    }
  });
});

describe('editing an order before it is prepared (only the difference moves)', () => {
  let pizza;
  let dough;
  let cheese;
  let order;
  beforeEach(async () => {
    ({ pizza, dough, cheese } = await ctx.createPizza({ portions: 10, price: 100 }));
    order = (await takeaway(customer.token, [line(pizza, 1)])).body;
  });

  test('more portions: only the extra ingredients are taken', async () => {
    const res = await edit(order._id, [line(pizza, 3)]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 300, items: [{ quantity: 3 }] });
    expect(await ctx.stockOf(dough)).toMatchObject({ stock: 2500, reserved: 750 });
    expect(await ctx.stockOf(cheese)).toMatchObject({ reserved: 300 });
  });

  test('fewer portions: the surplus is released', async () => {
    await edit(order._id, [line(pizza, 4)]);
    const res = await edit(order._id, [line(pizza, 1)]);
    expect(res.body.total).toBe(100);
    expect((await ctx.stockOf(dough)).reserved).toBe(250);
  });

  test('swapping to another dish releases the old ingredients and takes the new ones', async () => {
    const rice = await ctx.createIngredient({ name: 'Rice', stock: 5000 });
    const bowl = await ctx.createMenuItem({ name: 'Rice bowl', price: 80, recipe: [[rice, 200]] });
    const res = await edit(order._id, [line(bowl, 2)]);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(160);
    expect((await ctx.stockOf(dough)).reserved).toBe(0);
    expect((await ctx.stockOf(cheese)).reserved).toBe(0);
    expect((await ctx.stockOf(rice)).reserved).toBe(400);
  });

  test('if the extra stock is missing the edit is rejected and the original order and hold stay exactly as they were', async () => {
    const res = await edit(order._id, [line(pizza, 11)]); // 10 portions of stock in total
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    const current = await ctx.api.get(`/api/orders/${order._id}`, customer.token);
    expect(current.body).toMatchObject({ total: 100, items: [{ quantity: 1 }] });
    expect(await ctx.stockOf(dough)).toMatchObject({ reserved: 250 });
    expect(await ctx.stockOf(cheese)).toMatchObject({ reserved: 100 });
  });

  test('only before preparation: afterwards it is a 409, even for staff', async () => {
    await setStatus(order._id, 'preparing');
    const res = await edit(order._id, [line(pizza, 2)]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_NOT_EDITABLE');
    expect((await edit(order._id, [line(pizza, 2)], staff.token)).status).toBe(409);
  });

  test("other customers get 404; staff can edit; validation applies", async () => {
    const stranger = await ctx.createUser();
    expect((await edit(order._id, [line(pizza, 2)], stranger.token)).status).toBe(404);
    expect((await edit(order._id, [line(pizza, 2)], staff.token)).status).toBe(200);
    expect((await edit(order._id, [])).status).toBe(400);
    expect((await edit(order._id, [{ menuItem: '507f1f77bcf86cd799439011', quantity: 1 }])).body.error.code).toBe('MENU_ITEM_NOT_FOUND');
  });

  test('existing lines keep their original price; a newly added line uses the current price', async () => {
    const other = await ctx.createMenuItem({ name: 'Salad', price: 40, recipe: [[await ctx.createIngredient({ stock: 5000 }), 100]] });
    await MenuItem.updateOne({ _id: pizza._id }, { price: 500 });
    const res = await edit(order._id, [line(pizza, 2), line(other, 1)]);
    const byName = Object.fromEntries(res.body.items.map((i) => [i.name, i.unitPrice]));
    expect(byName[pizza.name]).toBe(100); // price at the time of ordering
    expect(byName.Salad).toBe(40);
    expect(res.body.total).toBe(240);
  });

  test('a dish that became unavailable can be reduced, but not increased; a switched-off dish cannot be added', async () => {
    const { pizza: tight } = await ctx.createPizza({ portions: 2 });
    const mine = (await takeaway(customer.token, [line(tight, 2)])).body; // takes the last portions: now "unavailable"
    expect((await MenuItem.findById(tight._id)).isAvailable).toBe(false);
    expect((await edit(mine._id, [line(tight, 2)])).status).toBe(200); // unchanged is fine
    expect((await edit(mine._id, [line(tight, 1)])).status).toBe(200); // reducing is fine
    expect((await MenuItem.findById(tight._id)).isAvailable).toBe(true); // a portion was freed

    await MenuItem.updateOne({ _id: pizza._id }, { manuallyDisabled: true, isAvailable: false });
    const res = await edit(mine._id, [line(tight, 1), line(pizza, 1)]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MENU_ITEM_UNAVAILABLE');
  });

  test('two edits at the same moment never leave a wrong hold behind', async () => {
    for (let i = 0; i < 6; i += 1) {
      const fresh = (await takeaway(customer.token, [line(pizza, 1)])).body;
      const results = await Promise.all([edit(fresh._id, [line(pizza, 2)]), edit(fresh._id, [line(pizza, 3)])]);
      expect(results.every((r) => [200, 409].includes(r.status))).toBe(true);
      expect(results.some((r) => r.status === 200)).toBe(true);
      await cancel(fresh._id); // releases whatever the order finally holds
    }
    // Every order was cancelled, so if any edit had leaked or double-released a hold the counters would not be back
    // to exactly the one original order that is still open.
    expect(await ctx.stockOf(dough)).toMatchObject({ stock: 2500, reserved: 250 });
    expect(await ctx.stockOf(cheese)).toMatchObject({ stock: 1000, reserved: 100 });
  });

  test('an edit racing with "preparing": the deducted stock always matches the final items', async () => {
    for (let i = 0; i < 8; i += 1) {
      const fresh = (await takeaway(customer.token, [line(pizza, 1)])).body;
      const before = await ctx.stockOf(dough);
      const [edited, prepared] = await Promise.all([edit(fresh._id, [line(pizza, 3)]), setStatus(fresh._id, 'preparing')]);
      expect(prepared.status).toBe(200);
      const final = await ctx.api.get(`/api/orders/${fresh._id}`, staff.token);
      const portions = final.body.items[0].quantity;
      expect(portions).toBe(edited.status === 200 ? 3 : 1);
      const after = await ctx.stockOf(dough);
      expect(before.stock - after.stock).toBe(250 * portions); // consumed exactly what the order finally contains
      expect(before.reserved - after.reserved).toBe(250); // the order's hold is fully gone (the extra was only ever temporary)
    }
  });
});

describe('listing and reading', () => {
  test('customers see only their own orders, staff see all, filters and pagination work', async () => {
    const { pizza } = await ctx.createPizza({ portions: 20 });
    const other = await ctx.createUser();
    const a = (await takeaway(customer.token, [line(pizza)])).body;
    const b = (await takeaway(other.token, [line(pizza)], { pickupType: 'scheduled', pickupTime: '2026-11-12T19:00' })).body;
    await setStatus(a._id, 'preparing');

    const mine = await ctx.api.get('/api/orders', customer.token);
    expect(mine.body.items.map((o) => o._id)).toEqual([a._id]);
    const widened = await ctx.api.get(`/api/orders?customerId=${other.id}`, customer.token);
    expect(widened.body.items.map((o) => o._id)).toEqual([a._id]); // cannot see someone else's by asking

    const all = await ctx.api.get('/api/orders', staff.token);
    expect(all.body.total).toBe(2);
    expect((await ctx.api.get('/api/orders?status=preparing', staff.token)).body.items.map((o) => o._id)).toEqual([a._id]);
    expect((await ctx.api.get('/api/orders?date=2026-11-12', staff.token)).body.items.map((o) => o._id)).toEqual([b._id]);
    expect((await ctx.api.get(`/api/orders?customerId=${other.id}`, staff.token)).body.total).toBe(1);
    expect((await ctx.api.get('/api/orders?type=dine_in', staff.token)).body.total).toBe(0);
    const page = await ctx.api.get('/api/orders?limit=1&page=2', staff.token);
    expect(page.body).toMatchObject({ page: 2, limit: 1, total: 2, pages: 2 });
  });

  test("another customer's order looks missing; staff can read it; bad filters are 400", async () => {
    const { pizza } = await ctx.createPizza();
    const order = (await takeaway(customer.token, [line(pizza)])).body;
    const stranger = await ctx.createUser();
    expect((await ctx.api.get(`/api/orders/${order._id}`, stranger.token)).status).toBe(404);
    expect((await ctx.api.get(`/api/orders/${order._id}`, staff.token)).status).toBe(200);
    expect((await ctx.api.get('/api/orders/507f1f77bcf86cd799439011', staff.token)).status).toBe(404);
    expect((await ctx.api.get('/api/orders?status=lost', staff.token)).status).toBe(400);
    expect((await ctx.api.get('/api/orders?date=soon', staff.token)).status).toBe(400);
  });
});

describe('pre-orders with a reservation (scope 7.1)', () => {
  let table;
  beforeEach(async () => {
    table = await ctx.createTable({ number: 1, capacity: 4 });
  });
  const reserveWith = (token, items, o = {}) =>
    ctx.api.post('/api/reservations', token).send({ startTime: '2026-11-10T19:00', partySize: 2, preOrder: { items }, ...o });

  test('booking with a pre-order holds the table AND the ingredients, in one request', async () => {
    const { pizza, dough } = await ctx.createPizza();
    const res = await reserveWith(customer.token, [line(pizza, 2)]);
    expect(res.status).toBe(201);
    expect(res.body.reservation.status).toBe('confirmed');
    expect(res.body.preOrder).toMatchObject({ type: 'dine_in', status: 'placed', reservation: res.body.reservation._id, total: 200 });
    expect((await ctx.stockOf(dough)).reserved).toBe(500);
  });

  test('if the food is short there is no reservation either', async () => {
    const { pizza, dough } = await ctx.createPizza({ portions: 1 });
    const res = await reserveWith(customer.token, [line(pizza, 5)]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await require('../../src/models/Reservation').countDocuments()).toBe(0);
    expect((await ctx.stockOf(dough)).reserved).toBe(0);
    expect((await reserveWith(customer.token, [line(pizza, 1)])).status).toBe(201); // the table is still free
    expect(table).toBeDefined();
  });

  test('if no table is free no food is held', async () => {
    const { pizza, dough } = await ctx.createPizza();
    expect((await reserveWith(customer.token, [line(pizza)])).status).toBe(201);
    const second = await reserveWith(customer.token, [line(pizza)]); // the only table is taken
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('NO_TABLE_AVAILABLE');
    expect((await ctx.stockOf(dough)).reserved).toBe(250);
  });

  test('cancelling the reservation cancels the pre-order and releases its ingredients', async () => {
    const { pizza, dough } = await ctx.createPizza();
    const res = await reserveWith(customer.token, [line(pizza, 2)]);
    await ctx.api.patch(`/api/reservations/${res.body.reservation._id}/cancel`, customer.token);
    const order = await ctx.api.get(`/api/orders/${res.body.preOrder._id}`, customer.token);
    expect(order.body.status).toBe('cancelled');
    expect(await ctx.stockOf(dough)).toMatchObject({ stock: 2500, reserved: 0 });
  });

  test('staff can book with a pre-order on behalf of a customer', async () => {
    const { pizza } = await ctx.createPizza();
    const res = await reserveWith(staff.token, [line(pizza)], { customerId: customer.id });
    expect(res.status).toBe(201);
    expect(res.body.preOrder.customer._id).toBe(customer.id);
  });

  test('the guest can change the pre-order on arrival (edit before preparing)', async () => {
    const { pizza, dough } = await ctx.createPizza();
    const res = await reserveWith(customer.token, [line(pizza, 1)]);
    const edited = await edit(res.body.preOrder._id, [line(pizza, 3)]);
    expect(edited.status).toBe(200);
    expect((await ctx.stockOf(dough)).reserved).toBe(750);
  });
});

describe('many guests ordering at once (atomic stock)', () => {
  const people = (n) => Promise.all(Array.from({ length: n }, () => ctx.createUser()));

  test('12 simultaneous orders for 5 portions: exactly 5 succeed and stock never goes negative', async () => {
    const { pizza, dough, cheese } = await ctx.createPizza({ portions: 5 });
    const guests = await people(12);
    const results = await Promise.all(guests.map((g) => takeaway(g.token, [line(pizza, 1)])));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    expect(results.filter((r) => r.status === 409).every((r) => ['INSUFFICIENT_STOCK', 'MENU_ITEM_UNAVAILABLE'].includes(r.body.error.code))).toBe(true);
    expect(await ctx.stockOf(dough)).toEqual({ stock: 1250, reserved: 1250, available: 0 });
    expect(await ctx.stockOf(cheese)).toEqual({ stock: 500, reserved: 500, available: 0 });
    expect(await Order.countDocuments()).toBe(5);
  });

  test('orders of 2 portions competing for 5 portions: exactly 2 succeed (4 portions), the 5th stays free', async () => {
    const { pizza, dough } = await ctx.createPizza({ portions: 5 });
    const guests = await people(6);
    const results = await Promise.all(guests.map((g) => takeaway(g.token, [line(pizza, 2)])));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect((await ctx.stockOf(dough)).reserved).toBe(1000);
  });

  test('two different dishes sharing one ingredient cannot both take the last of it', async () => {
    const dough = await ctx.createIngredient({ stock: 250 });
    const a = await ctx.createMenuItem({ name: 'A', recipe: [[dough, 250]] });
    const b = await ctx.createMenuItem({ name: 'B', recipe: [[dough, 250]] });
    const [g1, g2, g3, g4] = await people(4);
    const results = await Promise.all([takeaway(g1.token, [line(a)]), takeaway(g2.token, [line(b)]), takeaway(g3.token, [line(a)]), takeaway(g4.token, [line(b)])]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await ctx.stockOf(dough)).toEqual({ stock: 250, reserved: 250, available: 0 });
  });

  test('orders needing the same ingredients in different recipe order cannot deadlock or over-hold', async () => {
    const x = await ctx.createIngredient({ name: 'X', stock: 300 });
    const y = await ctx.createIngredient({ name: 'Y', stock: 300 });
    const xy = await ctx.createMenuItem({ name: 'XY', recipe: [[x, 300], [y, 300]] });
    const yx = await ctx.createMenuItem({ name: 'YX', recipe: [[y, 300], [x, 300]] });
    const guests = await people(8);
    const results = await Promise.all(guests.map((g, i) => takeaway(g.token, [line(i % 2 ? xy : yx)])));
    const won = results.filter((r) => r.status === 201).length;
    expect(won).toBeLessThanOrEqual(1);
    expect((await ctx.stockOf(x)).reserved).toBe(300 * won); // whatever happened, holds match the orders that exist
    expect((await ctx.stockOf(y)).reserved).toBe(300 * won);
    expect(results.every((r) => [201, 409].includes(r.status))).toBe(true);
  });

  test('after any mix of orders, edits and cancels, reserved equals the sum of the open holds', async () => {
    const { pizza, dough } = await ctx.createPizza({ portions: 40 });
    const guests = await people(10);
    const created = (await Promise.all(guests.map((g) => takeaway(g.token, [line(pizza, 2)])))).map((r) => r.body);
    await Promise.all([
      ...created.slice(0, 3).map((o, i) => cancel(o._id, guests[i].token)),
      ...created.slice(3, 6).map((o, i) => edit(o._id, [line(pizza, 4)], guests[3 + i].token)),
      ...created.slice(6, 8).map((o) => setStatus(o._id, 'preparing')),
    ]);
    const orders = await Order.find();
    const heldPortions = orders.filter((o) => o.status === 'placed').reduce((sum, o) => sum + o.items[0].quantity, 0);
    expect((await ctx.stockOf(dough)).reserved).toBe(250 * heldPortions);
    const consumedPortions = orders.filter((o) => o.status === 'preparing').reduce((sum, o) => sum + o.items[0].quantity, 0);
    expect((await ctx.stockOf(dough)).stock).toBe(10000 - 250 * consumedPortions);
  });
});
