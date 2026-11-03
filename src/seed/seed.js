'use strict';
const mongoose = require('mongoose');
const { env } = require('../config/env');
const { connectDatabase } = require('../config/db');
const User = require('../models/User');
const Ingredient = require('../models/Ingredient');
const MenuItem = require('../models/MenuItem');
const Table = require('../models/Table');
const { ROLES } = require('../domain/constants');
const { normalizePhone } = require('../utils/phone');
const { hashPassword } = require('../utils/password');
const { MenuAvailabilityService } = require('../services/menu_availability_service');
const data = require('./data');

/**
 * Idempotent: run it as often as you like. Existing ingredients, menu items and tables are left untouched
 * (it never overwrites stock), missing ones are created.
 */
async function seed() {
  const created = { admin: 0, ingredients: 0, menu: 0, tables: 0 };

  // --- admin account (credentials come from the environment, never from code) ---
  const phone = normalizePhone(env.ADMIN_PHONE || '', env.DEFAULT_COUNTRY_CODE);
  if (!phone || !env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 8) {
    throw new Error('Set ADMIN_PHONE (a valid phone number) and ADMIN_PASSWORD (8+ characters) in .env to create the admin');
  }
  if (!(await User.exists({ phone }))) {
    await User.create({
      name: env.ADMIN_NAME || 'Administrator',
      phone,
      email: env.ADMIN_EMAIL ? env.ADMIN_EMAIL.toLowerCase() : undefined,
      passwordHash: await hashPassword(env.ADMIN_PASSWORD),
      role: ROLES.ADMIN,
    });
    created.admin = 1;
  }

  // --- ingredients ---
  for (const item of data.ingredients) {
    const result = await Ingredient.updateOne({ name: item.name }, { $setOnInsert: item }, { upsert: true });
    created.ingredients += result.upsertedCount;
  }
  const byName = new Map((await Ingredient.find()).map((i) => [i.name, i._id]));

  // --- menu items with recipes ---
  for (const item of data.menu) {
    const recipe = item.recipe.map(([ingredientName, quantityPerPortion]) => ({ ingredient: byName.get(ingredientName), quantityPerPortion }));
    const { recipe: _ignored, ...fields } = item;
    const result = await MenuItem.updateOne({ name: item.name }, { $setOnInsert: { ...fields, recipe } }, { upsert: true });
    created.menu += result.upsertedCount;
  }

  // --- tables ---
  for (const table of data.tables) {
    const result = await Table.updateOne({ number: table.number }, { $setOnInsert: table }, { upsert: true });
    created.tables += result.upsertedCount;
  }

  await new MenuAvailabilityService().refresh();
  return created;
}

async function main() {
  await connectDatabase(env.MONGO_URI);
  const created = await seed();
  console.log('Seed finished. Created:', created);
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { seed };
