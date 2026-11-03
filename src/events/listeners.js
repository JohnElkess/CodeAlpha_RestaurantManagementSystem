'use strict';
const EVENTS = require('./events');

/**
 * Subscribers (the "observers"). Wiring lives here, in one place, so the services stay unaware of each other.
 */
function registerListeners({ eventBus, menuAvailability, inventoryRepo, logger }) {
  // 1. Stock moved: keep menu availability in sync, then look for ingredients that are running low.
  eventBus.subscribe(EVENTS.INVENTORY_CHANGED, async ({ ingredientIds }) => {
    await menuAvailability.refresh(ingredientIds);
    const low = (await inventoryRepo.findLowStock()).filter((i) => (ingredientIds || []).map(String).includes(String(i._id)));
    if (low.length) {
      await eventBus.publish(EVENTS.INVENTORY_LOW_STOCK, {
        ingredients: low.map((i) => ({ id: String(i._id), name: i.name, available: i.stock - i.reserved, threshold: i.lowStockThreshold })),
      });
    }
  });

  // 2. Low stock: this is where an email/Slack notification would plug in.
  eventBus.subscribe(EVENTS.INVENTORY_LOW_STOCK, ({ ingredients }) => {
    logger.warn('low stock', { ingredients });
  });

  // 3. Audit trail of everything else, at debug level.
  eventBus.subscribe('*', (payload, event) => {
    if (event !== EVENTS.INVENTORY_CHANGED) logger.debug('event', { event, ...payload });
  });
}

module.exports = { registerListeners };
