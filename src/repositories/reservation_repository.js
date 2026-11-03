'use strict';
const Reservation = require('../models/Reservation');
const Table = require('../models/Table');
const { RESERVATION_STATUS, TABLE_HOLDING_STATUSES } = require('../domain/constants');
const { minuteBuckets } = require('../utils/time');

const POPULATE_TABLE = { path: 'table', select: 'number capacity zone' };
const POPULATE_CUSTOMER = { path: 'customer', select: 'name phone email' };

class ReservationRepository {
  /**
   * Tables that fit the party, are active, match the zone and have no confirmed/seated reservation
   * overlapping [start, end). Smallest table first (scope 2.2: "smallest available table that fits").
   *
   * Overlap condition: existing.startTime < requested.end AND existing.endTime > requested.start
   */
  async findAvailableTables({ start, end, partySize, zone }) {
    const busy = await Reservation.distinct('table', {
      status: { $in: TABLE_HOLDING_STATUSES },
      startTime: { $lt: end },
      endTime: { $gt: start },
    });
    const filter = { isActive: true, capacity: { $gte: partySize }, _id: { $nin: busy } };
    if (zone) filter.zone = zone;
    return Table.find(filter).sort({ capacity: 1, number: 1 });
  }

  async isTableFree(tableId, start, end) {
    const clash = await Reservation.exists({
      table: tableId,
      status: { $in: TABLE_HOLDING_STATUSES },
      startTime: { $lt: end },
      endTime: { $gt: start },
    });
    return !clash;
  }

  /**
   * Insert a reservation that holds its table. The unique partial index rejects an overlapping hold, so two
   * racing requests cannot both succeed even though both passed the read-only overlap check.
   * @returns {Promise<{ok: true, reservation: object} | {ok: false}>} ok:false means "table was taken"
   */
  async insertHolding(data) {
    try {
      const reservation = await Reservation.create({
        ...data,
        status: data.status || RESERVATION_STATUS.CONFIRMED,
        holdsTable: true,
        occupancy: minuteBuckets(data.startTime, data.endTime),
      });
      return { ok: true, reservation };
    } catch (err) {
      if (err && err.code === 11000) return { ok: false };
      throw err;
    }
  }

  findTableById(id) {
    return Table.findById(id);
  }

  /** Capacity of the biggest active table (0 when there is none). */
  async maxActiveCapacity() {
    const biggest = await Table.findOne({ isActive: true }).sort({ capacity: -1 }).select('capacity').lean();
    return biggest ? biggest.capacity : 0;
  }

  deleteById(id) {
    return Reservation.deleteOne({ _id: id });
  }

  findById(id) {
    return Reservation.findById(id).populate(POPULATE_TABLE).populate(POPULATE_CUSTOMER);
  }

  /** Plain read without populate (used by validation inside other services). */
  findRaw(id) {
    return Reservation.findById(id);
  }

  /**
   * Atomic status change. Matches only if the reservation is still in one of `fromStatuses`, so competing
   * actors (a customer cancelling vs. the no-show job) cannot both win.
   * @returns the updated document, or null when the reservation was no longer in an allowed state
   */
  transition(id, fromStatuses, toStatus, extraSet = {}) {
    const releasesTable = !TABLE_HOLDING_STATUSES.includes(toStatus);
    return Reservation.findOneAndUpdate(
      { _id: id, status: { $in: fromStatuses } },
      { $set: { status: toStatus, ...(releasesTable ? { holdsTable: false } : {}), ...extraSet } },
      { returnDocument: 'after' }
    );
  }

  async list({ customerId, status, from, to, tableId, page, limit }) {
    const filter = {};
    if (customerId) filter.customer = customerId;
    if (status) filter.status = status;
    if (tableId) filter.table = tableId;
    if (from || to) {
      filter.startTime = {};
      if (from) filter.startTime.$gte = from;
      if (to) filter.startTime.$lt = to;
    }
    const [items, total] = await Promise.all([
      Reservation.find(filter)
        .sort({ startTime: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate(POPULATE_TABLE)
        .populate(POPULATE_CUSTOMER),
      Reservation.countDocuments(filter),
    ]);
    return { items, total };
  }

  /** Confirmed reservations whose no-show deadline has passed. */
  findNoShowCandidates(cutoff) {
    return Reservation.find({ status: RESERVATION_STATUS.CONFIRMED, startTime: { $lte: cutoff } }).select('_id');
  }

  /** Seated reservations whose stay has ended. */
  findOverdueSeated(now) {
    return Reservation.find({ status: RESERVATION_STATUS.SEATED, endTime: { $lte: now } }).select('_id');
  }

  /** Does the table have an upcoming active reservation (optionally one that no longer fits)? */
  hasUpcomingHold(tableId, now, { partySizeAbove } = {}) {
    const filter = { table: tableId, status: { $in: TABLE_HOLDING_STATUSES }, endTime: { $gt: now } };
    if (partySizeAbove !== undefined) filter.partySize = { $gt: partySizeAbove };
    return Reservation.exists(filter);
  }

  tableHasReservations(tableId) {
    return Reservation.exists({ table: tableId });
  }
}

module.exports = { ReservationRepository };
