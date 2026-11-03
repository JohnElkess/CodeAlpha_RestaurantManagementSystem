'use strict';
const cron = require('node-cron');

/** Runs every job once a minute (scope 7.4). Returns a function that stops the schedule. */
function startJobs({ jobs, logger }) {
  const task = cron.schedule('* * * * *', async () => {
    for (const job of jobs) await job.run();
  });
  logger.info('background jobs scheduled', { jobs: jobs.map((j) => j.name), every: '1 minute' });
  return () => task.stop();
}

module.exports = { startJobs };
