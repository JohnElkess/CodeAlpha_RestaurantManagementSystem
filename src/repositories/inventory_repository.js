'use strict';
const Ingredient = require('../models/Ingredient');

/**
 * Persistence of stock counters. Every method is built from SINGLE-DOCUMENT atomic updates, because MongoDB
 * guarantees atomicity per document: the availability check and the counter change happen in one operation,
 * so two simultaneous orders can never both take the last portion (scope section 4, concurrency requirement).
 *
 * Multi-ingredient operations are a saga: take ingredients one by one and, if one is short, put back what was
 * already taken (a compensating action). This needs no replica set or transaction.
 *
 * A "line" is { ingredient: ObjectId|string, quantity: positive integer }.
 */
class InventoryRepository {
  /** Merge duplicate ingredients and drop zero lines. */
  static normalize(lines) {
    const merged = new Map();
    for (const { ingredient, quantity } of lines) {
      const key = String(ingredient);
      merged.set(key, (merged.get(key) || 0) + quantity);
    }
    return [...merged].filter(([, q]) => q > 0).map(([ingredient, quantity]) => ({ ingredient, quantity }));
  }

  /**
   * Atomically hold `quantity` of one ingredient, only if stock - reserved >= quantity.
   * @returns {Promise<boolean>} true when the hold was taken
   */
  async tryReserveOne({ ingredient, quantity }) {
    const result = await Ingredient.updateOne(
      { _id: ingredient, $expr: { $gte: [{ $subtract: ['$stock', '$reserved'] }, quantity] } },
      { $inc: { reserved: quantity } }
    );
    return result.modifiedCount === 1;
  }

  /**
   * All-or-nothing hold of several ingredients.
   * @returns {Promise<{ok: true} | {ok: false, shortages: Array}>}
   */
  async reserve(lines) {
    // Always take ingredients in the same (id) order. Two orders that need the same ingredients then compete for the
    // first one and the loser stops immediately, instead of each holding half of what the other needs.
    const wanted = InventoryRepository.normalize(lines).sort((a, b) => a.ingredient.localeCompare(b.ingredient));
    const taken = [];
    for (const line of wanted) {
      if (await this.tryReserveOne(line)) {
        taken.push(line);
        continue;
      }
      await this.release(taken); // compensate: put back what this call already took
      return { ok: false, shortages: await this.describeShortages(wanted) };
    }
    return { ok: true };
  }

  /** Give held quantities back (never drops below zero). */
  async release(lines) {
    await Promise.all(
      InventoryRepository.normalize(lines).map(({ ingredient, quantity }) =>
        Ingredient.updateOne(
          { _id: ingredient },
          [{ $set: { reserved: { $max: [0, { $subtract: ['$reserved', quantity] }] } } }],
          { updatePipeline: true } // Mongoose requires this flag to accept an aggregation-pipeline update
        )
      )
    );
  }

  /** Turn a hold into a real deduction: stock and reserved both go down by the same amount. */
  async consume(lines) {
    await Promise.all(
      InventoryRepository.normalize(lines).map(({ ingredient, quantity }) =>
        Ingredient.updateOne(
          { _id: ingredient },
          [
            {
              $set: {
                stock: { $max: [0, { $subtract: ['$stock', quantity] }] },
                reserved: { $max: [0, { $subtract: ['$reserved', quantity] }] },
              },
            },
          ],
          { updatePipeline: true }
        )
      )
    );
  }

  /**
   * Manual adjustment (restock, waste, correction). Refuses to push stock below what is already held for
   * pending orders, so held orders can always be fulfilled.
   * @returns {Promise<object|null>} the updated ingredient, or null if the guard rejected it / not found
   */
  adjustStock(ingredientId, delta) {
    return Ingredient.findOneAndUpdate(
      { _id: ingredientId, $expr: { $gte: [{ $add: ['$stock', delta] }, '$reserved'] } },
      { $inc: { stock: delta } },
      { returnDocument: 'after' }
    );
  }

  /** Read-only: which of the requested lines are currently short (used to build the 409 error). */
  async describeShortages(lines) {
    const ids = lines.map((l) => l.ingredient);
    const docs = await Ingredient.find({ _id: { $in: ids } }).lean();
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    const shortages = [];
    for (const { ingredient, quantity } of lines) {
      const doc = byId.get(String(ingredient));
      const available = doc ? doc.stock - doc.reserved : 0;
      if (!doc || available < quantity) {
        shortages.push({
          ingredient: String(ingredient),
          name: doc ? doc.name : 'unknown ingredient',
          unit: doc ? doc.unit : undefined,
          needed: quantity,
          available: Math.max(0, available),
        });
      }
    }
    return shortages;
  }

  findByIds(ids) {
    return Ingredient.find({ _id: { $in: ids } }).lean();
  }

  /** Ingredients whose available quantity is at or below their threshold. */
  findLowStock() {
    return Ingredient.find({ $expr: { $lte: [{ $subtract: ['$stock', '$reserved'] }, '$lowStockThreshold'] } })
      .sort({ name: 1 })
      .lean({ virtuals: false });
  }
}

module.exports = { InventoryRepository };
