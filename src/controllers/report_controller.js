'use strict';
const { localDateString } = require('../utils/time');

function createReportController({ reportService, clock, business }) {
  return {
    async dailySales(req, res) {
      const date = req.valid.query.date || localDateString(clock.now(), business.timezone); // default: today
      res.json(await reportService.dailySales(date));
    },
    async lowStock(req, res) {
      res.json(await reportService.lowStock());
    },
  };
}

module.exports = { createReportController };
