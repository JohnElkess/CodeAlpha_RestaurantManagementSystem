'use strict';
const { z } = require('zod');
const business = require('../config/business');
const { env } = require('../config/env');
const { ROLE_VALUES, TABLE_ZONES, INGREDIENT_UNITS, ORDER_TYPES, PICKUP_TYPES, RESERVATION_STATUS, ORDER_STATUS } = require('../domain/constants');
const { normalizePhone } = require('../utils/phone');
const { isValidPrice } = require('../utils/money');
const { parseInstant, dayBounds } = require('../utils/time');

// ---------- building blocks ----------
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');
const idParams = z.object({ id: objectId });

const text = (max = 100) => z.string().trim().min(1).max(max);
const wholeNumber = (min = 0) => z.number().int().min(min);
const positiveInt = z.coerce.number().int().min(1);

const isoDateTime = z
  .string()
  .refine((v) => parseInstant(v, business.timezone) !== null, 'must be an ISO 8601 date-time, e.g. 2026-11-10T19:00');
const dateOnly = z.string().refine((v) => dayBounds(v, business.timezone) !== null, 'must be a real date in YYYY-MM-DD format');

const phone = z
  .string()
  .transform((v) => normalizePhone(v, env.DEFAULT_COUNTRY_CODE))
  .refine((v) => v !== null, 'must be a valid phone number');
const email = z.string().trim().toLowerCase().pipe(z.email('must be a valid email address'));
const password = z.string().min(8, 'must be at least 8 characters').max(72, 'must be at most 72 characters');

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(business.pagination.maxLimit).default(business.pagination.defaultLimit),
};

const atLeastOneField = (obj) => Object.values(obj).some((v) => v !== undefined);

// ---------- auth ----------
const register = z.object({ name: text(), phone, email: email.optional(), password });

const login = z
  .object({
    identifier: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    phone: z.string().min(1).optional(),
    password: z.string().min(1),
  })
  .refine((v) => v.identifier || v.email || v.phone, 'identifier (phone or email) is required')
  .transform((v) => ({ identifier: v.identifier || v.email || v.phone, password: v.password }));

const changePassword = z.object({ currentPassword: z.string().min(1), newPassword: password });

// ---------- users ----------
const guest = z.object({ name: text(), phone, email: email.optional() });
const userSearch = z
  .object({ phone: z.string().min(1).optional(), email: z.string().min(1).optional() })
  .refine(atLeastOneField, 'provide phone or email');
const roleChange = z.object({ role: z.enum(ROLE_VALUES) });

// ---------- menu ----------
const recipeLine = z.object({ ingredient: objectId, quantityPerPortion: wholeNumber(1) });
const menuItem = z.object({
  name: text(),
  description: z.string().trim().max(500).default(''),
  price: z.number().refine(isValidPrice, 'must be zero or more, with at most 2 decimals'),
  category: text(50),
  recipe: z.array(recipeLine).min(1).max(30),
});
const menuAvailability = z.object({ isAvailable: z.boolean() });

// ---------- tables ----------
const tableFields = { number: wholeNumber(1), capacity: wholeNumber(1).max(50), zone: z.enum(TABLE_ZONES), isActive: z.boolean() };
const table = z.object({ ...tableFields, zone: tableFields.zone.default('normal'), isActive: tableFields.isActive.optional() });
// Updates are built from the plain fields: `.partial()` on `table` would keep the zone default and silently reset it.
const tableUpdate = z.object(tableFields).partial().refine(atLeastOneField, 'provide at least one field to change');
const tableListQuery = z.object({
  zone: z.enum(TABLE_ZONES).optional(),
  isActive: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

// ---------- ingredients ----------
const ingredient = z.object({
  name: text(),
  unit: z.enum(INGREDIENT_UNITS),
  stock: wholeNumber(0).default(0),
  lowStockThreshold: wholeNumber(0).default(0),
});
const ingredientUpdate = z
  .object({ name: text().optional(), unit: z.enum(INGREDIENT_UNITS).optional(), lowStockThreshold: wholeNumber(0).optional() })
  .refine(atLeastOneField, 'provide at least one field to change');
const stockAdjustment = z
  .object({
    delta: wholeNumber(Number.MIN_SAFE_INTEGER).refine((v) => v !== 0, 'must not be zero'),
    reason: z.enum(['restock', 'waste', 'correction']),
    note: z.string().trim().max(300).optional(),
  })
  .refine((v) => v.reason !== 'restock' || v.delta > 0, { message: 'a restock must be positive', path: ['delta'] })
  .refine((v) => v.reason !== 'waste' || v.delta < 0, { message: 'waste must be negative', path: ['delta'] });

// ---------- orders ----------
const orderItems = z
  .array(z.object({ menuItem: objectId, quantity: wholeNumber(1).max(business.order.maxQuantityPerLine) }))
  .min(1)
  .max(business.order.maxLines);
const placeOrder = z.object({
  type: z.enum(Object.values(ORDER_TYPES)),
  reservationId: objectId.optional(),
  customerId: objectId.optional(),
  items: orderItems,
  pickupType: z.enum(Object.values(PICKUP_TYPES)).optional(),
  pickupTime: isoDateTime.optional(),
});
const editOrderItems = z.object({ items: orderItems });
const orderStatus = z.object({ status: z.enum([ORDER_STATUS.PREPARING, ORDER_STATUS.READY, ORDER_STATUS.SERVED]) });
const orderListQuery = z.object({
  status: z.enum(Object.values(ORDER_STATUS)).optional(),
  type: z.enum(Object.values(ORDER_TYPES)).optional(),
  date: dateOnly.optional(),
  customerId: objectId.optional(),
  ...pagination,
});

// ---------- reservations ----------
const availabilityQuery = z.object({
  start: isoDateTime,
  partySize: positiveInt.max(100),
  zone: z.enum(TABLE_ZONES).optional(),
});
const slotsQuery = z.object({ date: dateOnly });
const createReservation = z.object({
  startTime: isoDateTime,
  partySize: wholeNumber(1).max(100),
  zone: z.enum(TABLE_ZONES).optional(),
  tableId: objectId.optional(),
  customerId: objectId.optional(),
  preOrder: z.object({ items: orderItems }).optional(),
});
const walkIn = z.object({
  customerId: objectId.optional(),
  partySize: wholeNumber(1).max(100),
  zone: z.enum(TABLE_ZONES).optional(),
  tableId: objectId.optional(),
});
const reservationListQuery = z.object({
  status: z.enum(Object.values(RESERVATION_STATUS)).optional(),
  date: dateOnly.optional(),
  customerId: objectId.optional(),
  tableId: objectId.optional(),
  ...pagination,
});

// ---------- reports ----------
const dailySalesQuery = z.object({ date: dateOnly.optional() });

module.exports = {
  idParams,
  register,
  login,
  changePassword,
  guest,
  userSearch,
  roleChange,
  menuItem,
  menuAvailability,
  table,
  tableUpdate,
  tableListQuery,
  ingredient,
  ingredientUpdate,
  stockAdjustment,
  placeOrder,
  editOrderItems,
  orderStatus,
  orderListQuery,
  availabilityQuery,
  slotsQuery,
  createReservation,
  walkIn,
  reservationListQuery,
  dailySalesQuery,
};
