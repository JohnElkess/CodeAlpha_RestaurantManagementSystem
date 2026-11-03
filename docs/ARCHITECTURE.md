# Architecture

## Request flow

```mermaid
flowchart LR
  C[Client] --> H[helmet / CORS / rate limit]
  H --> A[authenticate<br/>JWT + load account]
  A --> Z[authorize<br/>role check]
  Z --> V[validate<br/>Zod]
  V --> CT[controller]
  CT --> S[service<br/>business rules]
  S --> P[policy<br/>strategy]
  S --> R[repository<br/>atomic updates]
  R --> DB[(MongoDB)]
  S -. publishes .-> E[event bus]
  E -. observers .-> M[menu availability<br/>low-stock alerts]
  ERR[error handler] -.-> C
```

Each box before the controller is a link in a chain: it either rejects the request (with a uniform JSON error) or passes it on. Routes declare their chain once (`routes/index.js`), and the same declaration produces the API documentation.

## Order lifecycle and what happens to stock

```mermaid
stateDiagram-v2
  [*] --> placed: ingredients HELD (reserved +)
  placed --> preparing: hold CONSUMED (stock -, reserved -)
  preparing --> ready
  ready --> served
  placed --> cancelled: hold RELEASED
  preparing --> cancelled: stock not restored
  ready --> cancelled: stock not restored
  placed --> uncollected: takeaway, hold RELEASED
  preparing --> uncollected: takeaway
  ready --> uncollected: takeaway
  uncollected --> served: collected late
  served --> [*]
  cancelled --> [*]
```

`uncollected` is set only by the background job; staff drive `preparing`, `ready` and `served`; customers and staff can cancel.

## Reservation lifecycle

```mermaid
stateDiagram-v2
  [*] --> confirmed: table held
  [*] --> seated: walk-in
  confirmed --> seated: staff
  confirmed --> cancelled: customer or staff, table freed
  confirmed --> no_show: job, 20 min after start, table freed
  seated --> completed: staff (frees the table early) or job at end time
  cancelled --> [*]
  no_show --> [*]
  completed --> [*]
```

Only `confirmed` and `seated` reservations occupy a table.

## Holding stock safely

```mermaid
sequenceDiagram
  participant G as Guest
  participant O as OrderService
  participant I as InventoryRepository
  participant D as MongoDB
  G->>O: place order (2 pizzas)
  O->>I: reserve [dough 500, cheese 200]
  I->>D: dough: update if stock-reserved >= 500, reserved += 500
  D-->>I: matched
  I->>D: cheese: update if stock-reserved >= 200, reserved += 200
  D-->>I: NOT matched (short)
  I->>D: dough: reserved -= 500 (compensate)
  I-->>O: shortages [cheese]
  O-->>G: 409 INSUFFICIENT_STOCK
```

Every arrow to MongoDB is a single-document atomic update, so no two requests can interleave inside one check-and-change.

## Why some choices were made

- **Services never see `req`/`res`.** Business rules are tested by calling the API or the service with a fake clock.
- **The clock is injected.** Opening hours, grace periods and "20 minutes after" rules are tested to the second without waiting.
- **Atomic operations live in repositories**, not services, because they depend on MongoDB behaviour (conditional updates, update pipelines, a partial unique index).
- **Events are awaited but isolated.** Menu availability must be correct when the response is sent, so publishers wait for subscribers; a failing subscriber is logged and cannot fail the request.
- **Docs come from the validators.** Zod schemas validate requests and are converted to the OpenAPI document, so documented and enforced inputs cannot differ.
