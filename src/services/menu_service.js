'use strict';
const MenuItem = require('../models/MenuItem');
const Ingredient = require('../models/Ingredient');
const { ROLES } = require('../domain/constants');
const { isDuplicateKey } = require('../utils/mongo_errors');
const { BadRequestError, ConflictError, NotFoundError } = require('../utils/errors');

class MenuService {
  constructor({ menuAvailability }) {
    this.menuAvailability = menuAvailability;
  }

  /** Customers and staff see the menu; only admins see recipes and the internal flags. */
  static present(item, actor) {
    const json = item.toJSON ? item.toJSON() : item;
    if (actor && actor.role === ROLES.ADMIN) return json;
    const { _id, name, description, price, category, isAvailable } = json;
    return { _id, name, description, price, category, isAvailable };
  }

  async list(actor) {
    const query = MenuItem.find().sort({ category: 1, name: 1 });
    if (actor && actor.role === ROLES.ADMIN) query.populate('recipe.ingredient', 'name unit');
    return (await query).map((item) => MenuService.present(item, actor));
  }

  async get(actor, id) {
    const query = MenuItem.findById(id);
    if (actor && actor.role === ROLES.ADMIN) query.populate('recipe.ingredient', 'name unit');
    const item = await query;
    if (!item) throw new NotFoundError('Menu item not found', 'MENU_ITEM_NOT_FOUND');
    return MenuService.present(item, actor);
  }

  async create(actor, data) {
    const recipe = await this.checkedRecipe(data.recipe);
    try {
      const item = await MenuItem.create({ ...data, recipe });
      await this.menuAvailability.refresh(recipe.map((l) => l.ingredient));
      return this.get(actor, item._id);
    } catch (err) {
      if (isDuplicateKey(err)) throw new ConflictError('MENU_ITEM_EXISTS', 'A menu item with this name already exists');
      throw err;
    }
  }

  /** Full update. Changing the price never touches past orders, they keep their own price snapshot. */
  async update(actor, id, data) {
    const recipe = await this.checkedRecipe(data.recipe);
    try {
      const item = await MenuItem.findByIdAndUpdate(id, { ...data, recipe }, { returnDocument: 'after', runValidators: true });
      if (!item) throw new NotFoundError('Menu item not found', 'MENU_ITEM_NOT_FOUND');
      await this.menuAvailability.refresh(recipe.map((l) => l.ingredient));
      return this.get(actor, id);
    } catch (err) {
      if (isDuplicateKey(err)) throw new ConflictError('MENU_ITEM_EXISTS', 'A menu item with this name already exists');
      throw err;
    }
  }

  /** Manual toggle by an admin. Stock can still make an enabled item unavailable. */
  async setAvailability(actor, id, isAvailable) {
    const item = await MenuItem.findByIdAndUpdate(id, { manuallyDisabled: !isAvailable }, { returnDocument: 'after' });
    if (!item) throw new NotFoundError('Menu item not found', 'MENU_ITEM_NOT_FOUND');
    await this.menuAvailability.refresh(item.recipe.map((l) => l.ingredient));
    return this.get(actor, id);
  }

  async checkedRecipe(recipe) {
    const ids = recipe.map((line) => String(line.ingredient));
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestError('DUPLICATE_RECIPE_INGREDIENT', 'An ingredient can appear only once in a recipe');
    }
    const found = await Ingredient.countDocuments({ _id: { $in: ids } });
    if (found !== ids.length) throw new BadRequestError('UNKNOWN_INGREDIENT', 'The recipe references an unknown ingredient');
    return recipe.map((line) => ({ ingredient: line.ingredient, quantityPerPortion: line.quantityPerPortion }));
  }
}

module.exports = { MenuService };
