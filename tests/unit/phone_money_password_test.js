const { normalizePhone } = require('../../src/utils/phone');
const { toMinor, fromMinor, isValidPrice } = require('../../src/utils/money');
const { generateTemporaryPassword, hashPassword, verifyPassword } = require('../../src/utils/password');

describe('normalizePhone', () => {
  test.each([
    ['01012345678', '+201012345678'],
    ['+20 101-234-5678', '+201012345678'],
    ['0020 1012345678', '+201012345678'],
    ['(010) 1234 5678', '+201012345678'],
    ['201012345678', '+201012345678'],
    ['+44 7911 123456', '+447911123456'],
  ])('%s -> %s', (input, expected) => expect(normalizePhone(input, '20')).toBe(expected));

  test.each([[''], ['abc'], ['123'], ['+0123456789'], [null], [undefined], [12345678901]])('rejects %p', (input) => {
    expect(normalizePhone(input, '20')).toBeNull();
  });

  test('uses the configured default country code for national numbers', () => {
    expect(normalizePhone('07911123456', '44')).toBe('+447911123456');
  });

  test('different spellings of one number normalise to the same value (so uniqueness works)', () => {
    expect(new Set(['01012345678', '+201012345678', '0020-101-234-5678'].map((p) => normalizePhone(p, '20'))).size).toBe(1);
  });
});

describe('money', () => {
  test('integer minor units avoid float drift', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(fromMinor(toMinor(0.1) + toMinor(0.2))).toBe(0.3);
    expect(fromMinor(toMinor(19.99) * 3)).toBe(59.97);
  });
  test('isValidPrice', () => {
    expect([0, 10, 19.99, 0.5].every(isValidPrice)).toBe(true);
    expect([-1, 1.005, NaN, Infinity, '5'].some(isValidPrice)).toBe(false);
  });
});

describe('passwords', () => {
  test('temporary passwords are 12 characters from an unambiguous alphabet and differ each time', () => {
    const a = generateTemporaryPassword();
    expect(a).toHaveLength(12);
    expect(a).toMatch(/^[A-HJ-NP-Za-km-z2-9]+$/);
    expect(generateTemporaryPassword()).not.toBe(a);
  });
  test('hash and verify', async () => {
    const hash = await hashPassword('secret-pass');
    expect(hash).not.toContain('secret-pass');
    expect(await verifyPassword('secret-pass', hash)).toBe(true);
    expect(await verifyPassword('other', hash)).toBe(false);
  });
});
