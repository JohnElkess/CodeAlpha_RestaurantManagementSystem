'use strict';
const { BadRequestError } = require('../utils/errors');
const { RESERVATION_SOURCES } = require('../domain/constants');
const t = require('../utils/time');

const hhmm = (minutes) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * Strategy pattern: HOW a reservation window is decided depends on where the booking comes from.
 * Online and phone bookings pick a slot; walk-ins start "now". Each strategy returns { start, end }
 * or throws a 400 with a specific code.
 */
class SlotReservationPolicy {
  constructor({ clock, business }) {
    this.clock = clock;
    this.business = business;
  }

  resolveWindow({ startTime }) {
    const b = this.business;
    const now = this.clock.now();
    const start = t.parseInstant(startTime, b.timezone);
    if (!start) throw new BadRequestError('INVALID_START_TIME', 'startTime must be an ISO 8601 date-time');

    const local = t.zoned(start, b.timezone);
    if (!t.isOnSlotBoundary(local, b.slotMinutes)) {
      throw new BadRequestError('NOT_ON_SLOT_BOUNDARY', `Reservations start on a ${b.slotMinutes}-minute boundary (:00 or :30)`);
    }
    const minutes = t.minutesOfDay(local);
    if (minutes < b.opening || minutes > b.lastReservationStart) {
      throw new BadRequestError(
        'OUTSIDE_BOOKING_HOURS',
        `Reservations can start between ${hhmm(b.opening)} and ${hhmm(b.lastReservationStart)}`
      );
    }
    if (start < now) throw new BadRequestError('START_IN_PAST', 'The requested time is in the past');
    if (start > t.addDays(now, b.reservationHorizonDays)) {
      throw new BadRequestError('BEYOND_BOOKING_HORIZON', `Reservations can be made up to ${b.reservationHorizonDays} days ahead`);
    }
    return { start, end: t.addMinutes(start, b.stayMinutes) };
  }
}

class WalkInReservationPolicy {
  constructor({ clock, business }) {
    this.clock = clock;
    this.business = business;
  }

  resolveWindow() {
    const b = this.business;
    const now = this.clock.now();
    const local = t.zoned(now, b.timezone);

    if (now < t.localTime(local, b.opening).toJSDate()) {
      throw new BadRequestError('RESTAURANT_CLOSED', `The restaurant opens at ${hhmm(b.opening)}`);
    }
    if (now > t.localTime(local, b.lastReservationStart).toJSDate()) {
      throw new BadRequestError('NO_NEW_SEATINGS', `No new seatings after ${hhmm(b.lastReservationStart)}`);
    }
    const start = t.floorToMinute(now); // a walk-in starts now, not on a slot boundary
    const end = t.addMinutes(start, b.stayMinutes);
    if (end > t.localTime(local, b.closing).toJSDate()) {
      throw new BadRequestError('STAY_EXCEEDS_CLOSING', 'A full stay would end after closing time');
    }
    return { start, end };
  }
}

/** Simple factory choosing the strategy for a booking source. */
class ReservationPolicyFactory {
  constructor(deps) {
    const slot = new SlotReservationPolicy(deps);
    this.strategies = {
      [RESERVATION_SOURCES.ONLINE]: slot,
      [RESERVATION_SOURCES.PHONE]: slot,
      [RESERVATION_SOURCES.WALK_IN]: new WalkInReservationPolicy(deps),
    };
  }

  forSource(source) {
    return this.strategies[source];
  }
}

module.exports = { SlotReservationPolicy, WalkInReservationPolicy, ReservationPolicyFactory };
