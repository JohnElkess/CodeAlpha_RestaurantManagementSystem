'use strict';
const { AppError } = require('../utils/errors');
const { logger } = require('../utils/logger');

/** One place that turns every failure into the same JSON shape: { error: { code, message, details? } }. */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (res.headersSent) return next(err);

  if (err instanceof AppError) return send(res, err.status, err.code, err.message, err.details);

  if (err.type === 'entity.parse.failed') return send(res, 400, 'INVALID_JSON', 'The request body is not valid JSON');
  if (err.type === 'entity.too.large') return send(res, 413, 'PAYLOAD_TOO_LARGE', 'The request body is too large');
  if (err.name === 'ValidationError' && err.errors) {
    const details = Object.values(err.errors).map((e) => ({ path: e.path, message: e.message }));
    return send(res, 400, 'VALIDATION_ERROR', 'The data is not valid', details);
  }
  if (err.name === 'CastError') return send(res, 400, 'INVALID_ID', 'A value has the wrong format');
  if (err.code === 11000) return send(res, 409, 'CONFLICT', 'This conflicts with existing data');

  logger.error('unhandled error', { method: req.method, path: req.originalUrl, error: err.stack || String(err) });
  return send(res, 500, 'INTERNAL_ERROR', 'Something went wrong');
}

function notFoundHandler(req, res) {
  send(res, 404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.originalUrl.split('?')[0]}`);
}

function send(res, status, code, message, details) {
  res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
}

module.exports = { errorHandler, notFoundHandler };
