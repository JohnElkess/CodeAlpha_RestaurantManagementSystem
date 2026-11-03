const { InventoryService } = require('../../src/services/inventory_service');
const { InventoryRepository } = require('../../src/repositories/inventory_repository');

const diffOf = (oldLines, newLines) => new InventoryService({}).diff(oldLines, newLines);
const sorted = (lines) => [...lines].sort((a, b) => a.ingredient.localeCompare(b.ingredient));

describe('InventoryRepository.normalize', () => {
  test('merges duplicate ingredients and drops empty lines', () => {
    expect(
      sorted(InventoryRepository.normalize([
        { ingredient: 'a', quantity: 100 },
        { ingredient: 'b', quantity: 5 },
        { ingredient: 'a', quantity: 50 },
        { ingredient: 'c', quantity: 0 },
      ]))
    ).toEqual([{ ingredient: 'a', quantity: 150 }, { ingredient: 'b', quantity: 5 }]);
  });
});

describe('InventoryService.requirementFor', () => {
  test('multiplies recipes by portions and merges shared ingredients across items', () => {
    const pizza = { recipe: [{ ingredient: 'dough', quantityPerPortion: 250 }, { ingredient: 'cheese', quantityPerPortion: 100 }], quantity: 2 };
    const calzone = { recipe: [{ ingredient: 'dough', quantityPerPortion: 300 }], quantity: 1 };
    expect(sorted(InventoryService.requirementFor([pizza, calzone]))).toEqual([
      { ingredient: 'cheese', quantity: 200 },
      { ingredient: 'dough', quantity: 800 },
    ]);
  });
});

describe('InventoryService.diff (order edits reserve or release only the difference)', () => {
  test('more of an item: only the extra is taken', () => {
    expect(diffOf([{ ingredient: 'a', quantity: 100 }], [{ ingredient: 'a', quantity: 250 }])).toEqual({
      increases: [{ ingredient: 'a', quantity: 150 }],
      decreases: [],
    });
  });
  test('less of an item: only the surplus is given back', () => {
    expect(diffOf([{ ingredient: 'a', quantity: 250 }], [{ ingredient: 'a', quantity: 100 }])).toEqual({
      increases: [],
      decreases: [{ ingredient: 'a', quantity: 150 }],
    });
  });
  test('swapping dishes releases the old ingredients and takes the new ones', () => {
    const { increases, decreases } = diffOf([{ ingredient: 'a', quantity: 100 }], [{ ingredient: 'b', quantity: 40 }]);
    expect(increases).toEqual([{ ingredient: 'b', quantity: 40 }]);
    expect(decreases).toEqual([{ ingredient: 'a', quantity: 100 }]);
  });
  test('an unchanged order changes nothing', () => {
    expect(diffOf([{ ingredient: 'a', quantity: 100 }], [{ ingredient: 'a', quantity: 100 }])).toEqual({ increases: [], decreases: [] });
  });
  test('accepts ObjectId-like values for ingredient ids', () => {
    const id = { toString: () => 'abc' };
    expect(diffOf([], [{ ingredient: id, quantity: 5 }]).increases).toEqual([{ ingredient: 'abc', quantity: 5 }]);
  });
});
