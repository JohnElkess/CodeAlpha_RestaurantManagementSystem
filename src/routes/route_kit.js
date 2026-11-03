'use strict';
const express = require('express');

/** Collects a description of every route so the OpenAPI document is generated from the same source as the router. */
class RouteRegistry {
  constructor() {
    this.routes = [];
  }

  add(route) {
    this.routes.push(route);
  }
}

/**
 * Declarative routes: each route states its access rule, validation schemas and handler once. The kit builds the
 * middleware chain (Chain of Responsibility) and records the route in the registry, so the API documentation can
 * never disagree with what the server really enforces.
 *
 * access: 'public' | 'optional' | 'authenticated' | ['staff', 'admin', ...roles]
 */
function createRouteKit({ registry, auth, validate }) {
  return function buildRouter(basePath, tag, declare) {
    const router = express.Router();

    declare((spec) => {
      const { access = 'authenticated' } = spec;
      const chain = [...(spec.middleware || [])];

      if (access === 'optional') chain.push(auth.optional);
      else if (access !== 'public') {
        chain.push(auth.authenticate({ allowPasswordChange: spec.allowPasswordChange }));
        if (Array.isArray(access)) chain.push(auth.authorize(...access));
      }
      if (spec.params || spec.query || spec.body) chain.push(validate({ params: spec.params, query: spec.query, body: spec.body }));

      router[spec.method](spec.path, ...chain, spec.handler);
      registry.add({ ...spec, access, basePath, tag });
    });

    return { basePath, router };
  };
}

module.exports = { RouteRegistry, createRouteKit };
