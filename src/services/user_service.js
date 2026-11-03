'use strict';
const User = require('../models/User');
const { env } = require('../config/env');
const { ROLES } = require('../domain/constants');
const { normalizePhone } = require('../utils/phone');
const { generateTemporaryPassword, hashPassword } = require('../utils/password');
const { isDuplicateKey, duplicateField } = require('../utils/mongo_errors');
const { ConflictError, ForbiddenError, NotFoundError, BadRequestError } = require('../utils/errors');

class UserService {
  /** Staff register a walk-in or phone-in guest. The temporary password is returned ONCE and only its hash is stored. */
  async createGuest(actor, { name, phone, email }) {
    const temporaryPassword = generateTemporaryPassword();
    try {
      const user = await User.create({
        name,
        phone,
        email,
        passwordHash: await hashPassword(temporaryPassword),
        role: ROLES.CUSTOMER,
        mustChangePassword: true,
        createdBy: actor.id,
      });
      return { user, temporaryPassword };
    } catch (err) {
      if (isDuplicateKey(err)) {
        const field = duplicateField(err) === 'email' ? 'EMAIL' : 'PHONE';
        throw new ConflictError(`${field}_TAKEN`, `A customer with this ${field.toLowerCase()} already exists. Search for them instead`);
      }
      throw err;
    }
  }

  /** Look up customers by phone and/or email (exact match, customers only). */
  async searchCustomers({ phone, email }) {
    const or = [];
    if (phone) {
      const normalized = normalizePhone(phone, env.DEFAULT_COUNTRY_CODE);
      if (normalized) or.push({ phone: normalized });
    }
    if (email) or.push({ email: email.trim().toLowerCase() });
    if (!or.length) return [];
    return User.find({ role: ROLES.CUSTOMER, $or: or }).limit(10);
  }

  async setRole(actor, targetId, role) {
    if (String(targetId) === String(actor.id)) {
      throw new ForbiddenError('You cannot change your own role', 'CANNOT_CHANGE_OWN_ROLE');
    }
    const user = await User.findByIdAndUpdate(targetId, { role }, { returnDocument: 'after' });
    if (!user) throw new NotFoundError('User not found', 'USER_NOT_FOUND');
    return user;
  }

  /** Forgotten password: staff (customers only) or admin (anyone else) issue a new temporary password. */
  async resetPassword(actor, targetId) {
    if (String(targetId) === String(actor.id)) {
      throw new BadRequestError('USE_CHANGE_PASSWORD', 'Use the change-password endpoint for your own account');
    }
    const target = await User.findById(targetId);
    if (!target) throw new NotFoundError('User not found', 'USER_NOT_FOUND');
    if (actor.role === ROLES.STAFF && target.role !== ROLES.CUSTOMER) {
      throw new ForbiddenError('Staff can only reset customer passwords');
    }
    const temporaryPassword = generateTemporaryPassword();
    target.passwordHash = await hashPassword(temporaryPassword);
    target.mustChangePassword = true;
    target.passwordChangedAt = new Date(); // logs the user out everywhere
    await target.save();
    return { user: target, temporaryPassword };
  }
}

module.exports = { UserService };
