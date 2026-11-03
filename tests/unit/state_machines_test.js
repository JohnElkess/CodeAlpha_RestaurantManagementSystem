const { orderMachine, reservationMachine } = require('../../src/domain/state_machines');
const { ORDER_STATUS: O, RESERVATION_STATUS: R } = require('../../src/domain/constants');

describe('order state machine', () => {
  test('the happy path is placed -> preparing -> ready -> served', () => {
    expect(orderMachine.can(O.PLACED, O.PREPARING)).toBe(true);
    expect(orderMachine.can(O.PREPARING, O.READY)).toBe(true);
    expect(orderMachine.can(O.READY, O.SERVED)).toBe(true);
  });
  test('no skipping and no going back', () => {
    expect(orderMachine.can(O.PLACED, O.READY)).toBe(false);
    expect(orderMachine.can(O.PLACED, O.SERVED)).toBe(false);
    expect(orderMachine.can(O.READY, O.PREPARING)).toBe(false);
  });
  test('served and cancelled are final', () => {
    expect(orderMachine.next(O.SERVED)).toEqual([]);
    expect(orderMachine.next(O.CANCELLED)).toEqual([]);
  });
  test('cancel is possible until the food is served', () => {
    expect(orderMachine.sourcesOf(O.CANCELLED).sort()).toEqual([O.PLACED, O.PREPARING, O.READY].sort());
  });
  test('an uncollected order can still be handed over late', () => {
    expect(orderMachine.can(O.UNCOLLECTED, O.SERVED)).toBe(true);
    expect(orderMachine.sourcesOf(O.SERVED).sort()).toEqual([O.READY, O.UNCOLLECTED].sort());
  });
  test('unknown states have no way out', () => expect(orderMachine.next('???')).toEqual([]));
});

describe('reservation state machine', () => {
  test('confirmed can be seated, cancelled or become a no-show', () => {
    expect(reservationMachine.next(R.CONFIRMED).sort()).toEqual([R.CANCELLED, R.NO_SHOW, R.SEATED].sort());
  });
  test('only a seated reservation can be completed', () => {
    expect(reservationMachine.sourcesOf(R.COMPLETED)).toEqual([R.SEATED]);
  });
  test('only a confirmed reservation can be cancelled', () => {
    expect(reservationMachine.sourcesOf(R.CANCELLED)).toEqual([R.CONFIRMED]);
  });
  test.each([R.COMPLETED, R.CANCELLED, R.NO_SHOW])('%s is final', (status) => {
    expect(reservationMachine.next(status)).toEqual([]);
  });
});
