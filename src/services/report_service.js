'use strict';
const MenuItem = require('../models/MenuItem');
const { fromMinor } = require('../utils/money');
const { dayBounds } = require('../utils/time');
const { BadRequestError } = require('../utils/errors');

class ReportService {
  constructor({ orderRepo, ingredientService, business, clock }) {
    this.orders = orderRepo;
    this.ingredients = ingredientService;
    this.business = business;
    this.clock = clock;
  }

  /**
   * Revenue, order count and per-item quantities for one local day (the business day equals the calendar day).
   * Cancelled orders are excluded. An order counts on the day it is FOR (see Order.scheduledFor).
   */
  async dailySales(date) {
    const bounds = dayBounds(date, this.business.timezone);
    if (!bounds) throw new BadRequestError('INVALID_DATE', 'date must be a real calendar date in YYYY-MM-DD format');

    const [totals, items, byType, byStatus] = await this.orders.salesBetween(bounds.start, bounds.end);
    const summary = totals[0] || { orders: 0, revenueMinor: 0 };
    const counts = (rows) => Object.fromEntries(rows.map((r) => [r._id, r.count]));
    return {
      date,
      timezone: this.business.timezone,
      totalSales: fromMinor(summary.revenueMinor),
      orderCount: summary.orders,
      items: items.map((i) => ({ menuItem: i._id, name: i.name, quantity: i.quantity, revenue: fromMinor(i.revenueMinor) })),
      byType: counts(byType),
      byStatus: counts(byStatus),
    };
  }

  /** Low-stock ingredients, worst first, with the menu items they affect. */
  async lowStock() {
    const alerts = await this.ingredients.alerts();
    const affected = await MenuItem.find({ 'recipe.ingredient': { $in: alerts.map((a) => a._id) } }).select('name recipe.ingredient').lean();
    const ingredients = alerts
      .map((a) => ({
        ...a,
        affectedMenuItems: affected.filter((m) => m.recipe.some((l) => String(l.ingredient) === String(a._id))).map((m) => m.name),
      }))
      .sort((x, y) => y.shortfall - x.shortfall);
    return { generatedAt: this.clock.now(), count: ingredients.length, ingredients };
  }
}

module.exports = { ReportService };
