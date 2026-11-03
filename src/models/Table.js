'use strict';
const mongoose = require('mongoose');
const { TABLE_ZONES } = require('../domain/constants');

const tableSchema = new mongoose.Schema(
  {
    number: { type: Number, required: true, unique: true, min: 1 },
    capacity: { type: Number, required: true, min: 1, validate: { validator: Number.isInteger, message: 'capacity must be a whole number' } },
    zone: { type: String, enum: TABLE_ZONES, default: 'normal', required: true },
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

module.exports = mongoose.model('Table', tableSchema);
