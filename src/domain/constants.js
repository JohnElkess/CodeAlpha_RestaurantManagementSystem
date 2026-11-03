'use strict';

/** Shared vocabulary. Values match the scope document exactly. */
const ROLES = Object.freeze({ CUSTOMER: 'customer', STAFF: 'staff', ADMIN: 'admin' });
const ROLE_VALUES = Object.values(ROLES);

const STAFF_ROLES = Object.freeze([ROLES.STAFF, ROLES.ADMIN]);

const TABLE_ZONES = Object.freeze(['normal', 'window', 'vip']);
const INGREDIENT_UNITS = Object.freeze(['g', 'ml', 'pieces']);

const RESERVATION_SOURCES = Object.freeze({ ONLINE: 'online', WALK_IN: 'walk_in', PHONE: 'phone' });
const RESERVATION_STATUS = Object.freeze({
  CONFIRMED: 'confirmed',
  SEATED: 'seated',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  NO_SHOW: 'no_show',
});
/** Statuses that occupy a table (availability rule, scope 2.2). */
const TABLE_HOLDING_STATUSES = Object.freeze([RESERVATION_STATUS.CONFIRMED, RESERVATION_STATUS.SEATED]);

const ORDER_TYPES = Object.freeze({ DINE_IN: 'dine_in', TAKEAWAY: 'takeaway' });
const PICKUP_TYPES = Object.freeze({ ASAP: 'asap', SCHEDULED: 'scheduled' });
const ORDER_STATUS = Object.freeze({
  PLACED: 'placed',
  PREPARING: 'preparing',
  READY: 'ready',
  SERVED: 'served',
  CANCELLED: 'cancelled',
  UNCOLLECTED: 'uncollected',
});

/** Inventory hold lifecycle of one order (scope section 4). */
const HOLD_STATE = Object.freeze({ HELD: 'held', CONSUMED: 'consumed', RELEASED: 'released' });

module.exports = {
  ROLES,
  ROLE_VALUES,
  STAFF_ROLES,
  TABLE_ZONES,
  INGREDIENT_UNITS,
  RESERVATION_SOURCES,
  RESERVATION_STATUS,
  TABLE_HOLDING_STATUSES,
  ORDER_TYPES,
  PICKUP_TYPES,
  ORDER_STATUS,
  HOLD_STATE,
};
