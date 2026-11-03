'use strict';
const { z } = require('zod');

const toJsonSchema = (schema) => {
  const out = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  delete out.$schema;
  return out;
};

const errorRef = { $ref: '#/components/schemas/Error' };
const errorResponse = (description) => ({ description, content: { 'application/json': { schema: errorRef } } });

const toParameters = (schema, where) => {
  const json = toJsonSchema(schema);
  const required = new Set(json.required || []);
  return Object.entries(json.properties || {}).map(([name, s]) => ({ name, in: where, required: where === 'path' || required.has(name), schema: s }));
};

/**
 * Builds the OpenAPI 3.1 document from the route registry. Request parameters and bodies come straight from the
 * Zod schemas that validate the requests, so the documentation cannot drift from the code.
 */
function buildOpenApi(registry) {
  const paths = {};

  for (const r of registry.routes) {
    const path = (r.basePath + (r.path === '/' ? '' : r.path)).replace(/:(\w+)/g, '{$1}');
    const isPublic = r.access === 'public';
    const roles = Array.isArray(r.access) ? r.access.join(', ') : null;
    const status = String(r.status || 200);

    const responses = { [status]: { description: status === '204' ? 'Done, no content' : 'Success' }, 429: errorResponse('Too many requests') };
    if (r.params || r.query || r.body) responses[400] = errorResponse('Validation error (VALIDATION_ERROR) or a broken business rule');
    if (!isPublic && r.access !== 'optional') responses[401] = errorResponse('Missing, invalid or expired token');
    if (roles || r.access !== 'public') responses[403] = errorResponse(roles ? `Requires role: ${roles}` : 'Not allowed');
    if (r.params) responses[404] = errorResponse('Not found');
    responses[409] = errorResponse('Conflict with the current state (for example a taken table or not enough stock)');

    const operation = {
      tags: [r.tag],
      summary: r.summary,
      description: `Access: ${isPublic ? 'public' : r.access === 'optional' ? 'public (a token unlocks more detail)' : roles || 'any signed-in user'}.`,
      security: isPublic ? [] : r.access === 'optional' ? [{}, { bearerAuth: [] }] : [{ bearerAuth: [] }],
      parameters: [...(r.params ? toParameters(r.params, 'path') : []), ...(r.query ? toParameters(r.query, 'query') : [])],
      responses,
    };
    if (r.body) operation.requestBody = { required: true, content: { 'application/json': { schema: toJsonSchema(r.body) } } };
    if (!operation.parameters.length) delete operation.parameters;

    paths[path] = { ...(paths[path] || {}), [r.method]: operation };
  }

  paths['/health'] = {
    get: { tags: ['System'], summary: 'Liveness and database status', security: [], responses: { 200: { description: 'Service is up' } } },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'Restaurant Management System API',
      version: '1.0.0',
      description:
        'Menu, table reservations, dine-in and takeaway orders and ingredient-level inventory for one restaurant.\n\n' +
        'Log in with `POST /api/auth/login`, press **Authorize** and paste the token (without "Bearer"). ' +
        'Times are ISO 8601; a time without an offset is read in the restaurant timezone. ' +
        'Every error has the shape `{ "error": { "code", "message", "details?" } }`.',
    },
    servers: [{ url: '/' }],
    tags: [...new Set(registry.routes.map((r) => r.tag))].concat('System').map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: { code: { type: 'string', example: 'VALIDATION_ERROR' }, message: { type: 'string' }, details: {} },
              required: ['code', 'message'],
            },
          },
        },
      },
    },
  };
}

module.exports = { buildOpenApi };
