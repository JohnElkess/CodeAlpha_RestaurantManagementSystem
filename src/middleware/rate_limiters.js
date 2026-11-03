'use strict';
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { env } = require('../config/env');

const reject = (req, res) =>
  res.status(429).json({ error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests, please try again later' } });

const base = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: reject,
  skip: () => env.NODE_ENV === 'test', // automated tests must not be throttled
};

/** Whole API: generous, stops floods. */
const apiLimiter = rateLimit({ ...base, windowMs: 15 * 60 * 1000, limit: 600 });

/** Login and register: 10 FAILED attempts per IP and account per 15 minutes. Successful logins are not counted. */
const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const who = String((req.body && (req.body.identifier || req.body.email || req.body.phone)) || '').toLowerCase();
    return `${ipKeyGenerator(req.ip)}|${who}`;
  },
});

module.exports = { apiLimiter, authLimiter };
