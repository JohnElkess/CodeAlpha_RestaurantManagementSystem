'use strict';
const { ORDER_STATUS: O, RESERVATION_STATUS: R } = require('./constants');

/**
 * Table-driven state machines. One declarative table per aggregate instead of if/else chains spread
 * over services: it is easy to read, easy to test and the single source of truth for "what may happen next".
 */
class StateMachine {
  constructor(name, transitions) {
    this.name = name;
    this.transitions = transitions;
  }

  next(from) {
    return this.transitions[from] || [];
  }

  can(from, to) {
    return this.next(from).includes(to);
  }

  /** Statuses from which `to` can be reached. */
  sourcesOf(to) {
    return Object.keys(this.transitions).filter((from) => this.can(from, to));
  }
}

const orderMachine = new StateMachine('order', {
  [O.PLACED]: [O.PREPARING, O.CANCELLED, O.UNCOLLECTED],
  [O.PREPARING]: [O.READY, O.CANCELLED, O.UNCOLLECTED],
  [O.READY]: [O.SERVED, O.CANCELLED, O.UNCOLLECTED],
  [O.UNCOLLECTED]: [O.SERVED], // collected late
  [O.SERVED]: [],
  [O.CANCELLED]: [],
});

const reservationMachine = new StateMachine('reservation', {
  [R.CONFIRMED]: [R.SEATED, R.CANCELLED, R.NO_SHOW],
  [R.SEATED]: [R.COMPLETED],
  [R.COMPLETED]: [],
  [R.CANCELLED]: [],
  [R.NO_SHOW]: [],
});

module.exports = { StateMachine, orderMachine, reservationMachine };
