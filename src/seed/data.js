'use strict';

/**
 * Starter data. The scope says the team defines the menu, so these are PLACEHOLDERS: edit names, recipes,
 * quantities and the table layout freely. Quantities are whole units: grams, millilitres, pieces.
 */
const ingredients = [
  { name: 'Pizza dough', unit: 'g', stock: 12000, lowStockThreshold: 2000 },
  { name: 'Tomato sauce', unit: 'ml', stock: 6000, lowStockThreshold: 1000 },
  { name: 'Mozzarella', unit: 'g', stock: 8000, lowStockThreshold: 1500 },
  { name: 'Beef patty', unit: 'pieces', stock: 60, lowStockThreshold: 10 },
  { name: 'Burger bun', unit: 'pieces', stock: 80, lowStockThreshold: 10 },
  { name: 'Cheddar slice', unit: 'pieces', stock: 100, lowStockThreshold: 15 },
  { name: 'Lettuce', unit: 'g', stock: 3000, lowStockThreshold: 500 },
  { name: 'Chicken breast', unit: 'g', stock: 9000, lowStockThreshold: 1500 },
  { name: 'Rice', unit: 'g', stock: 10000, lowStockThreshold: 2000 },
  { name: 'Olive oil', unit: 'ml', stock: 3000, lowStockThreshold: 500 },
  { name: 'Fettuccine', unit: 'g', stock: 8000, lowStockThreshold: 1500 },
  { name: 'Cream', unit: 'ml', stock: 5000, lowStockThreshold: 800 },
  { name: 'Parmesan', unit: 'g', stock: 2000, lowStockThreshold: 300 },
];

// price is in the restaurant's currency (EGP); recipes reference ingredients by name
const menu = [
  {
    name: 'Margherita Pizza', category: 'Pizza', price: 180, description: 'Tomato, mozzarella, fresh dough',
    recipe: [['Pizza dough', 250], ['Tomato sauce', 80], ['Mozzarella', 120]],
  },
  {
    name: 'Classic Cheeseburger', category: 'Burgers', price: 150, description: 'Beef patty, cheddar, lettuce, bun',
    recipe: [['Beef patty', 1], ['Burger bun', 1], ['Cheddar slice', 1], ['Lettuce', 20]],
  },
  {
    name: 'Grilled Chicken with Rice', category: 'Mains', price: 220, description: 'Grilled chicken breast over rice',
    recipe: [['Chicken breast', 220], ['Rice', 150], ['Olive oil', 15]],
  },
  {
    name: 'Fettuccine Alfredo', category: 'Pasta', price: 170, description: 'Creamy parmesan sauce',
    recipe: [['Fettuccine', 120], ['Cream', 100], ['Parmesan', 30]],
  },
];

const tables = [
  { number: 1, capacity: 2, zone: 'window' },
  { number: 2, capacity: 2, zone: 'window' },
  { number: 3, capacity: 2, zone: 'normal' },
  { number: 4, capacity: 4, zone: 'normal' },
  { number: 5, capacity: 4, zone: 'normal' },
  { number: 6, capacity: 4, zone: 'window' },
  { number: 7, capacity: 6, zone: 'normal' },
  { number: 8, capacity: 6, zone: 'vip' },
  { number: 9, capacity: 8, zone: 'vip' },
];

module.exports = { ingredients, menu, tables };
