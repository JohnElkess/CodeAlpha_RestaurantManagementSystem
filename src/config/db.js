'use strict';
const mongoose = require('mongoose');
const { logger } = require('../utils/logger');

// Requiring the models registers their schemas, which `syncIndexes` below needs.
require('../models/User');
require('../models/Ingredient');
require('../models/StockAdjustment');
require('../models/MenuItem');
require('../models/Table');
require('../models/Reservation');
require('../models/Order');

/**
 * Connect and make sure every index exists BEFORE the app serves traffic. The unique "no_double_booking"
 * index is a correctness guarantee, so we wait for it instead of letting it build in the background.
 */
async function connectDatabase(uri) {
  await mongoose.connect(uri);
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  logger.info('database connected', { name: mongoose.connection.name });
}

module.exports = { connectDatabase };
