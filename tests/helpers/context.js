'use strict';
const request = require('supertest');
const { buildContainer } = require('../../src/container');
const { createApp } = require('../../src/app');
const { FixedClock } = require('../../src/utils/clock');
const { parseInstant } = require('../../src/utils/time');
const business = require('../../src/config/business');
const User = require('../../src/models/User');
const Ingredient = require('../../src/models/Ingredient');
const MenuItem = require('../../src/models/MenuItem');
const Table = require('../../src/models/Table');
const { hashPassword } = require('../../src/utils/password');

const silentLogger = { error() {}, warn() {}, info() {}, debug() {} };

/** Local (Cairo) wall-clock time -> Date. Tests write "2026-11-10T19:00" and never think about offsets. */
const local = (text) => parseInstant(text, business.timezone);

/** Default "now" of every test: Tuesday 2026-11-10, 17:00 Cairo (open, before any 22:00 cutoff). */
const DEFAULT_NOW = '2026-11-10T17:00';

let counter = 0;

/** Fresh container, app and fake clock. Create one per test so tests never share state. */
function createContext(now = DEFAULT_NOW) {
  const clock = new FixedClock(local(now));
  const container = buildContainer({ clock, logger: silentLogger });
  const app = createApp(container);
  const { authService } = container.services;

  const ctx = {
    app,
    clock,
    container,
    services: container.services,
    jobs: container.jobs,
    local,

    setNow(text) {
      clock.set(local(text));
    },

    /** Create an account directly in the database (fast) and return a ready-to-use token. */
    async createUser({ role = 'customer', name, phone, email, password = 'Passw0rd!', mustChangePassword = false } = {}) {
      counter += 1;
      const user = await User.create({
        name: name || `${role} ${counter}`,
        phone: phone || `+2010${String(10000000 + counter).slice(-8)}`,
        email,
        passwordHash: await hashPassword(password),
        role,
        mustChangePassword,
      });
      return { id: String(user._id), token: authService.signToken(user), phone: user.phone, email: user.email, password, role, name: user.name };
    },

    async createIngredient({ name, unit = 'g', stock = 1000, lowStockThreshold = 0 } = {}) {
      counter += 1;
      return Ingredient.create({ name: name || `Ingredient ${counter}`, unit, stock, lowStockThreshold });
    },

    /** recipe: [[ingredientDoc, quantityPerPortion], ...] */
    async createMenuItem({ name, price = 100, category = 'Mains', recipe }) {
      counter += 1;
      const item = await MenuItem.create({
        name: name || `Dish ${counter}`,
        price,
        category,
        recipe: recipe.map(([ingredient, quantityPerPortion]) => ({ ingredient: ingredient._id, quantityPerPortion })),
      });
      await container.services.menuAvailability.refresh();
      return MenuItem.findById(item._id);
    },

    createTable({ number, capacity = 4, zone = 'normal', isActive = true } = {}) {
      counter += 1;
      return Table.create({ number: number ?? counter + 1000, capacity, zone, isActive });
    },

    /** A pizza that needs 250 g dough and 100 g cheese per portion, with stock for `portions` portions. */
    async createPizza({ portions = 10, price = 100 } = {}) {
      const dough = await ctx.createIngredient({ name: `Dough ${++counter}`, stock: 250 * portions });
      const cheese = await ctx.createIngredient({ name: `Cheese ${counter}`, stock: 100 * portions });
      const pizza = await ctx.createMenuItem({ name: `Pizza ${counter}`, price, recipe: [[dough, 250], [cheese, 100]] });
      return { pizza, dough, cheese };
    },

    async stockOf(ingredient) {
      const fresh = await Ingredient.findById(ingredient._id);
      return { stock: fresh.stock, reserved: fresh.reserved, available: fresh.stock - fresh.reserved };
    },

    api: {
      get: (url, token) => withAuth(request(app).get(url), token),
      post: (url, token) => withAuth(request(app).post(url), token),
      put: (url, token) => withAuth(request(app).put(url), token),
      patch: (url, token) => withAuth(request(app).patch(url), token),
      delete: (url, token) => withAuth(request(app).delete(url), token),
    },
  };
  return ctx;
}

const withAuth = (req, token) => (token ? req.set('Authorization', `Bearer ${token}`) : req);

module.exports = { createContext, local, DEFAULT_NOW, silentLogger };
