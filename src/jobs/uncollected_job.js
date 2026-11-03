'use strict';
const { BackgroundJob } = require('./background_job');
const { addMinutes } = require('../utils/time');

/** Takeaway orders not collected 20 minutes after pickupTime are flagged `uncollected` for staff. */
class UncollectedJob extends BackgroundJob {
  constructor({ orderRepo, orderService, clock, business, logger }) {
    super({ name: 'uncollected', logger });
    this.repo = orderRepo;
    this.service = orderService;
    this.clock = clock;
    this.business = business;
  }

  async execute() {
    const cutoff = addMinutes(this.clock.now(), -this.business.takeaway.uncollectedGraceMinutes);
    const candidates = await this.repo.findUncollectedCandidates(cutoff);
    let changed = 0;
    for (const { _id } of candidates) if (await this.service.flagUncollected(_id, cutoff)) changed += 1;
    return changed;
  }
}

module.exports = { UncollectedJob };
