'use strict';
const mongoose = require('mongoose');
const { ORDER_TYPES, PICKUP_TYPES, ORDER_STATUS, HOLD_STATE } = require('../domain/constants');

function isDineIn() {
  return this.type === ORDER_TYPES.DINE_IN;
}
function isTakeaway() {
  return this.type === ORDER_TYPES.TAKEAWAY;
}

const orderItemSchema = new mongoose.Schema(
  {
    menuItem: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true },
    name: { type: String, required: true }, // snapshot at order time
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 }, // snapshot at order time
  },
  { _id: false }
);

const holdLineSchema = new mongoose.Schema(
  {
    ingredient: { type: mongoose.Schema.Types.ObjectId, ref: 'Ingredient', required: true },
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: Object.values(ORDER_TYPES), required: true },
    // Required for dine-in, absent for takeaway (scope section 5). Enforced here so no code path can break the rule.
    reservation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Reservation',
      required: [isDineIn, 'a dine-in order needs a reservation'],
    },
    items: {
      type: [orderItemSchema],
      validate: { validator: (v) => v.length > 0, message: 'an order needs at least one item' },
    },
    pickupType: { type: String, enum: Object.values(PICKUP_TYPES), required: [isTakeaway, 'a takeaway order needs a pickupType'] },
    pickupTime: { type: Date, required: [isTakeaway, 'a takeaway order needs a pickupTime'] }, // ASAP orders get an estimated time
    status: { type: String, enum: Object.values(ORDER_STATUS), default: ORDER_STATUS.PLACED },
    total: { type: Number, required: true, min: 0 }, // computed server-side
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // The moment the order is for: reservation start (dine-in), pickup time (scheduled takeaway) or creation
    // time (ASAP). Reports group by it, so a pre-order is counted on the day of the meal.
    scheduledFor: { type: Date, required: true },

    // Exact ingredient quantities held for this order. Stored (not recomputed from the recipe) so that a
    // later recipe change can never make a release or consume wrong. `version` guards concurrent edits.
    hold: {
      state: { type: String, enum: Object.values(HOLD_STATE), default: HOLD_STATE.HELD },
      version: { type: Number, default: 0 },
      lines: { type: [holdLineSchema], default: [] },
    },

    preparingAt: Date,
    readyAt: Date,
    servedAt: Date,
    cancelledAt: Date,
    uncollectedAt: Date,
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.hold;
        delete ret.__v;
        return ret;
      },
    },
  }
);

orderSchema.index({ status: 1, createdAt: 1 });
orderSchema.index({ pickupTime: 1 });
orderSchema.index({ customer: 1, createdAt: -1 });
orderSchema.index({ reservation: 1 });
orderSchema.index({ scheduledFor: 1 });

module.exports = mongoose.model('Order', orderSchema);
