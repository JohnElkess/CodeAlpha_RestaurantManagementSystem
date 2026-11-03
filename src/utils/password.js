'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { env } = require('../config/env');

// No look-alike characters (0/O, 1/l/I) because staff read this password out loud to guests.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function generateTemporaryPassword(length = 12) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

const hashPassword = (plain) => bcrypt.hash(plain, env.BCRYPT_ROUNDS);
const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

// Compared against when the account does not exist, so login timing does not reveal valid accounts.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 4);

module.exports = { generateTemporaryPassword, hashPassword, verifyPassword, DUMMY_HASH };
