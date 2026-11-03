'use strict';

/**
 * Template for a scheduled job: subclasses implement `execute()` and return how many records they changed.
 * `run()` never throws and never overlaps itself, so one slow or failing run cannot stack up or crash the app.
 * Tests call `run()` directly with a fake clock instead of waiting for the scheduler.
 */
class BackgroundJob {
  constructor({ name, logger }) {
    this.name = name;
    this.logger = logger;
    this.running = false;
  }

  async run() {
    if (this.running) return 0;
    this.running = true;
    try {
      const changed = await this.execute();
      if (changed) this.logger.info('job finished', { job: this.name, changed });
      return changed;
    } catch (err) {
      this.logger.error('job failed', { job: this.name, error: err.message });
      return 0;
    } finally {
      this.running = false;
    }
  }

  async execute() {
    throw new Error('execute() must be implemented');
  }
}

module.exports = { BackgroundJob };
