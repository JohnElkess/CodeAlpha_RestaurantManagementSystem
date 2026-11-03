'use strict';
const mongoose = require('mongoose');
const { env } = require('./config/env');
const { logger } = require('./utils/logger');
const { connectDatabase } = require('./config/db');
const { buildContainer } = require('./container');
const { createApp } = require('./app');
const { startJobs } = require('./jobs/scheduler');

async function main() {
  await connectDatabase(env.MONGO_URI);

  const container = buildContainer();
  const app = createApp(container);
  const server = app.listen(env.PORT, () => logger.info('server listening', { port: env.PORT, env: env.NODE_ENV }));

  let stopJobs = () => {};
  if (env.ENABLE_JOBS) stopJobs = startJobs({ jobs: Object.values(container.jobs), logger });

  // Finish in-flight requests, then close the database, so a restart never cuts a request in half.
  const shutdown = (signal) => {
    logger.info('shutting down', { signal });
    stopJobs();
    server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('startup failed', { error: err.message });
  process.exit(1);
});
