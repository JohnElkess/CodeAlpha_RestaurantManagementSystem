'use strict';
const path = require('path');
const { z } = require('zod');
const { DateTime } = require('luxon');

// Tests set their own environment; never let a developer's .env leak into them.
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });
}

const validZone = (zone) => DateTime.local().setZone(zone).isValid;

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGO_URI: z.string().min(1).default('mongodb://localhost:27017/restaurant'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('1d'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),
  TIMEZONE: z.string().default('Africa/Cairo').refine(validZone, 'TIMEZONE must be a valid IANA zone'),
  DEFAULT_COUNTRY_CODE: z.string().regex(/^\d{1,3}$/, 'digits only, no +').default('20'),
  CORS_ORIGIN: z.string().default(''),
  ENABLE_JOBS: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  LOG_LEVEL: z.enum(['silent', 'error', 'warn', 'info', 'debug']).optional(),
  ADMIN_NAME: z.string().optional(),
  ADMIN_PHONE: z.string().optional(),
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
});

/** Parse and validate environment variables. Empty strings count as "not set". */
function loadEnv(source = process.env) {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return Object.freeze(parsed.data);
}

module.exports = { loadEnv, env: loadEnv() };
