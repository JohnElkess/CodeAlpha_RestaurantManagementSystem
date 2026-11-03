'use strict';
const { ForbiddenError, UnauthorizedError } = require('../utils/errors');

function bearerToken(req) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  return scheme === 'Bearer' && token ? token : null;
}

/**
 * Links of the middleware chain (Chain of Responsibility): authenticate -> authorize -> validate -> handler.
 * Each link either rejects the request or passes it on.
 */
function createAuthMiddleware({ authService }) {
  /** Requires a valid token. Guests with a temporary password may only reach routes that allow it. */
  const authenticate = ({ allowPasswordChange = false } = {}) => async (req, res, next) => {
    const token = bearerToken(req);
    if (!token) throw new UnauthorizedError();
    const user = await authService.authenticateToken(token);
    if (user.mustChangePassword && !allowPasswordChange) {
      throw new ForbiddenError('You must change your temporary password first', 'PASSWORD_CHANGE_REQUIRED');
    }
    req.user = user;
    next();
  };

  /** Token optional: anonymous visitors pass, but a bad token is still rejected. */
  const optional = async (req, res, next) => {
    const token = bearerToken(req);
    if (token) req.user = await authService.authenticateToken(token);
    next();
  };

  const authorize = (...roles) => (req, res, next) => {
    if (!roles.includes(req.user.role)) throw new ForbiddenError();
    next();
  };

  return { authenticate, optional, authorize };
}

module.exports = { createAuthMiddleware };
