'use strict';
const business = require('./config/business');
const { SystemClock } = require('./utils/clock');
const { logger: defaultLogger } = require('./utils/logger');
const { EventBus } = require('./events/event_bus');
const { registerListeners } = require('./events/listeners');
const { InventoryRepository } = require('./repositories/inventory_repository');
const { ReservationRepository } = require('./repositories/reservation_repository');
const { OrderRepository } = require('./repositories/order_repository');
const { ReservationPolicyFactory } = require('./policies/reservation_policy');
const { OrderPolicyFactory } = require('./policies/order_policy');
const { CustomerResolver } = require('./services/customer_resolver');
const { AuthService } = require('./services/auth_service');
const { UserService } = require('./services/user_service');
const { MenuAvailabilityService } = require('./services/menu_availability_service');
const { MenuService } = require('./services/menu_service');
const { TableService } = require('./services/table_service');
const { InventoryService } = require('./services/inventory_service');
const { IngredientService } = require('./services/ingredient_service');
const { OrderService } = require('./services/order_service');
const { ReservationService } = require('./services/reservation_service');
const { ReportService } = require('./services/report_service');
const { NoShowJob } = require('./jobs/no_show_job');
const { UncollectedJob } = require('./jobs/uncollected_job');
const { AutoCompleteJob } = require('./jobs/auto_complete_job');

/**
 * Composition root: the ONE place where objects are created and connected (manual dependency injection).
 * Services receive their collaborators, including the clock, so tests can swap in a fake clock and the
 * rest of the code never reaches for globals.
 */
function buildContainer({ clock = new SystemClock(), logger = defaultLogger } = {}) {
  const eventBus = new EventBus({ logger });

  const inventoryRepo = new InventoryRepository();
  const reservationRepo = new ReservationRepository();
  const orderRepo = new OrderRepository({ clock });

  const customers = new CustomerResolver();
  const menuAvailability = new MenuAvailabilityService();
  registerListeners({ eventBus, menuAvailability, inventoryRepo, logger });

  const inventory = new InventoryService({ inventoryRepo, eventBus });
  const orderPolicies = new OrderPolicyFactory({ clock, business, reservationRepo });
  const reservationPolicies = new ReservationPolicyFactory({ clock, business });

  const authService = new AuthService();
  const userService = new UserService();
  const menuService = new MenuService({ menuAvailability });
  const tableService = new TableService({ reservationRepo, clock });
  const ingredientService = new IngredientService({ inventoryRepo, eventBus });
  const orderService = new OrderService({ orderRepo, orderPolicies, customers, inventory, eventBus, business });
  const reservationService = new ReservationService({
    reservationRepo,
    policies: reservationPolicies,
    customers,
    orderService,
    eventBus,
    clock,
    business,
  });
  const reportService = new ReportService({ orderRepo, ingredientService, business, clock });

  const jobs = {
    noShow: new NoShowJob({ reservationRepo, reservationService, logger }),
    uncollected: new UncollectedJob({ orderRepo, orderService, clock, business, logger }),
    autoComplete: new AutoCompleteJob({ reservationRepo, reservationService, clock, logger }),
  };

  return {
    clock,
    logger,
    business,
    eventBus,
    repos: { inventoryRepo, reservationRepo, orderRepo },
    services: {
      authService,
      userService,
      menuService,
      tableService,
      ingredientService,
      inventory,
      orderService,
      reservationService,
      reportService,
      menuAvailability,
    },
    jobs,
  };
}

module.exports = { buildContainer };
