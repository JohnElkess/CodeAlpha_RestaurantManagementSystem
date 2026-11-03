'use strict';
const MenuItem = require('../models/MenuItem');
const { InventoryService, toLines } = require('./inventory_service');
const { orderMachine } = require('../domain/state_machines');
const { ORDER_STATUS: S, HOLD_STATE, ROLES } = require('../domain/constants');
const { BadRequestError, ConflictError, NotFoundError } = require('../utils/errors');
const { toMinor, fromMinor } = require('../utils/money');
const { dayBounds } = require('../utils/time');
const EVENTS = require('../events/events');

class OrderService {
  constructor({ orderRepo, orderPolicies, customers, inventory, eventBus, business }) {
    this.orders = orderRepo;
    this.policies = orderPolicies;
    this.customers = customers;
    this.inventory = inventory;
    this.eventBus = eventBus;
    this.business = business;
  }

  /**
   * Place a dine-in or takeaway order (scope 7.3):
   *   validate type rules -> check items are available -> hold ingredients atomically -> snapshot prices -> create.
   */
  async placeOrder(actor, input) {
    const customerId = await this.customers.resolve(actor, input.customerId);
    const typeFields = await this.policies.forType(input.type).prepare({ customerId, input });
    const { items, holdLines, total } = await this.buildItems(input.items);

    await this.inventory.reserve(holdLines); // throws 409 INSUFFICIENT_STOCK, holding nothing, if anything is short
    let order;
    try {
      order = await this.orders.create({
        customer: customerId,
        type: input.type,
        ...typeFields,
        items,
        total,
        status: S.PLACED,
        createdBy: actor.id,
        hold: { state: HOLD_STATE.HELD, version: 0, lines: holdLines },
      });
    } catch (err) {
      await this.inventory.release(holdLines); // do not leak a hold if saving the order failed
      throw err;
    }
    await this.eventBus.publish(EVENTS.ORDER_PLACED, { orderId: String(order._id), customerId: String(customerId), type: order.type });
    return this.orders.findById(order._id);
  }

  /**
   * Replace the items of an order before it reaches `preparing` (scope 4: "reserve or release only the
   * difference"). If the extra ingredients are not available the edit is rejected and the old hold stays intact.
   */
  async editItems(actor, orderId, input) {
    const order = await this.loadAccessible(actor, orderId);
    if (order.status !== S.PLACED) {
      throw new ConflictError('ORDER_NOT_EDITABLE', 'Items can only be changed before preparation starts');
    }
    const existing = new Map(order.items.map((i) => [String(i.menuItem), i]));
    const { items, holdLines, total } = await this.buildItems(input.items, { existing });
    const { increases, decreases } = this.inventory.diff(order.hold.lines, holdLines);

    await this.inventory.reserve(increases); // 1. take the extra (throws and changes nothing if short)
    const updated = await this.orders.replaceItems(order._id, order.hold.version, { items, total, holdLines });
    if (!updated) {
      // The order moved on (preparing, cancelled, edited elsewhere) while we were working: undo step 1.
      await this.inventory.release(increases);
      throw new ConflictError('ORDER_CHANGED', 'The order changed while you were editing it. Reload it and try again');
    }
    await this.inventory.release(decreases); // 3. give back what is no longer needed
    await this.eventBus.publish(EVENTS.ORDER_UPDATED, { orderId: String(order._id) });
    return this.orders.findById(order._id);
  }

  /** Staff moves an order forward: preparing (consumes the hold), ready, served. */
  async updateStatus(actor, orderId, target) {
    const from = orderMachine.sourcesOf(target);
    let before;
    if (target === S.PREPARING) {
      before = await this.orders.claimPreparing(orderId);
      if (before) await this.inventory.consume(toLines(before.hold.lines)); // hold becomes a real deduction
    } else {
      const stamp = target === S.READY ? 'readyAt' : 'servedAt';
      before = await this.orders.claimSimple(orderId, from, target, stamp);
    }
    if (!before) throw await this.transitionError(orderId, target);

    await this.eventBus.publish(EVENTS.ORDER_STATUS_CHANGED, { orderId: String(orderId), from: before.status, to: target });
    return this.orders.findById(orderId);
  }

  /** Owner, staff or admin. Before `preparing` the hold is released; after it, stock is not restored. */
  async cancelOrder(actor, orderId) {
    const order = await this.loadAccessible(actor, orderId);
    const before = await this.cancelClaim(order._id);
    if (!before) {
      const current = await this.orders.findRaw(order._id);
      throw new ConflictError('ORDER_NOT_CANCELLABLE', `A ${current.status} order cannot be cancelled`);
    }
    return this.orders.findById(order._id);
  }

  /** Used when a reservation is cancelled or becomes a no-show. */
  async cancelOpenOrdersOfReservation(reservationId) {
    const open = await this.orders.findOpenByReservation(reservationId);
    for (const { _id } of open) await this.cancelClaim(_id);
    return open.length;
  }

  /** Background job: a takeaway not collected in time is flagged; an order that was never made gives its hold back. */
  async flagUncollected(orderId, cutoff) {
    const before = await this.orders.claimUncollected(orderId, cutoff);
    if (!before) return false;
    if (before.hold.state === HOLD_STATE.HELD) await this.inventory.release(toLines(before.hold.lines));
    await this.eventBus.publish(EVENTS.ORDER_UNCOLLECTED, { orderId: String(orderId) });
    return true;
  }

  async getOrder(actor, orderId) {
    await this.loadAccessible(actor, orderId);
    return this.orders.findById(orderId);
  }

  async listOrders(actor, filters) {
    const { page, limit } = filters;
    const query = { ...filters };
    if (actor.role === ROLES.CUSTOMER) query.customerId = actor.id; // customers only ever see their own orders
    if (filters.date) {
      const bounds = dayBounds(filters.date, this.business.timezone);
      query.from = bounds.start;
      query.to = bounds.end;
    }
    const { items, total } = await this.orders.list(query);
    return { items, page, limit, total, pages: Math.ceil(total / limit) };
  }

  // ---- internals ----

  async cancelClaim(orderId) {
    const before = await this.orders.claimCancel(orderId);
    if (!before) return null;
    if (before.hold.state === HOLD_STATE.HELD) await this.inventory.release(toLines(before.hold.lines));
    await this.eventBus.publish(EVENTS.ORDER_CANCELLED, {
      orderId: String(orderId),
      stockRestored: before.hold.state === HOLD_STATE.HELD,
    });
    return before;
  }

  /** Someone else's order looks exactly like a missing one. */
  async loadAccessible(actor, orderId) {
    const order = await this.orders.findRaw(orderId);
    if (!order || (actor.role === ROLES.CUSTOMER && String(order.customer) !== String(actor.id))) {
      throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');
    }
    return order;
  }

  async transitionError(orderId, target) {
    const order = await this.orders.findRaw(orderId);
    if (!order) return new NotFoundError('Order not found', 'ORDER_NOT_FOUND');
    return new ConflictError('INVALID_STATUS_TRANSITION', `An order cannot move from "${order.status}" to "${target}"`, {
      from: order.status,
      to: target,
      allowedNext: orderMachine.next(order.status),
    });
  }

  /**
   * Turn requested [{menuItem, quantity}] into snapshot items, exact hold lines and a total.
   * New or increased lines must be available; lines that stay unchanged keep their original price snapshot.
   */
  async buildItems(requested, { existing = new Map() } = {}) {
    const wanted = new Map();
    for (const { menuItem, quantity } of requested) wanted.set(String(menuItem), (wanted.get(String(menuItem)) || 0) + quantity);

    if (wanted.size > this.business.order.maxLines) {
      throw new BadRequestError('TOO_MANY_LINES', `An order can have at most ${this.business.order.maxLines} different items`);
    }
    for (const quantity of wanted.values()) {
      if (quantity > this.business.order.maxQuantityPerLine) {
        throw new BadRequestError('QUANTITY_TOO_LARGE', `At most ${this.business.order.maxQuantityPerLine} portions of one item`);
      }
    }

    const menuItems = await MenuItem.find({ _id: { $in: [...wanted.keys()] } }).lean();
    if (menuItems.length !== wanted.size) {
      const found = new Set(menuItems.map((m) => String(m._id)));
      const missing = [...wanted.keys()].filter((id) => !found.has(id));
      throw new BadRequestError('MENU_ITEM_NOT_FOUND', 'Some menu items do not exist', { missing });
    }

    const unavailable = [];
    const items = [];
    const recipeEntries = [];
    let totalMinor = 0;
    for (const menuItem of menuItems) {
      const quantity = wanted.get(String(menuItem._id));
      const previous = existing.get(String(menuItem._id));
      const grows = !previous || quantity > previous.quantity;
      if (grows && !menuItem.isAvailable) unavailable.push({ id: String(menuItem._id), name: menuItem.name });

      const name = previous ? previous.name : menuItem.name;
      const unitPrice = previous ? previous.unitPrice : menuItem.price;
      items.push({ menuItem: menuItem._id, name, quantity, unitPrice });
      recipeEntries.push({ recipe: menuItem.recipe, quantity });
      totalMinor += toMinor(unitPrice) * quantity;
    }
    if (unavailable.length) {
      throw new ConflictError('MENU_ITEM_UNAVAILABLE', `Not available right now: ${unavailable.map((u) => u.name).join(', ')}`, { items: unavailable });
    }
    return { items, holdLines: InventoryService.requirementFor(recipeEntries), total: fromMinor(totalMinor) };
  }
}

module.exports = { OrderService };
