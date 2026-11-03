'use strict';

/**
 * Normalise a phone number to "+<digits>" so that uniqueness and lookups are reliable:
 *   "01012345678"      -> "+201012345678"  (national format, default country code added)
 *   "+20 101-234-5678" -> "+201012345678"
 *   "0020 1012345678"  -> "+201012345678"
 * Returns null when the value cannot be a phone number.
 */
function normalizePhone(raw, defaultCountryCode = '20') {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().replace(/[\s().-]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;

  let digits;
  if (value.startsWith('+')) digits = value.slice(1);
  else if (value.startsWith('0')) digits = defaultCountryCode + value.slice(1);
  else digits = value; // assumed to already include the country code

  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

module.exports = { normalizePhone };
