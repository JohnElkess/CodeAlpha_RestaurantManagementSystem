'use strict';
const mongoose = require('mongoose');
const { RESERVATION_SOURCES, RESERVATION_STATUS } = require('../domain/constants');

const reservationSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    table: { type: mongoose.Schema.Types.ObjectId, ref: 'Table', required: true },
    partySize: { type: Number, required: true, min: 1 },
    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true }, // startTime + 2h
    source: { type: String, enum: Object.values(RESERVATION_SOURCES), required: true },
    status: { type: String, enum: Object.values(RESERVATION_STATUS), default: RESERVATION_STATUS.CONFIRMED },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    seatedAt: Date,
    completedAt: Date,
    cancelledAt: Date,
    noShowAt: Date,

    // Double-booking guard (see ReservationRepository): while a reservation holds its table, `occupancy`
    // lists every minute it covers, and a partial UNIQUE index on (table, occupancy) lets the database itself
    // reject two overlapping reservations even when two requests race.
    holdsTable: { type: Boolean, default: true },
    occupancy: { type: [Number], select: false },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.occupancy;
        delete ret.holdsTable;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Index named in the scope for the overlap check.
reservationSchema.index({ table: 1, startTime: 1, endTime: 1, status: 1 });
reservationSchema.index(
  { table: 1, occupancy: 1 },
  { unique: true, partialFilterExpression: { holdsTable: true }, name: 'no_double_booking' }
);
reservationSchema.index({ customer: 1, startTime: -1 });
reservationSchema.index({ status: 1, startTime: 1 }); // background jobs

module.exports = mongoose.model('Reservation', reservationSchema);
