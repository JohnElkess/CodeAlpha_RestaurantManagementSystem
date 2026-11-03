'use strict';
const { DateTime } = require('luxon');

/**
 * Time helpers. All instants are stored as UTC `Date`s; business rules are evaluated in the
 * configured zone (Africa/Cairo observes DST, so never add "2 hours" to a wall-clock time by hand).
 */

const zoned = (date, zone) => DateTime.fromJSDate(date, { zone });

/** Parse an ISO 8601 string. Strings without an offset are read as local time in `zone`. */
function parseInstant(input, zone) {
  if (typeof input !== 'string') return null;
  const dt = DateTime.fromISO(input, { zone });
  return dt.isValid ? dt.toJSDate() : null;
}

const minutesOfDay = (dt) => dt.hour * 60 + dt.minute;
const isMinuteAligned = (dt) => dt.second === 0 && dt.millisecond === 0;
const isOnSlotBoundary = (dt, slotMinutes) => isMinuteAligned(dt) && minutesOfDay(dt) % slotMinutes === 0;

/** The instant at `minutes` after local midnight of `dt`'s day. 1440 means "the start of the next day". */
function localTime(dt, minutes) {
  if (minutes >= 1440) return dt.plus({ days: 1 }).startOf('day');
  return dt.set({ hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0, millisecond: 0 });
}

const floorToMinute = (date) => new Date(Math.floor(date.getTime() / 60000) * 60000);
const addMinutes = (date, minutes) => new Date(date.getTime() + minutes * 60000);
const addDays = (date, days) => new Date(date.getTime() + days * 24 * 60 * 60000);

/** [start, end) of a local calendar day given as "YYYY-MM-DD", or null if the string is not a real date. */
function dayBounds(dateString, zone) {
  if (typeof dateString !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return null;
  const start = DateTime.fromISO(dateString, { zone }).startOf('day');
  if (!start.isValid) return null;
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).startOf('day').toJSDate() };
}

const localDateString = (date, zone) => zoned(date, zone).toFormat('yyyy-MM-dd');

/**
 * Every bookable reservation start on a local day: opening .. lastReservationStart, every slot.
 * Returns Dates (UTC instants).
 */
function reservationSlots(dateString, { zone, opening, lastReservationStart, slotMinutes }) {
  const bounds = dayBounds(dateString, zone);
  if (!bounds) return [];
  const day = zoned(bounds.start, zone);
  const slots = [];
  for (let m = opening; m <= lastReservationStart; m += slotMinutes) slots.push(localTime(day, m).toJSDate());
  return slots;
}

/** Minute indexes (minutes since epoch) covered by [start, end). Used by the double-booking guard index. */
function minuteBuckets(start, end) {
  const first = Math.floor(start.getTime() / 60000);
  const last = Math.ceil(end.getTime() / 60000) - 1;
  const buckets = [];
  for (let m = first; m <= last; m += 1) buckets.push(m);
  return buckets;
}

module.exports = {
  zoned,
  parseInstant,
  minutesOfDay,
  isMinuteAligned,
  isOnSlotBoundary,
  localTime,
  floorToMinute,
  addMinutes,
  addDays,
  dayBounds,
  localDateString,
  reservationSlots,
  minuteBuckets,
};
