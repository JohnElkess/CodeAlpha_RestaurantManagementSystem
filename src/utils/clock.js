'use strict';

/** Production clock. Services never call `new Date()` themselves, so tests can control time. */
class SystemClock {
  now() {
    return new Date();
  }
}

/** Test clock that only moves when told to. */
class FixedClock {
  constructor(initial) {
    this.set(initial);
  }

  set(value) {
    this._ms = new Date(value).getTime();
    if (Number.isNaN(this._ms)) throw new Error(`FixedClock: invalid date ${value}`);
  }

  advanceMinutes(minutes) {
    this._ms += minutes * 60 * 1000;
  }

  now() {
    return new Date(this._ms);
  }
}

module.exports = { SystemClock, FixedClock };
