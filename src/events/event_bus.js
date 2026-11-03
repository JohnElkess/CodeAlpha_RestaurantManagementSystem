'use strict';
const { logger: defaultLogger } = require('../utils/logger');

/**
 * Observer pattern. Publishers announce what happened; subscribers react without the publisher knowing
 * about them. `publish` waits for all subscribers (so consistency-critical reactions, such as refreshing menu
 * availability, are finished when the request ends) but a failing subscriber is logged and NEVER breaks
 * the request that triggered it. Subscribe to '*' to see every event.
 */
class EventBus {
  constructor({ logger = defaultLogger } = {}) {
    this.logger = logger;
    this.handlers = new Map();
  }

  subscribe(event, handler) {
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => this.handlers.set(event, (this.handlers.get(event) || []).filter((h) => h !== handler));
  }

  async publish(event, payload = {}) {
    const targets = [...(this.handlers.get(event) || []), ...(this.handlers.get('*') || [])];
    // `async` turns a synchronous throw inside a handler into a rejection, so it is caught like any other failure.
    const results = await Promise.allSettled(targets.map(async (handler) => handler(payload, event)));
    results.forEach((result) => {
      if (result.status === 'rejected') {
        this.logger.error('event handler failed', { event, error: result.reason && result.reason.message });
      }
    });
  }
}

module.exports = { EventBus };
