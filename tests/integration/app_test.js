const express = require('express');
const request = require('supertest');
const db = require('../helpers/db');
const { createContext } = require('../helpers/context');

beforeAll(db.connect);
afterAll(db.disconnect);

let ctx;
let admin;
beforeEach(async () => {
  await db.clear();
  ctx = createContext();
  admin = await ctx.createUser({ role: 'admin' });
});

describe('HTTP hardening and error format', () => {
  test('security headers are set and the framework is not advertised', async () => {
    const res = await ctx.api.get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  test('health reports the database state', async () => {
    const res = await ctx.api.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', database: 'connected' });
  });

  test('CORS is closed by default: no origin is allowed unless CORS_ORIGIN lists it', async () => {
    const res = await request(ctx.app).get('/api/menu').set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('unknown routes and wrong methods get the standard JSON error, not an HTML page', async () => {
    for (const [method, url] of [['get', '/api/nope'], ['delete', '/api/menu'], ['get', '/'], ['post', '/api/auth/unknown']]) {
      const res = await ctx.api[method](url, admin.token);
      expect([url, res.status, res.body.error.code]).toEqual([url, 404, 'ROUTE_NOT_FOUND']);
    }
  });

  test('every error has the same shape: { error: { code, message } }', async () => {
    const responses = [
      await ctx.api.get('/api/orders'), // 401
      await ctx.api.get('/api/tables', (await ctx.createUser()).token), // 403
      await ctx.api.get('/api/orders/507f1f77bcf86cd799439011', admin.token), // 404
      await ctx.api.post('/api/auth/login').send({}), // 400
    ];
    for (const res of responses) {
      expect(Object.keys(res.body)).toEqual(['error']);
      expect(res.body.error.code).toEqual(expect.any(String));
      expect(res.body.error.message).toEqual(expect.any(String));
    }
  });

  test('broken JSON is a 400 and an oversized body is a 413', async () => {
    const broken = await request(ctx.app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"identifier": ');
    expect([broken.status, broken.body.error.code]).toEqual([400, 'INVALID_JSON']);
    const huge = await request(ctx.app).post('/api/auth/login').send({ identifier: 'x', password: 'y'.repeat(200 * 1024) });
    expect([huge.status, huge.body.error.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
  });

  test('a malformed :id is a 400 on every route that takes one', async () => {
    const routes = ctx.app.locals.routeRegistry.routes.filter((r) => r.path.includes(':id'));
    expect(routes.length).toBeGreaterThan(15);
    for (const route of routes) {
      const url = (route.basePath + route.path).replace(':id', 'not-an-id');
      const res = await ctx.api[route.method](url, admin.token);
      expect([`${route.method} ${url}`, res.status, res.body.error.code]).toEqual([`${route.method} ${url}`, 400, 'VALIDATION_ERROR']);
    }
  });

  test('query-string operator injection is neutralised: ?status[$ne]=x is never turned into a MongoDB operator', async () => {
    const { pizza } = await ctx.createPizza();
    const customer = await ctx.createUser();
    const order = (await ctx.api.post('/api/orders', customer.token).send({ type: 'takeaway', pickupType: 'asap', items: [{ menuItem: String(pizza._id), quantity: 1 }] })).body;
    await ctx.api.post('/api/orders', customer.token).send({ type: 'takeaway', pickupType: 'asap', items: [{ menuItem: String(pizza._id), quantity: 1 }] });
    await ctx.api.patch(`/api/orders/${order._id}/cancel`, customer.token);

    // If "$ne" were interpreted, this would hide the cancelled order. Instead the odd key is ignored and nothing is filtered.
    const res = await ctx.api.get('/api/orders?status[$ne]=cancelled', admin.token);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  test('NoSQL operators in a body are rejected by validation, never reaching the database', async () => {
    const res = await ctx.api.post('/api/auth/login').send({ identifier: { $gt: '' }, password: { $gt: '' } });
    expect(res.status).toBe(400);
  });
});

describe('API documentation (generated from the real routes)', () => {
  let doc;
  beforeEach(async () => {
    doc = (await ctx.api.get('/api-docs.json')).body;
  });

  test('is an OpenAPI 3.1 document and the Swagger UI page is served', async () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toMatch(/Restaurant/);
    const page = await ctx.api.get('/api-docs/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/html/);
  });

  test('documents every route the server declares, with the right method and {id} placeholders', () => {
    for (const route of ctx.app.locals.routeRegistry.routes) {
      const path = (route.basePath + (route.path === '/' ? '' : route.path)).replace(/:(\w+)/g, '{$1}');
      expect([path, route.method, Boolean(doc.paths[path] && doc.paths[path][route.method])]).toEqual([path, route.method, true]);
    }
    expect(doc.paths['/health']).toBeDefined();
  });

  test('request bodies and parameters come from the validation schemas', () => {
    const booking = doc.paths['/api/reservations'].post.requestBody.content['application/json'].schema;
    expect(Object.keys(booking.properties)).toEqual(expect.arrayContaining(['startTime', 'partySize', 'zone', 'tableId', 'preOrder']));
    expect(booking.required).toEqual(expect.arrayContaining(['startTime', 'partySize']));
    const availability = doc.paths['/api/reservations/availability'].get.parameters;
    expect(availability.map((p) => [p.name, p.in, p.required])).toEqual(expect.arrayContaining([['start', 'query', true], ['partySize', 'query', true], ['zone', 'query', false]]));
    const idParam = doc.paths['/api/orders/{id}'].get.parameters.find((p) => p.name === 'id');
    expect(idParam).toMatchObject({ in: 'path', required: true });
  });

  test('security and access are described per route', () => {
    expect(doc.paths['/api/auth/login'].post.security).toEqual([]);
    expect(doc.paths['/api/orders'].post.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.paths['/api/reports/daily-sales'].get.description).toMatch(/admin/);
    expect(doc.paths['/api/reports/daily-sales'].get.responses[403]).toBeDefined();
    expect(doc.paths['/api/auth/login'].post.responses[401]).toBeUndefined();
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
  });

  test('success statuses match what the endpoints return', () => {
    expect(doc.paths['/api/orders'].post.responses[201]).toBeDefined();
    expect(doc.paths['/api/tables/{id}'].delete.responses[204]).toBeDefined();
    expect(doc.paths['/api/orders'].get.responses[200]).toBeDefined();
  });
});

describe('rate limiting (disabled in tests, so checked on its own)', () => {
  let authLimiter;
  beforeAll(() => {
    // Load a copy of the limiter module as if running in production, where it is switched on.
    jest.isolateModules(() => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      ({ authLimiter } = require('../../src/middleware/rate_limiters'));
      process.env.NODE_ENV = previous;
    });
  });

  function loginApp() {
    const app = express();
    app.use(express.json());
    app.post('/login', authLimiter, (req, res) => (req.body.password === 'right' ? res.json({ ok: true }) : res.status(401).json({})));
    return app;
  }
  const attempt = (app, identifier, password = 'wrong') => request(app).post('/login').send({ identifier, password });

  test('the 11th failed attempt for one account in a row is blocked with 429', async () => {
    const app = loginApp();
    for (let i = 0; i < 10; i += 1) expect((await attempt(app, 'victim@example.com')).status).toBe(401);
    const blocked = await attempt(app, 'victim@example.com');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(blocked.headers['ratelimit-policy']).toBeDefined();
  });

  test('another account is not affected by that lockout', async () => {
    const app = loginApp();
    for (let i = 0; i < 11; i += 1) await attempt(app, 'victim@example.com');
    expect((await attempt(app, 'someone-else@example.com')).status).toBe(401);
  });

  test('successful logins are not counted, so a real user is never locked out by their own logins', async () => {
    const app = loginApp();
    for (let i = 0; i < 15; i += 1) expect((await attempt(app, 'happy@example.com', 'right')).status).toBe(200);
  });
});
