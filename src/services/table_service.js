'use strict';
const Table = require('../models/Table');
const { isDuplicateKey } = require('../utils/mongo_errors');
const { ConflictError, NotFoundError } = require('../utils/errors');

class TableService {
  constructor({ reservationRepo, clock }) {
    this.reservationRepo = reservationRepo;
    this.clock = clock;
  }

  list({ zone, isActive } = {}) {
    const filter = {};
    if (zone) filter.zone = zone;
    if (isActive !== undefined) filter.isActive = isActive;
    return Table.find(filter).sort({ number: 1 });
  }

  async create(data) {
    try {
      return await Table.create(data);
    } catch (err) {
      if (isDuplicateKey(err)) throw new ConflictError('TABLE_NUMBER_TAKEN', `Table number ${data.number} already exists`);
      throw err;
    }
  }

  async update(id, data) {
    const table = await Table.findById(id);
    if (!table) throw new NotFoundError('Table not found', 'TABLE_NOT_FOUND');

    // Do not pull a table out from under guests who are coming.
    const now = this.clock.now();
    if (data.isActive === false && table.isActive) {
      if (await this.reservationRepo.hasUpcomingHold(table._id, now)) {
        throw new ConflictError('TABLE_HAS_RESERVATIONS', 'This table has upcoming reservations. Move or cancel them first');
      }
    }
    if (data.capacity !== undefined && data.capacity < table.capacity) {
      if (await this.reservationRepo.hasUpcomingHold(table._id, now, { partySizeAbove: data.capacity })) {
        throw new ConflictError('TABLE_HAS_RESERVATIONS', 'An upcoming reservation has a larger party than the new capacity');
      }
    }
    try {
      table.set(data);
      return await table.save();
    } catch (err) {
      if (isDuplicateKey(err)) throw new ConflictError('TABLE_NUMBER_TAKEN', `Table number ${data.number} already exists`);
      throw err;
    }
  }

  /** Tables that were ever booked are kept for history: deactivate them instead of deleting. */
  async remove(id) {
    const table = await Table.findById(id);
    if (!table) throw new NotFoundError('Table not found', 'TABLE_NOT_FOUND');
    if (await this.reservationRepo.tableHasReservations(table._id)) {
      throw new ConflictError('TABLE_IN_USE', 'This table has reservation history. Deactivate it instead of deleting it');
    }
    await table.deleteOne();
  }
}

module.exports = { TableService };
