'use strict';
const Ingredient = require('../models/Ingredient');
const MenuItem = require('../models/MenuItem');
const StockAdjustment = require('../models/StockAdjustment');
const EVENTS = require('../events/events');
const { isDuplicateKey } = require('../utils/mongo_errors');
const { ConflictError, NotFoundError } = require('../utils/errors');

class IngredientService {
  constructor({ inventoryRepo, eventBus }) {
    this.inventoryRepo = inventoryRepo;
    this.eventBus = eventBus;
  }

  list() {
    return Ingredient.find().sort({ name: 1 });
  }

  async create(data) {
    try {
      const ingredient = await Ingredient.create(data);
      await this.eventBus.publish(EVENTS.INVENTORY_CHANGED, { ingredientIds: [String(ingredient._id)] });
      return ingredient;
    } catch (err) {
      if (isDuplicateKey(err)) throw new ConflictError('INGREDIENT_EXISTS', 'An ingredient with this name already exists');
      throw err;
    }
  }

  /** Name, unit and threshold only. Stock changes go through `adjust`, so every change is audited. */
  async update(id, data) {
    const ingredient = await Ingredient.findById(id);
    if (!ingredient) throw new NotFoundError('Ingredient not found', 'INGREDIENT_NOT_FOUND');
    if (data.unit && data.unit !== ingredient.unit && (await MenuItem.exists({ 'recipe.ingredient': ingredient._id }))) {
      throw new ConflictError('INGREDIENT_IN_USE', 'The unit cannot change while the ingredient is used in a recipe');
    }
    try {
      ingredient.set(data);
      await ingredient.save();
    } catch (err) {
      if (isDuplicateKey(err)) throw new ConflictError('INGREDIENT_EXISTS', 'An ingredient with this name already exists');
      throw err;
    }
    await this.eventBus.publish(EVENTS.INVENTORY_CHANGED, { ingredientIds: [String(ingredient._id)] }); // threshold changed
    return ingredient;
  }

  /** Restock (+), waste (-) or correction (+/-). Cannot cut into quantities already held for pending orders. */
  async adjust(actor, id, { delta, reason, note }) {
    const updated = await this.inventoryRepo.adjustStock(id, delta);
    if (!updated) {
      const current = await Ingredient.findById(id);
      if (!current) throw new NotFoundError('Ingredient not found', 'INGREDIENT_NOT_FOUND');
      if (current.stock + delta < 0) {
        throw new ConflictError('STOCK_BELOW_ZERO', `Only ${current.stock} ${current.unit} in stock, cannot remove ${-delta}`, { stock: current.stock });
      }
      throw new ConflictError(
        'STOCK_BELOW_RESERVED',
        `Stock cannot go below the ${current.reserved} ${current.unit} already held for pending orders`,
        { stock: current.stock, reserved: current.reserved }
      );
    }
    await StockAdjustment.create({ ingredient: id, delta, reason, note, stockAfter: updated.stock, adjustedBy: actor.id });
    await this.eventBus.publish(EVENTS.INVENTORY_CHANGED, { ingredientIds: [String(id)] });
    return updated;
  }

  async adjustments(id) {
    if (!(await Ingredient.exists({ _id: id }))) throw new NotFoundError('Ingredient not found', 'INGREDIENT_NOT_FOUND');
    return StockAdjustment.find({ ingredient: id }).sort({ createdAt: -1 }).limit(200);
  }

  /** Ingredients at or below their low-stock threshold. */
  async alerts() {
    const items = await this.inventoryRepo.findLowStock();
    return items.map((i) => ({ ...i, available: i.stock - i.reserved, shortfall: i.lowStockThreshold - (i.stock - i.reserved) }));
  }
}

module.exports = { IngredientService };
