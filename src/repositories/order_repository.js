'use strict';
const Order = require('../models/Order');
const { ORDER_STATUS: S, HOLD_STATE } = require('../domain/constants');

const POPULATE_CUSTOMER = { path: 'customer', select: 'name phone email' };

// Aggregation expression: "release the hold only if it is still held".
const releaseIfHeld = { $cond: [{ $eq: ['$hold.state', HOLD_STATE.HELD] }, HOLD_STATE.RELEASED, '$hold.state'] };

/**
 * Persistence for orders. Status changes are "claims": one atomic findOneAndUpdate that only matches if the
 * order is still in an expected state and returns the document as it was BEFORE the change. The caller that
 * wins the claim is the only one that then touches inventory, so a hold is released or consumed exactly once,
 * even if a customer, a staff member and a background job act at the same moment.
 */
class OrderRepository {
  constructor({ clock }) {
    this.clock = clock;
  }

  create(data) {
    return Order.create(data);
  }

  findById(id) {
    return Order.findById(id).populate(POPULATE_CUSTOMER);
  }

  findRaw(id) {
    return Order.findById(id);
  }

  /** Claim `placed -> preparing`; the hold becomes consumed. Returns the order before the change. */
  claimPreparing(id) {
    return Order.findOneAndUpdate(
      { _id: id, status: S.PLACED, 'hold.state': HOLD_STATE.HELD },
      [{ $set: { status: S.PREPARING, preparingAt: this.clock.now(), 'hold.state': HOLD_STATE.CONSUMED } }],
      { returnDocument: 'before', updatePipeline: true }
    );
  }

  /** Claim a plain transition (no inventory effect): ready, served. `from` is one status or a list. */
  claimSimple(id, from, to, stampField) {
    return Order.findOneAndUpdate(
      { _id: id, status: { $in: [].concat(from) } },
      { $set: { status: to, [stampField]: this.clock.now() } },
      { returnDocument: 'before' }
    );
  }

  /** Claim cancellation. A hold that is still held is released; consumed stock is NOT restored. */
  claimCancel(id) {
    return Order.findOneAndUpdate(
      { _id: id, status: { $in: [S.PLACED, S.PREPARING, S.READY] } },
      [{ $set: { status: S.CANCELLED, cancelledAt: this.clock.now(), 'hold.state': releaseIfHeld } }],
      { returnDocument: 'before', updatePipeline: true }
    );
  }

  /** Claim "uncollected" for a takeaway whose pickup deadline passed. */
  claimUncollected(id, cutoff) {
    return Order.findOneAndUpdate(
      { _id: id, type: 'takeaway', status: { $in: [S.PLACED, S.PREPARING, S.READY] }, pickupTime: { $lte: cutoff } },
      [{ $set: { status: S.UNCOLLECTED, uncollectedAt: this.clock.now(), 'hold.state': releaseIfHeld } }],
      { returnDocument: 'before', updatePipeline: true }
    );
  }

  /**
   * Replace the items of an order that is still `placed`, guarded by the hold version so that a concurrent
   * edit or a move to `preparing` makes this update match nothing (returns null).
   */
  replaceItems(id, expectedVersion, { items, total, holdLines }) {
    return Order.findOneAndUpdate(
      { _id: id, status: S.PLACED, 'hold.state': HOLD_STATE.HELD, 'hold.version': expectedVersion },
      { $set: { items, total, 'hold.lines': holdLines }, $inc: { 'hold.version': 1 } },
      { returnDocument: 'after' }
    );
  }

  async list({ customerId, status, type, from, to, page, limit }) {
    const filter = {};
    if (customerId) filter.customer = customerId;
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (from || to) {
      filter.scheduledFor = {};
      if (from) filter.scheduledFor.$gte = from;
      if (to) filter.scheduledFor.$lt = to;
    }
    const [items, total] = await Promise.all([
      Order.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate(POPULATE_CUSTOMER),
      Order.countDocuments(filter),
    ]);
    return { items, total };
  }

  /** Orders of a reservation that are still open (not served/cancelled/uncollected). */
  findOpenByReservation(reservationId) {
    return Order.find({ reservation: reservationId, status: { $in: [S.PLACED, S.PREPARING, S.READY] } }).select('_id');
  }

  /** Takeaway orders past their pickup deadline. */
  findUncollectedCandidates(cutoff) {
    return Order.find({
      type: 'takeaway',
      status: { $in: [S.PLACED, S.PREPARING, S.READY] },
      pickupTime: { $lte: cutoff },
    }).select('_id');
  }

  /** Sales aggregation for a [start, end) window. Cancelled orders are excluded. */
  salesBetween(start, end) {
    const match = { scheduledFor: { $gte: start, $lt: end }, status: { $ne: S.CANCELLED } };
    return Promise.all([
      Order.aggregate([
        { $match: match },
        { $group: { _id: null, orders: { $sum: 1 }, revenueMinor: { $sum: { $round: [{ $multiply: ['$total', 100] }, 0] } } } },
      ]),
      Order.aggregate([
        { $match: match },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.menuItem',
            name: { $last: '$items.name' },
            quantity: { $sum: '$items.quantity' },
            revenueMinor: {
              $sum: { $round: [{ $multiply: [{ $multiply: ['$items.unitPrice', 100] }, '$items.quantity'] }, 0] },
            },
          },
        },
        { $sort: { quantity: -1, name: 1 } },
      ]),
      Order.aggregate([{ $match: match }, { $group: { _id: '$type', count: { $sum: 1 } } }]),
      Order.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    ]);
  }
}

module.exports = { OrderRepository };
