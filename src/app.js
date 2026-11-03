'use strict';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const mongoose = require('mongoose');
const swaggerUi = require('swagger-ui-express');
const { env } = require('./config/env');
const { createAuthMiddleware } = require('./middleware/auth');
const { validate } = require('./middleware/validate');
const { apiLimiter } = require('./middleware/rate_limiters');
const { errorHandler, notFoundHandler } = require('./middleware/error_handler');
const { RouteRegistry, createRouteKit } = require('./routes/route_kit');
const { createRouters } = require('./routes');
const { buildOpenApi } = require('./docs/openapi');
const { createAuthController } = require('./controllers/auth_controller');
const { createUserController } = require('./controllers/user_controller');
const { createMenuController } = require('./controllers/menu_controller');
const { createTableController } = require('./controllers/table_controller');
const { createReservationController } = require('./controllers/reservation_controller');
const { createOrderController } = require('./controllers/order_controller');
const { createInventoryController } = require('./controllers/inventory_controller');
const { createReportController } = require('./controllers/report_controller');

/** Build the Express app from a container. Nothing here starts a server or opens a database connection. */
function createApp(container) {
  const { services, clock, business } = container;
  const registry = new RouteRegistry();
  const auth = createAuthMiddleware({ authService: services.authService });
  const build = createRouteKit({ registry, auth, validate });

  const controllers = {
    auth: createAuthController(services),
    users: createUserController(services),
    menu: createMenuController(services),
    tables: createTableController(services),
    reservations: createReservationController(services),
    orders: createOrderController(services),
    inventory: createInventoryController(services),
    reports: createReportController({ ...services, clock, business }),
  };
  const routers = createRouters({ build, controllers });
  const openapi = buildOpenApi(registry);

  const app = express();
  app.locals.routeRegistry = registry; // lets tests and tooling inspect every declared route

  // API docs get a relaxed Content-Security-Policy so Swagger UI can run; everything else gets the strict default.
  const docsHelmet = helmet({
    contentSecurityPolicy: { directives: { ...helmet.contentSecurityPolicy.getDefaultDirectives(), 'upgrade-insecure-requests': null } },
    strictTransportSecurity: false,
  });
  app.use('/api-docs', docsHelmet, swaggerUi.serve, swaggerUi.setup(openapi));
  app.get('/api-docs.json', (req, res) => res.json(openapi));

  app.use(helmet());
  const origins = env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
  app.use(cors({ origin: origins.length ? origins : false }));
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    req.body ??= {}; // Express 5 leaves req.body undefined when a request has no body
    next();
  });

  app.get('/health', (req, res) => {
    const connected = mongoose.connection.readyState === 1;
    res.status(connected ? 200 : 503).json({ status: connected ? 'ok' : 'degraded', database: connected ? 'connected' : 'disconnected' });
  });

  app.use('/api', apiLimiter);
  routers.forEach(({ basePath, router }) => app.use(basePath, router));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
