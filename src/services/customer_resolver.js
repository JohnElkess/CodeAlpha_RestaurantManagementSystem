'use strict';
const User = require('../models/User');
const { ROLES } = require('../domain/constants');
const { BadRequestError, ForbiddenError } = require('../utils/errors');

/**
 * "Whose booking/order is this?" Customers always act for themselves; staff and admins act on behalf of a
 * customer they name (scope 3: staff can act on behalf of any customer).
 */
class CustomerResolver {
  async resolve(actor, requestedId) {
    if (actor.role === ROLES.CUSTOMER) {
      if (requestedId && String(requestedId) !== String(actor.id)) {
        throw new ForbiddenError('Customers can only act for themselves');
      }
      return actor.id;
    }
    if (!requestedId) {
      throw new BadRequestError('CUSTOMER_REQUIRED', 'customerId is required when staff act on behalf of a customer');
    }
    const customer = await User.findOne({ _id: requestedId, role: ROLES.CUSTOMER }).select('_id');
    if (!customer) throw new BadRequestError('CUSTOMER_NOT_FOUND', 'No customer account with that id');
    return String(customer._id);
  }
}

module.exports = { CustomerResolver };
