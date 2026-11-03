'use strict';

/** Money is computed in integer minor units (piasters/cents) so totals never suffer float drift. */
const toMinor = (amount) => Math.round(amount * 100);
const fromMinor = (minor) => minor / 100;

/** True for finite, non-negative numbers with at most two decimals. */
function isValidPrice(value) {
  return Number.isFinite(value) && value >= 0 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;
}

module.exports = { toMinor, fromMinor, isValidPrice };
