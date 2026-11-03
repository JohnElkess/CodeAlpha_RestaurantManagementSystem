// Runs before every test file. Tests never read a developer's .env (see src/config/env.js).
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_secret_for_jest_0123456789';
process.env.JWT_EXPIRES_IN = '1d';
process.env.BCRYPT_ROUNDS = '4'; // fast hashing in tests
process.env.TIMEZONE = 'Africa/Cairo';
process.env.DEFAULT_COUNTRY_CODE = '20';
process.env.ENABLE_JOBS = 'false';
process.env.CORS_ORIGIN = '';
process.env.ADMIN_NAME = 'Administrator';
process.env.ADMIN_PHONE = '01000000000';
process.env.ADMIN_EMAIL = 'admin@example.com';
process.env.ADMIN_PASSWORD = 'AdminPass123';
