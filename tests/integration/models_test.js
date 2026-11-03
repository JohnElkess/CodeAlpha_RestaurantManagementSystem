const mongoose = require('mongoose');
const db = require('../helpers/db');
const { createContext } = require('../helpers/context');
const Order = require('../../src/models/Order');
const User = require('../../src/models/User');
const Ingredient = require('../../src/models/Ingredient');
const Reservation = require('../../src/models/Reservation');

beforeAll(db.connect);
afterAll(db.disconnect);

let ctx;
beforeEach(async () => {
  await db.clear();
  ctx = createContext();
});

const item = { menuItem: new mongoose.Types.ObjectId(), name: 'X', quantity: 1, unitPrice: 10 };
const orderBase = () => ({ customer: new mongoose.Types.ObjectId(), items: [item], total: 10, scheduledFor: new Date() });

describe('the database layer protects its own rules', () => {
  test('a dine-in order must reference a reservation', async () => {
    await expect(Order.create({ ...orderBase(), type: 'dine_in' })).rejects.toThrow(/needs a reservation/);
    await expect(Order.create({ ...orderBase(), type: 'dine_in', reservation: new mongoose.Types.ObjectId() })).resolves.toBeDefined();
  });

  test('a takeaway order must have a pickup type and time', async () => {
    await expect(Order.create({ ...orderBase(), type: 'takeaway' })).rejects.toThrow(/pickupType/);
    await expect(Order.create({ ...orderBase(), type: 'takeaway', pickupType: 'asap' })).rejects.toThrow(/pickupTime/);
    await expect(Order.create({ ...orderBase(), type: 'takeaway', pickupType: 'asap', pickupTime: new Date() })).resolves.toBeDefined();
  });

  test('an order needs items and a known status', async () => {
    await expect(Order.create({ ...orderBase(), type: 'takeaway', pickupType: 'asap', pickupTime: new Date(), items: [] })).rejects.toThrow(/at least one item/);
    await expect(Order.create({ ...orderBase(), type: 'takeaway', pickupType: 'asap', pickupTime: new Date(), status: 'lost' })).rejects.toThrow();
  });

  test('ingredient quantities must be whole, non-negative numbers', async () => {
    await expect(Ingredient.create({ name: 'A', unit: 'g', stock: 1.5 })).rejects.toThrow(/whole number/);
    await expect(Ingredient.create({ name: 'B', unit: 'g', stock: -1 })).rejects.toThrow();
    await expect(Ingredient.create({ name: 'C', unit: 'cups' })).rejects.toThrow();
  });

  test('phone is unique and email is unique only when present (indexes exist and work)', async () => {
    const base = { name: 'N', passwordHash: 'x', role: 'customer' };
    await User.create({ ...base, phone: '+201000000001' });
    await User.create({ ...base, phone: '+201000000002' }); // no email, twice: fine
    await User.create({ ...base, phone: '+201000000003', email: 'a@x.com' });
    await expect(User.create({ ...base, phone: '+201000000001' })).rejects.toMatchObject({ code: 11000 });
    await expect(User.create({ ...base, phone: '+201000000004', email: 'A@X.com' })).rejects.toMatchObject({ code: 11000 });
  });

  test('JSON output never contains password hashes or internal guard fields', async () => {
    const user = await User.create({ name: 'N', phone: '+201000000009', passwordHash: 'secret-hash', role: 'customer' });
    expect(JSON.stringify(user)).not.toMatch(/secret-hash|passwordHash/);
    const table = await ctx.createTable({ number: 1 });
    const result = await ctx.container.repos.reservationRepo.insertHolding({
      customer: user._id, table: table._id, partySize: 2, source: 'phone',
      startTime: ctx.local('2026-11-10T19:00'), endTime: ctx.local('2026-11-10T21:00'),
    });
    expect(JSON.stringify(result.reservation)).not.toMatch(/occupancy|holdsTable/);
  });

  test('the double-booking guard only covers reservations that hold a table', async () => {
    const table = await ctx.createTable({ number: 1 });
    const repo = ctx.container.repos.reservationRepo;
    const data = { customer: new mongoose.Types.ObjectId(), table: table._id, partySize: 2, source: 'phone', startTime: ctx.local('2026-11-10T19:00'), endTime: ctx.local('2026-11-10T21:00') };
    const first = await repo.insertHolding(data);
    await repo.transition(first.reservation._id, ['confirmed'], 'cancelled');
    expect((await Reservation.findById(first.reservation._id)).holdsTable).toBe(false);
    expect((await repo.insertHolding(data)).ok).toBe(true); // the cancelled one no longer blocks
    expect((await repo.insertHolding(data)).ok).toBe(false); // but the new one does
  });
});
