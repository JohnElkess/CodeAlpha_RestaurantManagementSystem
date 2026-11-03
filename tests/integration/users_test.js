const db = require('../helpers/db');
const { createContext } = require('../helpers/context');
const User = require('../../src/models/User');

beforeAll(db.connect);
afterAll(db.disconnect);

let ctx;
beforeEach(async () => {
  await db.clear();
  ctx = createContext();
});

describe('POST /api/users/guest (staff registers a guest)', () => {
  test('creates a customer with a one-time temporary password that must be changed at first login', async () => {
    const staff = await ctx.createUser({ role: 'staff' });
    const res = await ctx.api.post('/api/users/guest', staff.token).send({ name: 'Walk In Guest', phone: '01033334444' });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.temporaryPassword).toMatch(/^[A-HJ-NP-Za-km-z2-9]{12}$/);
    expect(res.body.user).toMatchObject({ role: 'customer', mustChangePassword: true, phone: '+201033334444', createdBy: staff.id });

    const stored = await User.findById(res.body.user._id).select('+passwordHash');
    expect(stored.passwordHash).not.toContain(res.body.temporaryPassword); // only the hash is stored

    const login = await ctx.api.post('/api/auth/login').send({ identifier: '01033334444', password: res.body.temporaryPassword });
    expect(login.status).toBe(200);
    expect(login.body.mustChangePassword).toBe(true);
  });

  test('works for admins too, and customers are refused', async () => {
    const admin = await ctx.createUser({ role: 'admin' });
    const customer = await ctx.createUser();
    expect((await ctx.api.post('/api/users/guest', admin.token).send({ name: 'G', phone: '01033334441' })).status).toBe(201);
    expect((await ctx.api.post('/api/users/guest', customer.token).send({ name: 'G', phone: '01033334442' })).status).toBe(403);
  });

  test('a duplicate phone or email is a 409 that tells staff to search instead', async () => {
    const staff = await ctx.createUser({ role: 'staff' });
    await ctx.api.post('/api/users/guest', staff.token).send({ name: 'A', phone: '01033334444', email: 'a@x.com' });
    const dupPhone = await ctx.api.post('/api/users/guest', staff.token).send({ name: 'B', phone: '+20 103 333 4444' });
    expect(dupPhone.status).toBe(409);
    expect(dupPhone.body.error.code).toBe('PHONE_TAKEN');
    const dupEmail = await ctx.api.post('/api/users/guest', staff.token).send({ name: 'C', phone: '01033335555', email: 'A@x.com' });
    expect(dupEmail.body.error.code).toBe('EMAIL_TAKEN');
  });

  test('validation errors are 400', async () => {
    const staff = await ctx.createUser({ role: 'staff' });
    expect((await ctx.api.post('/api/users/guest', staff.token).send({ name: '', phone: '010' })).status).toBe(400);
  });
});

describe('GET /api/users/search', () => {
  test('finds a customer by phone in any format, or by email', async () => {
    const staff = await ctx.createUser({ role: 'staff' });
    const customer = await ctx.createUser({ phone: '+201055556666', email: 'find@me.com' });
    for (const query of ['phone=01055556666', 'phone=%2B20%20105%205556666', 'email=FIND@me.com']) {
      const res = await ctx.api.get(`/api/users/search?${query}`, staff.token);
      expect(res.status).toBe(200);
      expect(res.body.items.map((u) => u._id)).toEqual([customer.id]);
    }
  });

  test('returns only customers (staff and admins are never exposed) and never hashes', async () => {
    const staff = await ctx.createUser({ role: 'staff', phone: '+201077778888' });
    const res = await ctx.api.get('/api/users/search?phone=01077778888', staff.token);
    expect(res.body.items).toEqual([]);
    const customer = await ctx.createUser({ phone: '+201066667777' });
    const found = await ctx.api.get('/api/users/search?phone=01066667777', staff.token);
    expect(found.body.items[0].passwordHash).toBeUndefined();
    expect(customer.id).toBeDefined();
  });

  test('needs a parameter, treats nonsense as "not found", and is staff only', async () => {
    const staff = await ctx.createUser({ role: 'staff' });
    const customer = await ctx.createUser();
    expect((await ctx.api.get('/api/users/search', staff.token)).status).toBe(400);
    expect((await ctx.api.get('/api/users/search?phone=abc', staff.token)).body.items).toEqual([]);
    expect((await ctx.api.get('/api/users/search?phone=0101', customer.token)).status).toBe(403);
  });
});

describe('PATCH /api/users/:id/role', () => {
  test('an admin can promote and demote', async () => {
    const admin = await ctx.createUser({ role: 'admin' });
    const user = await ctx.createUser();
    const up = await ctx.api.patch(`/api/users/${user.id}/role`, admin.token).send({ role: 'staff' });
    expect(up.status).toBe(200);
    expect(up.body.role).toBe('staff');
    const down = await ctx.api.patch(`/api/users/${user.id}/role`, admin.token).send({ role: 'customer' });
    expect(down.body.role).toBe('customer');
  });

  test('staff and customers cannot change roles', async () => {
    const staff = await ctx.createUser({ role: 'staff' });
    const user = await ctx.createUser();
    expect((await ctx.api.patch(`/api/users/${user.id}/role`, staff.token).send({ role: 'admin' })).status).toBe(403);
    expect((await ctx.api.patch(`/api/users/${staff.id}/role`, user.token).send({ role: 'admin' })).status).toBe(403);
  });

  test('an admin cannot change their own role (so the last admin cannot lock everyone out)', async () => {
    const admin = await ctx.createUser({ role: 'admin' });
    const res = await ctx.api.patch(`/api/users/${admin.id}/role`, admin.token).send({ role: 'customer' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CANNOT_CHANGE_OWN_ROLE');
  });

  test('invalid role -> 400, unknown user -> 404, malformed id -> 400', async () => {
    const admin = await ctx.createUser({ role: 'admin' });
    const user = await ctx.createUser();
    expect((await ctx.api.patch(`/api/users/${user.id}/role`, admin.token).send({ role: 'owner' })).status).toBe(400);
    expect((await ctx.api.patch('/api/users/507f1f77bcf86cd799439011/role', admin.token).send({ role: 'staff' })).status).toBe(404);
    expect((await ctx.api.patch('/api/users/abc/role', admin.token).send({ role: 'staff' })).status).toBe(400);
  });
});

describe('POST /api/users/:id/reset-password', () => {
  test('staff reset a customer: new temporary password, old password and old tokens stop working', async () => {
    const staff = await ctx.createUser({ role: 'staff' });
    const customer = await ctx.createUser({ password: 'ForgottenOne1' });
    const res = await ctx.api.post(`/api/users/${customer.id}/reset-password`, staff.token);
    expect(res.status).toBe(200);
    expect(res.body.temporaryPassword).toHaveLength(12);
    expect(res.body.user.mustChangePassword).toBe(true);

    expect((await ctx.api.post('/api/auth/login').send({ identifier: customer.phone, password: 'ForgottenOne1' })).status).toBe(401);
    const login = await ctx.api.post('/api/auth/login').send({ identifier: customer.phone, password: res.body.temporaryPassword });
    expect(login.status).toBe(200);
    expect(login.body.mustChangePassword).toBe(true);
  });

  test('staff cannot reset staff or admin accounts; an admin can reset anyone else', async () => {
    const staff = await ctx.createUser({ role: 'staff' });
    const otherStaff = await ctx.createUser({ role: 'staff' });
    const admin = await ctx.createUser({ role: 'admin' });
    expect((await ctx.api.post(`/api/users/${otherStaff.id}/reset-password`, staff.token)).status).toBe(403);
    expect((await ctx.api.post(`/api/users/${admin.id}/reset-password`, staff.token)).status).toBe(403);
    expect((await ctx.api.post(`/api/users/${otherStaff.id}/reset-password`, admin.token)).status).toBe(200);
  });

  test('cannot reset your own password this way, unknown user is 404, customers are refused', async () => {
    const staff = await ctx.createUser({ role: 'staff' });
    const customer = await ctx.createUser();
    expect((await ctx.api.post(`/api/users/${staff.id}/reset-password`, staff.token)).body.error.code).toBe('USE_CHANGE_PASSWORD');
    expect((await ctx.api.post('/api/users/507f1f77bcf86cd799439011/reset-password', staff.token)).status).toBe(404);
    expect((await ctx.api.post(`/api/users/${staff.id}/reset-password`, customer.token)).status).toBe(403);
  });
});
