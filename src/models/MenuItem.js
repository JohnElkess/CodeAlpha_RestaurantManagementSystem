'use strict';
const mongoose = require('mongoose');

const recipeLineSchema = new mongoose.Schema(
  {
    ingredient: { type: mongoose.Schema.Types.ObjectId, ref: 'Ingredient', required: true },
    quantityPerPortion: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isInteger, message: 'quantityPerPortion must be a whole number' },
    },
  },
  { _id: false }
);

const menuItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, trim: true, default: '' },
    price: { type: Number, required: true, min: 0 },
    category: { type: String, required: true, trim: true },
    // Effective availability, auto-managed: = !manuallyDisabled && !outOfStock (see MenuAvailabilityService).
    isAvailable: { type: Boolean, default: true },
    manuallyDisabled: { type: Boolean, default: false }, // admin toggle
    outOfStock: { type: Boolean, default: false }, // set automatically from ingredient availability
    recipe: {
      type: [recipeLineSchema],
      validate: { validator: (v) => v.length > 0, message: 'a menu item needs at least one recipe line' },
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

module.exports = mongoose.model('MenuItem', menuItemSchema);
