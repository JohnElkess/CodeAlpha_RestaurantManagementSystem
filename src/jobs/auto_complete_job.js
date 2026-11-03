'use strict';
const { BackgroundJob } = require('./background_job');

/** ASSUMPTION from the scope: seated reservations past their end time become `completed`. */
class AutoCompleteJob extends BackgroundJob {
  constructor({ reservationRepo, reservationService, clock, logger }) {
    super({ name: 'auto-complete', logger });
    this.repo = reservationRepo;
    this.service = reservationService;
    this.clock = clock;
  }

  async execute() {
    const overdue = await this.repo.findOverdueSeated(this.clock.now());
    let changed = 0;
    for (const { _id } of overdue) if (await this.service.autoComplete(_id)) changed += 1;
    return changed;
  }
}

module.exports = { AutoCompleteJob };
