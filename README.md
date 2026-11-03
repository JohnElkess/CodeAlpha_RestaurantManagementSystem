# Restaurant Management System API

![CI](https://github.com/JohnElkess/CodeAlpha_RestaurantManagementSystem/actions/workflows/ci.yml/badge.svg)

A REST API for one restaurant: menu with recipes, table reservations (including walk-ins), dine-in and takeaway orders, and **ingredient-level inventory** that is held when an order is placed, deducted when the kitchen starts, and given back when an order is cancelled in time. Built with Node.js, Express 5 and MongoDB.

Backend only: there is no frontend. Open `/api-docs` for an interactive API reference.

## Highlights

- **Three roles** (customer, staff, admin) with role checks on every route, plus ownership checks (a customer only ever sees their own bookings and orders).
- **No double bookings, even under race conditions.** Availability follows the two-hour overlap rule, and the database itself refuses two overlapping holds on a table (see [Reservations](#how-double-booking-is-prevented)).
- **No overselling.** Stock is held with atomic conditional updates, so two guests can never both take the last portion (see [Inventory](#how-inventory-works)).
- **Menu availability maintains itself:** an item switches off when any ingredient runs short and back on after a restock, without overriding a manual "switched off" by an admin.
- **Time rules are timezone-correct** (default `Africa/Cairo`, which observes daylight saving time).
- **Background jobs** mark no-shows, flag uncollected takeaways and complete finished stays.
- **~400 automated tests** against a real MongoDB, including concurrency tests.

## Tech stack

| Area | Choice |
|---|---|
| Runtime / framework | Node.js 22, Express 5 |
| Database | MongoDB 7 via Mongoose |
| Auth | JWT (bearer tokens), bcrypt password hashing |
| Validation | Zod (also generates the API docs) |
| Time | Luxon (timezone and DST aware) |
| Jobs | node-cron |
| Security | helmet, CORS allowlist, express-rate-limit |
| Docs | OpenAPI 3.1 + Swagger UI, generated from the real routes |
| Tests | Jest, supertest, mongodb-memory-server |
| Delivery | Docker (multi-stage), Docker Compose, GitHub Actions |

## Quick start

### With Docker

```bash
cp .env.example .env          # Windows cmd: copy .env.example .env
# edit .env: set JWT_SECRET and the ADMIN_* values
docker compose up --build -d
docker compose exec api node src/seed/seed.js     # admin account, menu, ingredients, tables
```

API: <http://localhost:3000> · Docs: <http://localhost:3000/api-docs>

Generate a strong secret with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.

### Locally (MongoDB in Docker, API on your machine)

```bash
docker compose up -d mongo
npm install
cp .env.example .env
npm run seed
npm run dev
```

### The seed script

`npm run seed` is safe to run repeatedly. It creates the admin account from `ADMIN_*`, 13 ingredients, 4 menu items with recipes and 9 tables. It never overwrites stock or prices that already exist. The menu in `src/seed/data.js` is placeholder data: edit names, recipes and quantities freely.

## A five-minute tour

```bash
# 1. log in as the seeded admin (phone or email works)
curl -s -X POST localhost:3000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"identifier":"+201000000000","password":"<ADMIN_PASSWORD>"}'

# 2. a customer registers, then looks at the menu and free tables
curl -s -X POST localhost:3000/api/auth/register -H 'Content-Type: application/json' \
  -d '{"name":"Mona","phone":"01012345678","password":"Passw0rd!"}'
curl -s localhost:3000/api/menu
curl -s "localhost:3000/api/reservations/availability?start=2026-11-20T19:00&partySize=3" -H "Authorization: Bearer $TOKEN"

# 3. book a table with a pre-order (table + ingredients are held together, or neither)
curl -s -X POST localhost:3000/api/reservations -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"startTime":"2026-11-20T19:00","partySize":3,"preOrder":{"items":[{"menuItem":"<MENU_ITEM_ID>","quantity":2}]}}'
```

Times without an offset (`2026-11-20T19:00`) are read in the restaurant timezone; `Z` or `+02:00` suffixes are respected.

## Configuration

All settings are environment variables (see `.env.example`). The app refuses to start with an invalid configuration and says what is wrong.

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `3000` |
| `MONGO_URI` | MongoDB connection string | `mongodb://localhost:27017/restaurant` |
| `JWT_SECRET` | Token signing secret, **at least 16 characters** | required |
| `JWT_EXPIRES_IN` | Token lifetime | `1d` |
| `BCRYPT_ROUNDS` | Password hashing cost | `10` |
| `TIMEZONE` | IANA zone used for all business rules and reports | `Africa/Cairo` |
| `DEFAULT_COUNTRY_CODE` | Added to national phone numbers (`010...` becomes `+2010...`) | `20` |
| `CORS_ORIGIN` | Comma-separated browser origins allowed; empty means none | empty |
| `ENABLE_JOBS` | Run the background jobs | `true` |
| `ADMIN_NAME`, `ADMIN_PHONE`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First admin, used by the seed script | |

Opening hours, slot length, stay length, grace periods and limits are not environment variables: they are business rules and live in one file, `src/config/business.js`.

## API

Protected routes expect `Authorization: Bearer <token>`. Errors always look like `{ "error": { "code", "message", "details?" } }`. Lists return `{ items, page, limit, total, pages }`. The table below is generated from the route definitions.

| Method | Endpoint | Who | What it does |
|---|---|---|---|
| POST | `/api/auth/register` | Public | Customer self-registration |
| POST | `/api/auth/login` | Public | Log in with phone or email |
| POST | `/api/auth/change-password` | Signed in | Change password (required while mustChangePassword is true) |
| GET | `/api/auth/me` | Signed in | The signed-in account |
| POST | `/api/users/guest` | Staff, Admin | Register a walk-in or phone-in guest; the temporary password is returned once |
| GET | `/api/users/search` | Staff, Admin | Find customers by phone or email |
| PATCH | `/api/users/:id/role` | Admin | Change a user's role |
| POST | `/api/users/:id/reset-password` | Staff, Admin | Issue a new temporary password (staff: customers only) |
| GET | `/api/menu` | Public (token shows more) | List menu items with availability (admins also see recipes) |
| GET | `/api/menu/:id` | Public (token shows more) | One menu item |
| POST | `/api/menu` | Admin | Create a menu item with its recipe |
| PUT | `/api/menu/:id` | Admin | Update a menu item or its recipe |
| PATCH | `/api/menu/:id/availability` | Admin | Manual availability toggle |
| GET | `/api/tables` | Staff, Admin | List tables |
| POST | `/api/tables` | Admin | Create a table |
| PUT | `/api/tables/:id` | Admin | Update a table |
| DELETE | `/api/tables/:id` | Admin | Delete a table that was never booked |
| GET | `/api/reservations/slots` | Signed in | Bookable start times for a day |
| GET | `/api/reservations/availability` | Signed in | Tables free for a slot, smallest fit first |
| POST | `/api/reservations/walk-in` | Staff, Admin | Seat a walk-in (starts now, same availability rule) |
| POST | `/api/reservations` | Signed in | Book a table, with an optional pre-order |
| GET | `/api/reservations` | Signed in | List reservations (customers see their own) |
| GET | `/api/reservations/:id` | Signed in | One reservation |
| PATCH | `/api/reservations/:id/cancel` | Signed in | Cancel; frees the table and releases held ingredients |
| PATCH | `/api/reservations/:id/seat` | Staff, Admin | Mark a confirmed reservation as seated |
| PATCH | `/api/reservations/:id/complete` | Staff, Admin | Mark completed (frees the table early) |
| POST | `/api/orders` | Signed in | Place a dine-in or takeaway order (holds ingredients) |
| GET | `/api/orders` | Signed in | List orders (customers see their own) |
| GET | `/api/orders/:id` | Signed in | Order detail |
| PUT | `/api/orders/:id/items` | Signed in | Edit items before preparing (applies the inventory difference) |
| PATCH | `/api/orders/:id/status` | Staff, Admin | Move to preparing (consumes the hold), ready or served |
| PATCH | `/api/orders/:id/cancel` | Signed in | Cancel; releases the hold if preparation has not started |
| GET | `/api/ingredients` | Admin | Ingredients with stock, reserved and available |
| POST | `/api/ingredients` | Admin | Create an ingredient |
| PUT | `/api/ingredients/:id` | Admin | Update name, unit or low-stock threshold |
| PATCH | `/api/ingredients/:id/stock` | Admin | Adjust stock: restock, waste or correction |
| GET | `/api/ingredients/:id/adjustments` | Admin | Audit trail of stock adjustments |
| GET | `/api/inventory/alerts` | Staff, Admin | Ingredients at or below their low-stock threshold |
| GET | `/api/reports/daily-sales` | Admin | Sales for a day: total, order count, per-item breakdown |
| GET | `/api/reports/low-stock` | Admin | Low-stock report with affected menu items |

"Who" lists the allowed roles. A customer asking for a booking or order that belongs to someone else gets `404`, exactly as if it did not exist.

### Status codes

| Code | Meaning |
|---|---|
| 400 | Invalid input or a broken business rule (`VALIDATION_ERROR`, `NOT_ON_SLOT_BOUNDARY`, `PICKUP_TOO_SOON`, ...) |
| 401 | Missing, invalid, expired or revoked token |
| 403 | Wrong role, or a temporary password that must be changed first (`PASSWORD_CHANGE_REQUIRED`) |
| 404 | Not found (or not yours) |
| 409 | Conflicts with the current state: table taken (`NO_TABLE_AVAILABLE`), not enough stock (`INSUFFICIENT_STOCK`, with the list of short ingredients), invalid status transition |
| 429 | Too many attempts |

## Architecture

```
src/
  routes/         every endpoint declared once: access rule, validation, handler
  middleware/     authenticate, authorize, validate, rate limits, error handler
  controllers/    read the request, call a service, shape the response
  services/       business logic (no req/res)
  policies/       rules that differ by type: reservation source, order type
  repositories/   atomic MongoDB operations (stock, table holds, order claims)
  models/         Mongoose schemas, indexes, JSON shaping
  domain/         constants and the state machines
  events/         event bus and its listeners
  jobs/           no-show, uncollected, auto-complete + scheduler
  config/         environment and business rules
  utils/          time, money, phone, clock, errors, logger
  docs/           OpenAPI generator
  seed/           starter data and seed script
```

Dependencies point one way: routes → controllers → services → repositories/models. `req` and `res` never reach a service. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for diagrams.

### Design patterns, and where to find them

| Pattern | Where | Why it is used |
|---|---|---|
| Layered architecture | folders above | each layer has one job, services are testable without HTTP |
| Chain of Responsibility | `routes/route_kit.js`, `middleware/` | `authenticate → authorize → validate → handler`; every link rejects or passes on |
| Strategy | `policies/reservation_policy.js`, `policies/order_policy.js` | slot booking vs walk-in, dine-in vs takeaway each have their own rules |
| Factory | `ReservationPolicyFactory`, `OrderPolicyFactory` | picks the strategy for a booking source or order type |
| State machine (State) | `domain/state_machines.js` | one table says what may follow what, for orders and reservations |
| Observer | `events/event_bus.js`, `events/listeners.js` | stock changes refresh menu availability and raise low-stock alerts without services knowing each other |
| Repository | `repositories/` | all atomic MongoDB tricks live in one place |
| Template Method | `jobs/background_job.js` | jobs never throw and never overlap; subclasses only write `execute()` |
| Dependency Injection | `container.js` | one composition root; tests inject a fake clock |
| Saga / compensation | `InventoryRepository.reserve` | multi-ingredient holds are undone if one ingredient is short |
| Registry + generation | `routes/route_kit.js`, `docs/openapi.js` | API docs are built from the same route definitions that run the server |

## How inventory works

Each ingredient has `stock` (physically there) and `reserved` (promised to orders not yet started). **Available = stock - reserved.**

| Moment | Stock | Reserved |
|---|---|---|
| Order placed (or pre-order booked) | unchanged | **+ needed** |
| Order edited before preparing | unchanged | only the **difference** moves |
| Order cancelled before preparing, reservation cancelled or no-show | unchanged | **- needed** (released) |
| Kitchen moves the order to `preparing` | **- needed** | **- needed** |
| Cancelled after preparing | stays reduced (the food is made) | already 0 |

Why it is safe:

- **The check and the change are one operation.** A hold is `updateOne({ _id, stock - reserved >= needed }, { $inc: { reserved: needed } })`. MongoDB applies single-document updates atomically, so two simultaneous orders cannot both take the last portion. No transaction or replica set is needed.
- **Multi-ingredient orders are all-or-nothing.** Ingredients are taken one by one in a fixed order; if one is short, what was already taken is put back and the response lists every short ingredient.
- **Every hold is stored on the order** (exact ingredient quantities), so a later recipe change can never make a release or deduction wrong.
- **Status changes are claims.** `placed → preparing`, cancel and "uncollected" are single conditional updates that return the document as it was; only the request that wins the claim touches stock. A cancel racing with "preparing", or two staff pressing the same button, release or deduct exactly once.
- **Edits are version-guarded.** An edit takes the extra ingredients first, then swaps the items only if the order is still `placed` at the version it read; otherwise it undoes its extra hold. Whichever of "edit" and "preparing" wins, the deducted stock matches the items the order finally contains (covered by repeated race tests).
- **Manual adjustments cannot cut into held stock.** Restock, waste and correction are audited and refuse to push stock below what pending orders hold.

Menu availability: an item is `outOfStock` when any recipe ingredient has less available than one portion needs; `isAvailable = !manuallyDisabled && !outOfStock`. Two flags, so restocking never re-enables an item an admin switched off.

## How double booking is prevented

A table is free for `[start, end)` when it has no `confirmed` or `seated` reservation with `existing.start < end && existing.end > start`. Back-to-back bookings (one ends exactly when the next starts) are allowed. `cancelled`, `no_show` and `completed` reservations free the table at once, which is how early completion and no-shows give tables back.

Checking and then inserting is not enough when two requests arrive together. So each active reservation also stores the **minutes it covers** and a **unique partial index on `(table, minute)`** rejects any overlap at the database level. The service simply tries the next table when an insert loses the race. The index is built before the server starts.

## Time and timezone

Everything is stored in UTC and evaluated in `TIMEZONE`. Egypt observes daylight saving time, so durations use real elapsed time and "16:00" is always computed as local 16:00 (a 23- or 25-hour day is handled correctly). Walk-ins start at the current minute, not on a slot boundary.

## Testing

```bash
npm test                 # all tests
npm run test:coverage    # with a coverage report
```

The tests start a throw-away MongoDB with `mongodb-memory-server` (downloaded on first run). To use a MongoDB you already run, set `TEST_MONGO_URI=mongodb://localhost:27017`; each test file then gets its own database.

- **Unit tests:** time and DST maths, phone normalisation, money, state machines, reservation and takeaway policies, event bus, configuration, inventory arithmetic.
- **Integration tests:** every endpoint through HTTP, covering validation, roles and ownership, the booking and overlap rules, walk-in edge cases, the whole order and stock lifecycle, background jobs with a fake clock, reports and the seed script.
- **Concurrency tests:** simultaneous bookings for one table, simultaneous orders for the last portions, cancel-versus-prepare and edit-versus-prepare races, no-show job versus customer cancel.
- **A permission matrix** generated from the route registry checks that every route refuses anonymous callers (401) and wrong roles (403), so a new endpoint cannot be forgotten.

## Assumptions and limitations

From the scope: one restaurant, one currency, no online payments, no refunds, no email/SMS (forgotten passwords are reset by staff or an admin), a fixed two-hour stay, a table is never combined with another, a pre-order exists only together with a reservation.

My decisions where the scope was silent:

- **Quantities are whole units** (grams, millilitres, pieces), which keeps stock arithmetic exact.
- **ASAP takeaways get an estimated `pickupTime`** (order time + 20 minutes) so the "uncollected after pickupTime + 20 minutes" rule applies to them too.
- **A takeaway that was never started and goes uncollected gives its held ingredients back**, because nothing was cooked. One that was already prepared keeps its stock deducted.
- **Cancelling a reservation or a no-show cancels all of its open orders**; ingredients are released only for orders not yet in preparation.
- **An order counts in reports on the day it is for:** the reservation day for dine-in, the pickup day for scheduled takeaway, the order day for ASAP.
- **Passwords:** 8-72 characters. Changing or resetting a password invalidates all earlier tokens. A guest with a temporary password can only change it until they do.
- **Roles are read from the database on every request**, so a role change applies at once.
- **A table with upcoming reservations cannot be deactivated**, and one that was ever booked is deactivated rather than deleted.

Known limitations:

- Events and rate-limit counters are in memory, so they are per process. Run one instance, or move events to a queue and counters to Redis before scaling out.
- A crash between two stock updates of one request could leave `reserved` slightly off. A reconciliation report (recompute `reserved` from open orders) would be the next addition.
- Under heavy contention an order can occasionally be refused while another request is rolling back a partial hold that would have left enough stock; retrying works.
- Uploaded content, images and notifications (email/SMS) are out of scope.
