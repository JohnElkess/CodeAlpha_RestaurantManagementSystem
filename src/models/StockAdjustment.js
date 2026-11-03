'use strict';
const mongoose = require('mongoose');

/** Audit trail of manual stock changes (restock, waste, correction). */
const stockAdjustmentSchema = new mongoose.Schema(
  {
    ingredient: { type: mongoose.Schema.Types.ObjectId, ref: 'Ingredient', required: true, index: true },
    delta: { type: Number, required: true },
    reason: { type: String, enum: ['restock', 'waste', 'correction'], required: true },
    note: { type: String, trim: true, maxlength: 300 },
    stockAfter: { type: Number, required: true },
    adjustedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

module.exports = mongoose.model('StockAdjustment', stockAdjustmentSchema);
