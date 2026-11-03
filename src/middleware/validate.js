'use strict';
const { BadRequestError } = require('../utils/errors');

/**
 * Validates params, query and body with Zod. Validated (and transformed) values land in `req.valid`.
 * Express 5 makes `req.query` read-only, which is why results are not written back to the request.
 * Unknown body fields are stripped, so clients cannot smuggle in fields such as `role`.
 */
function validate({ params, query, body }) {
  return (req, res, next) => {
    const issues = [];
    const valid = {};
    const sources = { params: [params, req.params], query: [query, req.query], body: [body, req.body] };

    for (const [where, [schema, input]] of Object.entries(sources)) {
      if (!schema) continue;
      const result = schema.safeParse(input ?? {});
      if (result.success) valid[where] = result.data;
      else {
        for (const issue of result.error.issues) {
          issues.push({ in: where, path: issue.path.join('.'), message: issue.message });
        }
      }
    }
    if (issues.length) throw new BadRequestError('VALIDATION_ERROR', 'The request is not valid', issues);
    req.valid = valid;
    next();
  };
}

module.exports = { validate };
