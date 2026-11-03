'use strict';

function createMenuController({ menuService }) {
  return {
    async list(req, res) {
      res.json({ items: await menuService.list(req.user) });
    },
    async get(req, res) {
      res.json(await menuService.get(req.user, req.valid.params.id));
    },
    async create(req, res) {
      res.status(201).json(await menuService.create(req.user, req.valid.body));
    },
    async update(req, res) {
      res.json(await menuService.update(req.user, req.valid.params.id, req.valid.body));
    },
    async setAvailability(req, res) {
      res.json(await menuService.setAvailability(req.user, req.valid.params.id, req.valid.body.isAvailable));
    },
  };
}

module.exports = { createMenuController };
