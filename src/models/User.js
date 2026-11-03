'use strict';
const mongoose = require('mongoose');
const { ROLE_VALUES, ROLES } = require('../domain/constants');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    phone: { type: String, required: true, unique: true, trim: true }, // stored normalised, see utils/phone
    email: { type: String, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLE_VALUES, default: ROLES.CUSTOMER, required: true },
    mustChangePassword: { type: Boolean, default: false },
    passwordChangedAt: { type: Date }, // tokens issued before this moment are rejected
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.passwordHash;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Email is optional: unique only when present (partial index ignores users without one).
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });

module.exports = mongoose.model('User', userSchema);
