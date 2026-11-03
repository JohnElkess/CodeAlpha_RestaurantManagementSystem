'use strict';
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { env } = require('../config/env');
const { ROLES } = require('../domain/constants');
const { normalizePhone } = require('../utils/phone');
const { hashPassword, verifyPassword, DUMMY_HASH } = require('../utils/password');
const { isDuplicateKey, duplicateField } = require('../utils/mongo_errors');
const { ConflictError, UnauthorizedError, BadRequestError } = require('../utils/errors');

/**
 * Note on time: token and password-change timestamps use the real system clock on purpose. JWT `iat` is
 * stamped by the library with real time, so comparing it with a business clock would be meaningless.
 */
class AuthService {
  signToken(user) {
    return jwt.sign({ role: user.role }, env.JWT_SECRET, { subject: String(user._id), expiresIn: env.JWT_EXPIRES_IN });
  }

  async register({ name, phone, email, password }) {
    try {
      const user = await User.create({
        name,
        phone,
        email,
        passwordHash: await hashPassword(password),
        role: ROLES.CUSTOMER, // self-registration can only ever create customers
      });
      return { user, token: this.signToken(user) };
    } catch (err) {
      if (isDuplicateKey(err)) {
        const field = duplicateField(err) === 'email' ? 'EMAIL' : 'PHONE';
        throw new ConflictError(`${field}_TAKEN`, `An account with this ${field.toLowerCase()} already exists`);
      }
      throw err;
    }
  }

  async login({ identifier, password }) {
    const query = identifier.includes('@')
      ? { email: identifier.trim().toLowerCase() }
      : { phone: normalizePhone(identifier, env.DEFAULT_COUNTRY_CODE) };

    const user = query.phone === null ? null : await User.findOne(query).select('+passwordHash');
    // Always run one bcrypt comparison so response time does not reveal whether the account exists.
    const passwordOk = await verifyPassword(password, user ? user.passwordHash : DUMMY_HASH);
    if (!user || !passwordOk) throw new UnauthorizedError('Invalid credentials', 'INVALID_CREDENTIALS');

    return { user, token: this.signToken(user), mustChangePassword: user.mustChangePassword };
  }

  async changePassword(userId, { currentPassword, newPassword }) {
    const user = await User.findById(userId).select('+passwordHash');
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new UnauthorizedError('Current password is incorrect', 'INVALID_CREDENTIALS');
    }
    if (currentPassword === newPassword) {
      throw new BadRequestError('PASSWORD_UNCHANGED', 'The new password must be different from the current one');
    }
    user.passwordHash = await hashPassword(newPassword);
    user.mustChangePassword = false;
    user.passwordChangedAt = new Date(); // revokes every token issued before this moment
    await user.save();
    return { user, token: this.signToken(user) };
  }

  getProfile(userId) {
    return User.findById(userId);
  }

  /** Verify a bearer token and load the account it belongs to. Role changes apply immediately. */
  async authenticateToken(token) {
    let payload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET);
    } catch {
      throw new UnauthorizedError('Invalid or expired token', 'INVALID_TOKEN');
    }
    const user = await User.findById(payload.sub);
    if (!user) throw new UnauthorizedError('This account no longer exists', 'INVALID_TOKEN');
    if (user.passwordChangedAt && payload.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) {
      throw new UnauthorizedError('The password was changed, please log in again', 'TOKEN_REVOKED');
    }
    return { id: String(user._id), role: user.role, name: user.name, mustChangePassword: user.mustChangePassword };
  }
}

module.exports = { AuthService };
