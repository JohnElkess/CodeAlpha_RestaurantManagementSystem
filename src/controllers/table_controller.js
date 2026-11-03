'use strict';

function createTableController({ tableService }) {
  return {
    async list(req, res) {
      res.json({ items: await tableService.list(req.valid.query) });
    },
    async create(req, res) {
      res.status(201).json(await tableService.create(req.valid.body));
    },
    async update(req, res) {
      res.json(await tableService.update(req.valid.params.id, req.valid.body));
    },
    async remove(req, res) {
      await tableService.remove(req.valid.params.id);
      res.status(204).send();
    },
  };
}

module.exports = { createTableController };
