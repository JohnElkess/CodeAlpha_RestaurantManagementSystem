'use strict';
const { reservationMachine } = require('../domain/state_machines');
const { RESERVATION_SOURCES, RESERVATION_STATUS: R, ORDER_TYPES, ROLES } = require('../domain/constants');
const { BadRequestError, ConflictError, NotFoundError } = require('../utils/errors');
const { dayBounds, reservationSlots, addMinutes } = require('../utils/time');
const EVENTS = require('../events/events');

class ReservationService {
  constructor({ reservationRepo, policies, customers, orderService, eventBus, clock, business }) {
    this.repo = reservationRepo;
    this.policies = policies;
    this.customers = customers;
    this.orderService = orderService;
    this.eventBus = eventBus;
    this.clock = clock;
    this.business = business;
  }

  /** Valid reservation start times for a local day (13 slots from 16:00 to 22:00). */
  slots(date) {
    const b = this.business;
    return reservationSlots(date, { zone: b.timezone, ...b });
  }

  /** Tables free for a slot, smallest fit first. Uses exactly the same rules as booking. */
  async availability({ startTime, partySize, zone }) {
    const { start, end } = this.policies.forSource(RESERVATION_SOURCES.ONLINE).resolveWindow({ startTime });
    await this.assertPartyFitsSomewhere(partySize);
    const tables = await this.repo.findAvailableTables({ start, end, partySize, zone });
    return { start, end, partySize, zone: zone || null, tables, suggestedTable: tables[0] || null };
  }

  /** Book a table, optionally with a pre-order (scope 7.1). Fails as a whole if either part fails. */
  async create(actor, input) {
    const customerId = await this.customers.resolve(actor, input.customerId);
    const source = actor.role === ROLES.CUSTOMER ? RESERVATION_SOURCES.ONLINE : RESERVATION_SOURCES.PHONE;
    const { start, end } = this.policies.forSource(source).resolveWindow({ startTime: input.startTime });

    const reservation = await this.holdTable({
      customer: customerId,
      partySize: input.partySize,
      startTime: start,
      endTime: end,
      source,
      status: R.CONFIRMED,
      createdBy: actor.id,
    }, { zone: input.zone, tableId: input.tableId });

    let preOrder = null;
    if (input.preOrder && input.preOrder.items.length) {
      try {
        preOrder = await this.orderService.placeOrder(actor, {
          type: ORDER_TYPES.DINE_IN,
          reservationId: String(reservation._id),
          customerId: String(customerId),
          items: input.preOrder.items,
        });
      } catch (err) {
        await this.repo.deleteById(reservation._id); // all or nothing: no table without the food
        throw err;
      }
    }
    await this.eventBus.publish(EVENTS.RESERVATION_CREATED, { reservationId: String(reservation._id), source });
    return { reservation: await this.repo.findById(reservation._id), preOrder };
  }

  /** Staff seats a walk-in: start = now, same availability rule, ends by midnight, seated immediately (scope 7.2). */
  async walkIn(actor, input) {
    const customerId = await this.customers.resolve(actor, input.customerId);
    const { start, end } = this.policies.forSource(RESERVATION_SOURCES.WALK_IN).resolveWindow({});
    const reservation = await this.holdTable({
      customer: customerId,
      partySize: input.partySize,
      startTime: start,
      endTime: end,
      source: RESERVATION_SOURCES.WALK_IN,
      status: R.SEATED,
      seatedAt: this.clock.now(),
      createdBy: actor.id,
    }, { zone: input.zone, tableId: input.tableId });
    await this.eventBus.publish(EVENTS.RESERVATION_CREATED, { reservationId: String(reservation._id), source: RESERVATION_SOURCES.WALK_IN });
    return this.repo.findById(reservation._id);
  }

  async cancel(actor, id) {
    const reservation = await this.loadAccessible(actor, id);
    const updated = await this.repo.transition(reservation._id, reservationMachine.sourcesOf(R.CANCELLED), R.CANCELLED, { cancelledAt: this.clock.now() });
    if (!updated) throw await this.transitionError(reservation._id, R.CANCELLED);
    const cancelledOrders = await this.orderService.cancelOpenOrdersOfReservation(reservation._id); // releases held ingredients
    await this.eventBus.publish(EVENTS.RESERVATION_CANCELLED, { reservationId: String(id), cancelledOrders });
    return this.repo.findById(id);
  }

  async seat(id) {
    const updated = await this.repo.transition(id, reservationMachine.sourcesOf(R.SEATED), R.SEATED, { seatedAt: this.clock.now() });
    if (!updated) throw await this.transitionError(id, R.SEATED);
    await this.eventBus.publish(EVENTS.RESERVATION_SEATED, { reservationId: String(id) });
    return this.repo.findById(id);
  }

  /** Frees the table at once, even before the two hours are up. */
  async complete(id) {
    const updated = await this.repo.transition(id, reservationMachine.sourcesOf(R.COMPLETED), R.COMPLETED, { completedAt: this.clock.now() });
    if (!updated) throw await this.transitionError(id, R.COMPLETED);
    await this.eventBus.publish(EVENTS.RESERVATION_COMPLETED, { reservationId: String(id) });
    return this.repo.findById(id);
  }

  /** Background job: guest never came. The table is freed and the pre-order's ingredients are released. */
  async markNoShow(id) {
    const updated = await this.repo.transition(id, [R.CONFIRMED], R.NO_SHOW, { noShowAt: this.clock.now() });
    if (!updated) return false;
    const cancelledOrders = await this.orderService.cancelOpenOrdersOfReservation(id);
    await this.eventBus.publish(EVENTS.RESERVATION_NO_SHOW, { reservationId: String(id), cancelledOrders });
    return true;
  }

  /** Background job: the stay is over. */
  async autoComplete(id) {
    const updated = await this.repo.transition(id, [R.SEATED], R.COMPLETED, { completedAt: this.clock.now() });
    if (updated) await this.eventBus.publish(EVENTS.RESERVATION_COMPLETED, { reservationId: String(id), auto: true });
    return Boolean(updated);
  }

  async get(actor, id) {
    await this.loadAccessible(actor, id);
    return this.repo.findById(id);
  }

  async list(actor, filters) {
    const { page, limit } = filters;
    const query = { ...filters };
    if (actor.role === ROLES.CUSTOMER) query.customerId = actor.id;
    if (filters.date) {
      const bounds = dayBounds(filters.date, this.business.timezone);
      query.from = bounds.start;
      query.to = bounds.end;
    }
    const { items, total } = await this.repo.list(query);
    return { items, page, limit, total, pages: Math.ceil(total / limit) };
  }

  /** Next deadline helpers used by jobs. */
  noShowCutoff() {
    return addMinutes(this.clock.now(), -this.business.noShowGraceMinutes);
  }

  // ---- internals ----

  /**
   * Put the reservation on a table. A named table is used if free; otherwise the smallest free table that fits
   * is chosen. The insert itself is guarded by the database (unique index), so when two requests race for the
   * same table one of them is told "taken" and we simply try the next candidate.
   */
  async holdTable(data, { zone, tableId }) {
    if (tableId) {
      const table = await this.repo.findTableById(tableId);
      if (!table) throw new BadRequestError('TABLE_NOT_FOUND', 'No table with that id');
      if (!table.isActive) throw new BadRequestError('TABLE_INACTIVE', 'This table is not in service');
      if (data.partySize > table.capacity) {
        throw new BadRequestError('PARTY_EXCEEDS_CAPACITY', `Table ${table.number} seats ${table.capacity}`);
      }
      const free = await this.repo.isTableFree(table._id, data.startTime, data.endTime);
      const result = free ? await this.repo.insertHolding({ ...data, table: table._id }) : { ok: false };
      if (!result.ok) throw new ConflictError('TABLE_NOT_AVAILABLE', `Table ${table.number} is not available at that time`);
      return result.reservation;
    }

    await this.assertPartyFitsSomewhere(data.partySize);
    const candidates = await this.repo.findAvailableTables({ start: data.startTime, end: data.endTime, partySize: data.partySize, zone });
    for (const table of candidates) {
      const result = await this.repo.insertHolding({ ...data, table: table._id });
      if (result.ok) return result.reservation;
    }
    throw new ConflictError('NO_TABLE_AVAILABLE', 'No table is available for that time and party size', { zone: zone || null });
  }

  async assertPartyFitsSomewhere(partySize) {
    const biggest = await this.repo.maxActiveCapacity();
    // With no active table at all the honest answer is "no table available", not "cannot seat more than 0".
    if (biggest > 0 && partySize > biggest) {
      throw new BadRequestError('PARTY_TOO_LARGE', `We cannot seat more than ${biggest} guests at one table`);
    }
  }

  /** Someone else's reservation looks exactly like a missing one. */
  async loadAccessible(actor, id) {
    const reservation = await this.repo.findRaw(id);
    if (!reservation || (actor.role === ROLES.CUSTOMER && String(reservation.customer) !== String(actor.id))) {
      throw new NotFoundError('Reservation not found', 'RESERVATION_NOT_FOUND');
    }
    return reservation;
  }

  async transitionError(id, target) {
    const reservation = await this.repo.findRaw(id);
    if (!reservation) return new NotFoundError('Reservation not found', 'RESERVATION_NOT_FOUND');
    return new ConflictError('INVALID_STATUS_TRANSITION', `A reservation cannot move from "${reservation.status}" to "${target}"`, {
      from: reservation.status,
      to: target,
      allowedNext: reservationMachine.next(reservation.status),
    });
  }
}

module.exports = { ReservationService };
