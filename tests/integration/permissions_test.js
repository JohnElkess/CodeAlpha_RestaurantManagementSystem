const db = require('../helpers/db');
const { createContext } = require('../helpers/context');

beforeAll(db.connect);
afterAll(db.disconnect);

/**
 * The role table of the scope (section 3), checked against EVERY route the server declares. The list of routes
 * comes from the live route registry, so a new endpoint without a correct access rule shows up here at once.
 */
const FAKE_ID = '507f1f77bcf86cd799439011';
const ROLES = ['customer', 'staff', 'admin'];

let ctx;
let tokens;
let routes;

beforeAll(async () => {
  await db.clear();
  ctx = createContext();
  tokens = {};
  for (const role of ROLES) tokens[role] = (await ctx.createUser({ role })).token;
  routes = ctx.app.locals.routeRegistry.routes;
});

const call = (route, token) => {
  const url = (route.basePath + (route.path === '/' ? '' : route.path)).replace(/:\w+/g, FAKE_ID);
  return ctx.api[route.method](url, token);
};
const label = (r) => `${r.method.toUpperCase()} ${r.basePath}${r.path === '/' ? '' : r.path}`;

test('the registry is not empty', () => {
  expect(routes.length).toBeGreaterThan(30);
});

test('every protected route refuses anonymous callers with 401', async () => {
  for (const route of routes.filter((r) => r.access !== 'public' && r.access !== 'optional')) {
    const res = await call(route);
    expect([label(route), res.status]).toEqual([label(route), 401]);
  }
});

test('every role-restricted route refuses the wrong roles with 403 and lets the right roles past the guard', async () => {
  for (const route of routes.filter((r) => Array.isArray(r.access))) {
    for (const role of ROLES) {
      const res = await call(route, tokens[role]);
      if (route.access.includes(role)) expect([label(route), role, res.status === 401 || res.status === 403]).toEqual([label(route), role, false]);
      else expect([label(route), role, res.status]).toEqual([label(route), role, 403]);
    }
  }
});

test('open routes are reachable without a token, and signed-in routes by every role', async () => {
  for (const route of routes.filter((r) => r.access === 'public' || r.access === 'optional')) {
    const res = await call(route);
    expect([label(route), res.status === 401 || res.status === 403]).toEqual([label(route), false]);
  }
  for (const route of routes.filter((r) => r.access === 'authenticated' && !r.allowPasswordChange)) {
    for (const role of ROLES) {
      const res = await call(route, tokens[role]);
      expect([label(route), role, res.status === 401 || res.status === 403]).toEqual([label(route), role, false]);
    }
  }
});

test('the scope role table, spot-checked by name', () => {
  const rule = (method, path) => routes.find((r) => r.method === method && r.basePath + (r.path === '/' ? '' : r.path) === path).access;
  expect(rule('post', '/api/users/guest')).toEqual(['staff', 'admin']);
  expect(rule('patch', '/api/users/:id/role')).toEqual(['admin']);
  expect(rule('post', '/api/menu')).toEqual(['admin']);
  expect(rule('get', '/api/menu')).toBe('optional');
  expect(rule('post', '/api/reservations/walk-in')).toEqual(['staff', 'admin']);
  expect(rule('patch', '/api/orders/:id/status')).toEqual(['staff', 'admin']);
  expect(rule('get', '/api/inventory/alerts')).toEqual(['staff', 'admin']);
  expect(rule('get', '/api/reports/daily-sales')).toEqual(['admin']);
  expect(rule('post', '/api/auth/login')).toBe('public');
});
