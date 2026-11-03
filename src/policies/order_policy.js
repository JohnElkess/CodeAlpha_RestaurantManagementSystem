'use strict';
const { BadRequestError, ConflictError, NotFoundError } = require('../utils/errors');
const { ORDER_TYPES, PICKUP_TYPES, RESERVATION_STATUS } = require('../domain/constants');
const t = require('../utils/time');

/**
 * Strategy pattern again: dine-in and takeaway orders are validated and scheduled by different rules.
 * `prepare` returns the type-specific fields of the order, or throws.
 */
class DineInOrderPolicy {
  constructor({ reservationRepo }) {
    this.reservationRepo = reservationRepo;
  }

  async prepare({ customerId, input }) {
    if (!input.reservationId) {
      throw new BadRequestError('RESERVATION_REQUIRED', 'A dine-in order needs a reservationId');
    }
    const reservation = await this.reservationRepo.findRaw(input.reservationId);
    // Someone else's reservation looks exactly like a missing one.
    if (!reservation || String(reservation.customer) !== String(customerId)) {
      throw new NotFoundError('Reservation not found', 'RESERVATION_NOT_FOUND');
    }
    if (![RESERVATION_STATUS.CONFIRMED, RESERVATION_STATUS.SEATED].includes(reservation.status)) {
      throw new ConflictError('RESERVATION_NOT_ACTIVE', `The reservation is ${reservation.status}`);
    }
    return { reservation: reservation._id, scheduledFor: reservation.startTime };
  }
}

class TakeawayOrderPolicy {
  constructor({ clock, business }) {
    this.clock = clock;
    this.business = business;
  }

  async prepare({ input }) {
    const b = this.business;
    const rules = b.takeaway;
    const now = this.clock.now();

    if (!input.pickupType) throw new BadRequestError('PICKUP_TYPE_REQUIRED', 'pickupType must be "asap" or "scheduled"');

    if (input.pickupType === PICKUP_TYPES.ASAP) {
      if (input.pickupTime) throw new BadRequestError('PICKUP_TIME_NOT_ALLOWED', 'ASAP orders do not take a pickupTime');
      const local = t.zoned(now, b.timezone);
      const open = t.localTime(local, b.opening).toJSDate();
      const last = t.localTime(local, rules.lastOrder).toJSDate();
      if (now < open || now > last) {
        throw new BadRequestError('OUTSIDE_ORDERING_HOURS', 'ASAP takeaway orders are accepted from opening until the last-order time');
      }
      return {
        pickupType: PICKUP_TYPES.ASAP,
        pickupTime: t.addMinutes(now, rules.asapPrepMinutes), // estimate; also drives the uncollected rule
        scheduledFor: now,
      };
    }

    if (!input.pickupTime) throw new BadRequestError('PICKUP_TIME_REQUIRED', 'Scheduled orders need a pickupTime');
    const pickup = t.parseInstant(input.pickupTime, b.timezone);
    if (!pickup) throw new BadRequestError('INVALID_PICKUP_TIME', 'pickupTime must be an ISO 8601 date-time');

    const local = t.zoned(pickup, b.timezone);
    if (!t.isOnSlotBoundary(local, b.slotMinutes)) {
      throw new BadRequestError('NOT_ON_SLOT_BOUNDARY', `Pickup times use ${b.slotMinutes}-minute slots`);
    }
    const minutes = t.minutesOfDay(local);
    if (minutes < b.opening || minutes > rules.lastOrder) {
      throw new BadRequestError('OUTSIDE_PICKUP_HOURS', 'Pickup must be between opening time and the last pickup time');
    }
    if (pickup < t.addMinutes(now, rules.minLeadMinutes)) {
      throw new BadRequestError('PICKUP_TOO_SOON', `Pickup needs at least ${rules.minLeadMinutes} minutes of lead time`);
    }
    if (pickup > t.addDays(now, rules.scheduledHorizonDays)) {
      throw new BadRequestError('BEYOND_PICKUP_HORIZON', `Pickup can be scheduled up to ${rules.scheduledHorizonDays} days ahead`);
    }
    return { pickupType: PICKUP_TYPES.SCHEDULED, pickupTime: pickup, scheduledFor: pickup };
  }
}

/** Factory: picks the strategy for an order type. */
class OrderPolicyFactory {
  constructor(deps) {
    this.strategies = {
      [ORDER_TYPES.DINE_IN]: new DineInOrderPolicy(deps),
      [ORDER_TYPES.TAKEAWAY]: new TakeawayOrderPolicy(deps),
    };
  }

  forType(type) {
    return this.strategies[type];
  }
}

module.exports = { DineInOrderPolicy, TakeawayOrderPolicy, OrderPolicyFactory };
