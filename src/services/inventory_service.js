'use strict';
const { InventoryRepository } = require('../repositories/inventory_repository');
const { ConflictError } = require('../utils/errors');
const EVENTS = require('../events/events');

/** Plain { ingredient, quantity } lines from Mongoose arrays or lean objects. */
const toLines = (lines) => lines.map((l) => ({ ingredient: String(l.ingredient), quantity: l.quantity }));

/**
 * Hold -> consume -> release lifecycle of ingredients (scope section 4). Thin domain layer over the atomic
 * repository: turns shortages into a 409 and announces every stock change.
 */
class InventoryService {
  constructor({ inventoryRepo, eventBus }) {
    this.repo = inventoryRepo;
    this.eventBus = eventBus;
  }

  /** Ingredient quantities needed for [{ recipe, quantity }] (portions of each menu item), merged per ingredient. */
  static requirementFor(entries) {
    const lines = entries.flatMap(({ recipe, quantity }) =>
      recipe.map((r) => ({ ingredient: String(r.ingredient), quantity: r.quantityPerPortion * quantity }))
    );
    return InventoryRepository.normalize(lines);
  }

  /** What to take and what to give back to move a hold from `oldLines` to `newLines`. */
  diff(oldLines, newLines) {
    const before = new Map(toLines(oldLines).map((l) => [l.ingredient, l.quantity]));
    const after = new Map(toLines(newLines).map((l) => [l.ingredient, l.quantity]));
    const increases = [];
    const decreases = [];
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const delta = (after.get(id) || 0) - (before.get(id) || 0);
      if (delta > 0) increases.push({ ingredient: id, quantity: delta });
      if (delta < 0) decreases.push({ ingredient: id, quantity: -delta });
    }
    return { increases, decreases };
  }

  async reserve(lines) {
    const wanted = InventoryRepository.normalize(toLines(lines));
    if (!wanted.length) return;
    const result = await this.repo.reserve(wanted);
    if (!result.ok) {
      const names = result.shortages.map((s) => s.name).join(', ');
      throw new ConflictError('INSUFFICIENT_STOCK', `Not enough stock for: ${names}`, { shortages: result.shortages });
    }
    await this.announce(wanted);
  }

  async release(lines) {
    const given = InventoryRepository.normalize(toLines(lines));
    if (!given.length) return;
    await this.repo.release(given);
    await this.announce(given);
  }

  async consume(lines) {
    const used = InventoryRepository.normalize(toLines(lines));
    if (!used.length) return;
    await this.repo.consume(used);
    await this.announce(used);
  }

  announce(lines) {
    return this.eventBus.publish(EVENTS.INVENTORY_CHANGED, { ingredientIds: lines.map((l) => String(l.ingredient)) });
  }
}

module.exports = { InventoryService, toLines };
