const { loadEnv } = require('../../src/config/env');

const valid = { JWT_SECRET: 'a_long_enough_secret_value' };

describe('loadEnv', () => {
  test('applies defaults', () => {
    const env = loadEnv(valid);
    expect(env).toMatchObject({ PORT: 3000, TIMEZONE: 'Africa/Cairo', DEFAULT_COUNTRY_CODE: '20', ENABLE_JOBS: true, BCRYPT_ROUNDS: 10 });
  });
  test('coerces numbers and booleans', () => {
    expect(loadEnv({ ...valid, PORT: '8080', ENABLE_JOBS: 'false' })).toMatchObject({ PORT: 8080, ENABLE_JOBS: false });
  });
  test('empty strings count as not set', () => {
    expect(loadEnv({ ...valid, PORT: '', ADMIN_EMAIL: '' }).PORT).toBe(3000);
  });
  test('a missing or short JWT_SECRET stops startup with a readable message', () => {
    expect(() => loadEnv({})).toThrow(/JWT_SECRET/);
    expect(() => loadEnv({ JWT_SECRET: 'short' })).toThrow(/at least 16/);
  });
  test('an invalid timezone or port is rejected', () => {
    expect(() => loadEnv({ ...valid, TIMEZONE: 'Mars/Phobos' })).toThrow(/TIMEZONE/);
    expect(() => loadEnv({ ...valid, PORT: '99999' })).toThrow(/PORT/);
  });
  test('the result is frozen', () => {
    expect(Object.isFrozen(loadEnv(valid))).toBe(true);
  });
});
