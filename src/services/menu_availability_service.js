'use strict';
const MenuItem = require('../models/MenuItem');
const Ingredient = require('../models/Ingredient');

/**
 * Keeps MenuItem.isAvailable in sync with stock (scope section 4, "Automatic menu availability").
 *
 *   outOfStock  = some recipe ingredient has available < quantityPerPortion      (automatic)
 *   isAvailable = !manuallyDisabled && !outOfStock                               (admin toggle + automatic)
 *
 * Two flags, so a stock replenishment never re-enables an item the admin switched off by hand.
 */
class MenuAvailabilityService {
  constructor() {
    this.queue = Promise.resolve();
  }

  static isOutOfStock(item, ingredientsById) {
    return item.recipe.some((line) => {
      const ingredient = ingredientsById.get(String(line.ingredient));
      const available = ingredient ? ingredient.stock - ingredient.reserved : 0;
      return available < line.quantityPerPortion;
    });
  }

  /**
   * Recompute availability for items that use any of `ingredientIds` (all items when omitted).
   * Refreshes run one after another so a slow, older refresh can never overwrite a newer result.
   */
  refresh(ingredientIds) {
    const run = () => this.recompute(ingredientIds);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async recompute(ingredientIds) {
    const filter = ingredientIds && ingredientIds.length ? { 'recipe.ingredient': { $in: ingredientIds } } : {};
    const items = await MenuItem.find(filter).lean();
    if (!items.length) return;

    const usedIds = [...new Set(items.flatMap((i) => i.recipe.map((l) => String(l.ingredient))))];
    const ingredients = await Ingredient.find({ _id: { $in: usedIds } }).lean();
    const byId = new Map(ingredients.map((i) => [String(i._id), i]));

    const operations = [];
    for (const item of items) {
      const outOfStock = MenuAvailabilityService.isOutOfStock(item, byId);
      const isAvailable = !item.manuallyDisabled && !outOfStock;
      if (outOfStock !== item.outOfStock || isAvailable !== item.isAvailable) {
        operations.push({ updateOne: { filter: { _id: item._id }, update: { $set: { outOfStock, isAvailable } } } });
      }
    }
    if (operations.length) await MenuItem.bulkWrite(operations);
  }
}

module.exports = { MenuAvailabilityService };
