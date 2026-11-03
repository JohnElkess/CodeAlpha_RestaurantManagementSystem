'use strict';
const { env } = require('./env');

const at = (hours, minutes = 0) => hours * 60 + minutes; // minutes since local midnight

/**
 * Business rules in one place (scope section 2 and 13). They rarely change, so they live in code,
 * not in a database collection. Times are minutes since local midnight in `timezone`.
 */
module.exports = Object.freeze({
  timezone: env.TIMEZONE,
  opening: at(16), // 4:00 PM
  closing: at(24), // midnight
  slotMinutes: 30,
  stayMinutes: 120,
  lastReservationStart: at(22), // so that every stay ends by midnight
  reservationHorizonDays: 30,
  noShowGraceMinutes: 20,
  takeaway: Object.freeze({
    minLeadMinutes: 30,
    lastOrder: at(23, 30), // last ASAP order and last scheduled pickup
    scheduledHorizonDays: 7,
    uncollectedGraceMinutes: 20,
    asapPrepMinutes: 20, // ASSUMPTION: estimated preparation time, gives ASAP orders a pickupTime
  }),
  order: Object.freeze({ maxQuantityPerLine: 50, maxLines: 30 }),
  pagination: Object.freeze({ defaultLimit: 20, maxLimit: 100 }),
});
