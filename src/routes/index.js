'use strict';
const s = require('../validation/schemas');
const { ROLES } = require('../domain/constants');
const { authLimiter } = require('../middleware/rate_limiters');

const STAFF = [ROLES.STAFF, ROLES.ADMIN];
const ADMIN = [ROLES.ADMIN];

/**
 * Every endpoint of the API, in one readable file (scope section 6). `summary` strings feed the API docs.
 * Order matters inside a router: fixed paths such as /walk-in must come before /:id.
 */
function createRouters({ build, controllers: c }) {
  const auth = build('/api/auth', 'Auth', (route) => {
    route({ method: 'post', path: '/register', access: 'public', middleware: [authLimiter], body: s.register, status: 201, summary: 'Customer self-registration', handler: c.auth.register });
    route({ method: 'post', path: '/login', access: 'public', middleware: [authLimiter], body: s.login, summary: 'Log in with phone or email', handler: c.auth.login });
    route({ method: 'post', path: '/change-password', allowPasswordChange: true, body: s.changePassword, summary: 'Change password (required while mustChangePassword is true)', handler: c.auth.changePassword });
    route({ method: 'get', path: '/me', allowPasswordChange: true, summary: 'The signed-in account', handler: c.auth.me });
  });

  const users = build('/api/users', 'Users', (route) => {
    route({ method: 'post', path: '/guest', access: STAFF, body: s.guest, status: 201, summary: 'Register a walk-in or phone-in guest; the temporary password is returned once', handler: c.users.createGuest });
    route({ method: 'get', path: '/search', access: STAFF, query: s.userSearch, summary: 'Find customers by phone or email', handler: c.users.search });
    route({ method: 'patch', path: '/:id/role', access: ADMIN, params: s.idParams, body: s.roleChange, summary: "Change a user's role", handler: c.users.setRole });
    route({ method: 'post', path: '/:id/reset-password', access: STAFF, params: s.idParams, summary: 'Issue a new temporary password (staff: customers only)', handler: c.users.resetPassword });
  });

  const menu = build('/api/menu', 'Menu', (route) => {
    route({ method: 'get', path: '/', access: 'optional', summary: 'List menu items with availability (admins also see recipes)', handler: c.menu.list });
    route({ method: 'get', path: '/:id', access: 'optional', params: s.idParams, summary: 'One menu item', handler: c.menu.get });
    route({ method: 'post', path: '/', access: ADMIN, body: s.menuItem, status: 201, summary: 'Create a menu item with its recipe', handler: c.menu.create });
    route({ method: 'put', path: '/:id', access: ADMIN, params: s.idParams, body: s.menuItem, summary: 'Update a menu item or its recipe', handler: c.menu.update });
    route({ method: 'patch', path: '/:id/availability', access: ADMIN, params: s.idParams, body: s.menuAvailability, summary: 'Manual availability toggle', handler: c.menu.setAvailability });
  });

  const tables = build('/api/tables', 'Tables', (route) => {
    route({ method: 'get', path: '/', access: STAFF, query: s.tableListQuery, summary: 'List tables', handler: c.tables.list });
    route({ method: 'post', path: '/', access: ADMIN, body: s.table, status: 201, summary: 'Create a table', handler: c.tables.create });
    route({ method: 'put', path: '/:id', access: ADMIN, params: s.idParams, body: s.tableUpdate, summary: 'Update a table', handler: c.tables.update });
    route({ method: 'delete', path: '/:id', access: ADMIN, params: s.idParams, status: 204, summary: 'Delete a table that was never booked', handler: c.tables.remove });
  });

  const reservations = build('/api/reservations', 'Reservations', (route) => {
    route({ method: 'get', path: '/slots', query: s.slotsQuery, summary: 'Bookable start times for a day', handler: c.reservations.slots });
    route({ method: 'get', path: '/availability', query: s.availabilityQuery, summary: 'Tables free for a slot, smallest fit first', handler: c.reservations.availability });
    route({ method: 'post', path: '/walk-in', access: STAFF, body: s.walkIn, status: 201, summary: 'Seat a walk-in (starts now, same availability rule)', handler: c.reservations.walkIn });
    route({ method: 'post', path: '/', body: s.createReservation, status: 201, summary: 'Book a table, with an optional pre-order', handler: c.reservations.create });
    route({ method: 'get', path: '/', query: s.reservationListQuery, summary: 'List reservations (customers see their own)', handler: c.reservations.list });
    route({ method: 'get', path: '/:id', params: s.idParams, summary: 'One reservation', handler: c.reservations.get });
    route({ method: 'patch', path: '/:id/cancel', params: s.idParams, summary: 'Cancel; frees the table and releases held ingredients', handler: c.reservations.cancel });
    route({ method: 'patch', path: '/:id/seat', access: STAFF, params: s.idParams, summary: 'Mark a confirmed reservation as seated', handler: c.reservations.seat });
    route({ method: 'patch', path: '/:id/complete', access: STAFF, params: s.idParams, summary: 'Mark completed (frees the table early)', handler: c.reservations.complete });
  });

  const orders = build('/api/orders', 'Orders', (route) => {
    route({ method: 'post', path: '/', body: s.placeOrder, status: 201, summary: 'Place a dine-in or takeaway order (holds ingredients)', handler: c.orders.place });
    route({ method: 'get', path: '/', query: s.orderListQuery, summary: 'List orders (customers see their own)', handler: c.orders.list });
    route({ method: 'get', path: '/:id', params: s.idParams, summary: 'Order detail', handler: c.orders.get });
    route({ method: 'put', path: '/:id/items', params: s.idParams, body: s.editOrderItems, summary: 'Edit items before preparing (applies the inventory difference)', handler: c.orders.editItems });
    route({ method: 'patch', path: '/:id/status', access: STAFF, params: s.idParams, body: s.orderStatus, summary: 'Move to preparing (consumes the hold), ready or served', handler: c.orders.updateStatus });
    route({ method: 'patch', path: '/:id/cancel', params: s.idParams, summary: 'Cancel; releases the hold if preparation has not started', handler: c.orders.cancel });
  });

  const ingredients = build('/api/ingredients', 'Inventory', (route) => {
    route({ method: 'get', path: '/', access: ADMIN, summary: 'Ingredients with stock, reserved and available', handler: c.inventory.list });
    route({ method: 'post', path: '/', access: ADMIN, body: s.ingredient, status: 201, summary: 'Create an ingredient', handler: c.inventory.create });
    route({ method: 'put', path: '/:id', access: ADMIN, params: s.idParams, body: s.ingredientUpdate, summary: 'Update name, unit or low-stock threshold', handler: c.inventory.update });
    route({ method: 'patch', path: '/:id/stock', access: ADMIN, params: s.idParams, body: s.stockAdjustment, summary: 'Adjust stock: restock, waste or correction', handler: c.inventory.adjust });
    route({ method: 'get', path: '/:id/adjustments', access: ADMIN, params: s.idParams, summary: 'Audit trail of stock adjustments', handler: c.inventory.adjustments });
  });

  const inventory = build('/api/inventory', 'Inventory', (route) => {
    route({ method: 'get', path: '/alerts', access: STAFF, summary: 'Ingredients at or below their low-stock threshold', handler: c.inventory.alerts });
  });

  const reports = build('/api/reports', 'Reports', (route) => {
    route({ method: 'get', path: '/daily-sales', access: ADMIN, query: s.dailySalesQuery, summary: 'Sales for a day: total, order count, per-item breakdown', handler: c.reports.dailySales });
    route({ method: 'get', path: '/low-stock', access: ADMIN, summary: 'Low-stock report with affected menu items', handler: c.reports.lowStock });
  });

  return [auth, users, menu, tables, reservations, orders, ingredients, inventory, reports];
}

module.exports = { createRouters };
