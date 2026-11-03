'use strict';
const { BackgroundJob } = require('./background_job');

/** Reservations still `confirmed` 20 minutes after their start become `no_show`; the table and the pre-order stock are freed. */
class NoShowJob extends BackgroundJob {
  constructor({ reservationRepo, reservationService, logger }) {
    super({ name: 'no-show', logger });
    this.repo = reservationRepo;
    this.service = reservationService;
  }

  async execute() {
    const candidates = await this.repo.findNoShowCandidates(this.service.noShowCutoff());
    let changed = 0;
    for (const { _id } of candidates) if (await this.service.markNoShow(_id)) changed += 1;
    return changed;
  }
}

module.exports = { NoShowJob };
