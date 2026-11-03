const jwt = require('jsonwebtoken');
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

const body = (o = {}) => ({ name: 'Mona Ali', phone: '01012345678', email: 'Mona@Example.com', password: 'Passw0rd!', ...o });

describe('POST /api/auth/register', () => {
  test('creates a customer, normalises phone and email, returns a token and never the password hash', async () => {
    const res = await ctx.api.post('/api/auth/register').send(body());
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ name: 'Mona Ali', phone: '+201012345678', email: 'mona@example.com', role: 'customer' });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
    const stored = await User.findById(res.body.user._id).select('+passwordHash');
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/);
  });

  test('a client cannot choose its own role', async () => {
    const res = await ctx.api.post('/api/auth/register').send(body({ role: 'admin' }));
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('customer');
  });

  test('email is optional, and several users may have none', async () => {
    const a = await ctx.api.post('/api/auth/register').send(body({ email: undefined, phone: '01011111111' }));
    const b = await ctx.api.post('/api/auth/register').send(body({ email: undefined, phone: '01022222222' }));
    expect([a.status, b.status]).toEqual([201, 201]);
  });

  test('the same phone in another format is a duplicate (409 PHONE_TAKEN)', async () => {
    await ctx.api.post('/api/auth/register').send(body());
    const res = await ctx.api.post('/api/auth/register').send(body({ phone: '+20 101 234 5678', email: 'other@example.com' }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PHONE_TAKEN');
  });

  test('the same email with different capitalisation is a duplicate (409 EMAIL_TAKEN)', async () => {
    await ctx.api.post('/api/auth/register').send(body());
    const res = await ctx.api.post('/api/auth/register').send(body({ phone: '01099999999', email: 'MONA@example.COM' }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  test.each([
    ['a missing name', { name: '' }],
    ['an invalid phone', { phone: 'abc' }],
    ['an invalid email', { email: 'not-an-email' }],
    ['a short password', { password: 'short' }],
    ['a password over 72 characters', { password: 'x'.repeat(73) }],
  ])('rejects %s with a field-level 400', async (_label, override) => {
    const res = await ctx.api.post('/api/auth/register').send(body(override));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  test('an empty body and malformed JSON both give clean 400s, never 500', async () => {
    expect((await ctx.api.post('/api/auth/register')).status).toBe(400);
    const bad = await ctx.api.post('/api/auth/register').set('Content-Type', 'application/json').send('{broken');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(() => ctx.api.post('/api/auth/register').send(body()));

  test.each([['national phone', '01012345678'], ['international phone', '+201012345678'], ['email', 'mona@example.com'], ['email, other case', 'MONA@Example.com']])(
    'works with %s',
    async (_label, identifier) => {
      const res = await ctx.api.post('/api/auth/login').send({ identifier, password: 'Passw0rd!' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ mustChangePassword: false, user: { role: 'customer' } });
      expect(res.body.token).toEqual(expect.any(String));
    }
  );

  test('also accepts the identifier under the key "phone" or "email"', async () => {
    expect((await ctx.api.post('/api/auth/login').send({ phone: '01012345678', password: 'Passw0rd!' })).status).toBe(200);
    expect((await ctx.api.post('/api/auth/login').send({ email: 'mona@example.com', password: 'Passw0rd!' })).status).toBe(200);
  });

  test('a wrong password and an unknown account give the same 401', async () => {
    const wrong = await ctx.api.post('/api/auth/login').send({ identifier: '01012345678', password: 'WrongPass1' });
    const unknown = await ctx.api.post('/api/auth/login').send({ identifier: '01055555555', password: 'Passw0rd!' });
    const garbage = await ctx.api.post('/api/auth/login').send({ identifier: '???', password: 'Passw0rd!' });
    for (const res of [wrong, unknown, garbage]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    }
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  test('missing credentials give 400', async () => {
    expect((await ctx.api.post('/api/auth/login').send({ password: 'x' })).status).toBe(400);
    expect((await ctx.api.post('/api/auth/login').send({ identifier: '0101' })).status).toBe(400);
  });
});

describe('token handling', () => {
  test('requests without a token, with a garbage token or with a wrong-secret token get 401', async () => {
    const user = await ctx.createUser();
    const forged = jwt.sign({ role: 'admin' }, 'some-other-secret-value-1234', { subject: user.id });
    expect((await ctx.api.get('/api/auth/me')).status).toBe(401);
    expect((await ctx.api.get('/api/auth/me', 'garbage')).status).toBe(401);
    expect((await ctx.api.get('/api/auth/me', forged)).status).toBe(401);
  });

  test('an expired token gets 401 INVALID_TOKEN', async () => {
    const user = await ctx.createUser();
    const expired = jwt.sign({ role: 'customer' }, process.env.JWT_SECRET, { subject: user.id, expiresIn: -10 });
    const res = await ctx.api.get('/api/auth/me', expired);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  test('a token whose account was deleted stops working', async () => {
    const user = await ctx.createUser();
    await User.deleteOne({ _id: user.id });
    expect((await ctx.api.get('/api/auth/me', user.token)).status).toBe(401);
  });

  test('the role is read from the database, so a role change applies to existing tokens at once', async () => {
    const admin = await ctx.createUser({ role: 'admin' });
    const user = await ctx.createUser();
    expect((await ctx.api.get('/api/inventory/alerts', user.token)).status).toBe(403);
    await ctx.api.patch(`/api/users/${user.id}/role`, admin.token).send({ role: 'staff' });
    expect((await ctx.api.get('/api/inventory/alerts', user.token)).status).toBe(200); // same token, new role
  });

  test('GET /api/auth/me returns the account without the hash', async () => {
    const user = await ctx.createUser({ name: 'Sara' });
    const res = await ctx.api.get('/api/auth/me', user.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ _id: user.id, name: 'Sara' });
    expect(res.body.passwordHash).toBeUndefined();
  });
});

describe('temporary passwords and changing the password', () => {
  test('while mustChangePassword is true only change-password and me are reachable', async () => {
    const guest = await ctx.createUser({ mustChangePassword: true });
    const blocked = await ctx.api.get('/api/orders', guest.token);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await ctx.api.get('/api/auth/me', guest.token)).status).toBe(200);
    expect((await ctx.api.get('/api/menu', guest.token)).status).toBe(200); // optional-auth route stays open
  });

  test('changing the password clears the flag, returns a working token and revokes older tokens', async () => {
    const guest = await ctx.createUser({ mustChangePassword: true, password: 'TempPass123' });
    const oldToken = jwt.sign({ role: 'customer' }, process.env.JWT_SECRET, {
      subject: guest.id,
      noTimestamp: true,
      // issued a minute ago, i.e. before the password change below
    });
    const oldDated = jwt.sign({ role: 'customer', iat: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET, { subject: guest.id });
    expect(oldToken).toBeDefined();

    const res = await ctx.api.post('/api/auth/change-password', guest.token).send({ currentPassword: 'TempPass123', newPassword: 'BrandNewPass9' });
    expect(res.status).toBe(200);
    expect(res.body.user.mustChangePassword).toBe(false);

    expect((await ctx.api.get('/api/orders', res.body.token)).status).toBe(200); // the new token is fully usable
    const revoked = await ctx.api.get('/api/auth/me', oldDated);
    expect(revoked.status).toBe(401);
    expect(revoked.body.error.code).toBe('TOKEN_REVOKED');

    const login = await ctx.api.post('/api/auth/login').send({ identifier: guest.phone, password: 'BrandNewPass9' });
    expect(login.status).toBe(200);
    expect((await ctx.api.post('/api/auth/login').send({ identifier: guest.phone, password: 'TempPass123' })).status).toBe(401);
  });

  test('wrong current password -> 401; same password -> 400; weak new password -> 400', async () => {
    const user = await ctx.createUser({ password: 'OldPass123' });
    const change = (payload) => ctx.api.post('/api/auth/change-password', user.token).send(payload);
    expect((await change({ currentPassword: 'nope-nope', newPassword: 'BrandNewPass9' })).status).toBe(401);
    const same = await change({ currentPassword: 'OldPass123', newPassword: 'OldPass123' });
    expect(same.status).toBe(400);
    expect(same.body.error.code).toBe('PASSWORD_UNCHANGED');
    expect((await change({ currentPassword: 'OldPass123', newPassword: 'short' })).status).toBe(400);
  });
});
