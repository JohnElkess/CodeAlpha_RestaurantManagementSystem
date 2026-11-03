'use strict';

function createOrderController({ orderService }) {
  return {
    async place(req, res) {
      res.status(201).json(await orderService.placeOrder(req.user, req.valid.body));
    },
    async list(req, res) {
      res.json(await orderService.listOrders(req.user, req.valid.query));
    },
    async get(req, res) {
      res.json(await orderService.getOrder(req.user, req.valid.params.id));
    },
    async editItems(req, res) {
      res.json(await orderService.editItems(req.user, req.valid.params.id, req.valid.body));
    },
    async updateStatus(req, res) {
      res.json(await orderService.updateStatus(req.user, req.valid.params.id, req.valid.body.status));
    },
    async cancel(req, res) {
      res.json(await orderService.cancelOrder(req.user, req.valid.params.id));
    },
  };
}

module.exports = { createOrderController };
