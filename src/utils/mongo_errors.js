'use strict';

const isDuplicateKey = (err) => Boolean(err) && err.code === 11000;

/** Which field caused a duplicate-key error ("phone", "email", ...), or undefined. */
function duplicateField(err) {
  const pattern = err.keyPattern || err.keyValue || {};
  return Object.keys(pattern)[0];
}

module.exports = { isDuplicateKey, duplicateField };
