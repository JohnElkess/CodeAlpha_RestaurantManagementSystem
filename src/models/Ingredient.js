'use strict';
const mongoose = require('mongoose');
const { INGREDIENT_UNITS } = require('../domain/constants');

const wholeNumber = { validator: Number.isInteger, message: '{PATH} must be a whole number' };

const ingredientSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    unit: { type: String, enum: INGREDIENT_UNITS, required: true },
    stock: { type: Number, default: 0, min: 0, validate: wholeNumber }, // physically in the kitchen
    reserved: { type: Number, default: 0, min: 0, validate: wholeNumber }, // promised to orders not yet in preparation
    lowStockThreshold: { type: Number, default: 0, min: 0, validate: wholeNumber },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        delete ret.id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

/** Available = stock - reserved (scope section 4). */
ingredientSchema.virtual('available').get(function available() {
  return this.stock - this.reserved;
});

module.exports = mongoose.model('Ingredient', ingredientSchema);
