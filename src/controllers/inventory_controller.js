'use strict';

function createInventoryController({ ingredientService }) {
  return {
    async list(req, res) {
      res.json({ items: await ingredientService.list() });
    },
    async create(req, res) {
      res.status(201).json(await ingredientService.create(req.valid.body));
    },
    async update(req, res) {
      res.json(await ingredientService.update(req.valid.params.id, req.valid.body));
    },
    async adjust(req, res) {
      res.json(await ingredientService.adjust(req.user, req.valid.params.id, req.valid.body));
    },
    async adjustments(req, res) {
      res.json({ items: await ingredientService.adjustments(req.valid.params.id) });
    },
    async alerts(req, res) {
      const items = await ingredientService.alerts();
      res.json({ count: items.length, items });
    },
  };
}

module.exports = { createInventoryController };
