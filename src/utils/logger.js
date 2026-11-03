'use strict';
const { env } = require('../config/env');

const LEVELS = ['error', 'warn', 'info', 'debug'];

function createLogger(level = env.LOG_LEVEL || (env.NODE_ENV === 'test' ? 'silent' : 'info')) {
  const threshold = level === 'silent' ? -1 : LEVELS.indexOf(level);
  const write = (name) => (message, meta) => {
    if (LEVELS.indexOf(name) > threshold) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level: name, message, ...meta });
    (name === 'error' ? console.error : console.log)(line);
  };
  return { error: write('error'), warn: write('warn'), info: write('info'), debug: write('debug') };
}

module.exports = { createLogger, logger: createLogger() };
