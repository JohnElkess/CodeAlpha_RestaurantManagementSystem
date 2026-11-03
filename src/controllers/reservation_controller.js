'use strict';

function createReservationController({ reservationService }) {
  return {
    async slots(req, res) {
      res.json({ date: req.valid.query.date, slots: reservationService.slots(req.valid.query.date) });
    },
    async availability(req, res) {
      const { start, partySize, zone } = req.valid.query;
      res.json(await reservationService.availability({ startTime: start, partySize, zone }));
    },
    async create(req, res) {
      res.status(201).json(await reservationService.create(req.user, req.valid.body));
    },
    async walkIn(req, res) {
      res.status(201).json(await reservationService.walkIn(req.user, req.valid.body));
    },
    async list(req, res) {
      res.json(await reservationService.list(req.user, req.valid.query));
    },
    async get(req, res) {
      res.json(await reservationService.get(req.user, req.valid.params.id));
    },
    async cancel(req, res) {
      res.json(await reservationService.cancel(req.user, req.valid.params.id));
    },
    async seat(req, res) {
      res.json(await reservationService.seat(req.valid.params.id));
    },
    async complete(req, res) {
      res.json(await reservationService.complete(req.valid.params.id));
    },
  };
}

module.exports = { createReservationController };
