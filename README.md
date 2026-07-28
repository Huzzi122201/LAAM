# LAAM Buyer-Behaviour Analytics Dashboard

A server-side analytics dashboard for the LAAM South Asian fashion marketplace, built to answer the merchandising team's recurring questions about sales trends, top products, top brands, and co-purchase patterns — without manual SQL queries.

---

## 1. Problem Understanding

LAAM's merchandising and operations teams needed a self-service way to understand buyer behaviour: which products and brands sell, how sales move over time, and which products tend to be bought together. Previously, every question required someone to write a one-off SQL query against the raw orders database.

**Focus area**: I prioritised *correctness and efficiency of server-side aggregations* and a *clean filtering UX that actually works at the boundaries* (empty ranges, no-match filters). The goal is a small, correct tool — not a flashy charting showcase with broken filters.

---

## 2. Scope

### Built (Core + Stretch)
- **Sales over time** — line/bar chart with monthly/weekly/daily granularity
- **Filters** — date range (start/end), brand, category, granularity selector with a reset button
- **KPI strip** — total revenue, orders, units sold, avg order value (derived from filtered data)
- **Top-selling products** — paginated table (10 per page) with rank, brand, category, units, revenue
- **Top-selling brands** — horizontal bar chart, sorted by revenue
- **Frequently bought together** — co-occurrence analysis (click any product row)
- **"N other customers also bought this"** — customer count per product
- **Brand drill-down** — click any brand bar → modal shows its products sorted by revenue
- **Pagination** — top-products supports `limit`/`offset` for large result sets
- **Edge cases** — empty state messaging for all sections when filters return no data

### Intentionally Not Built
- Period-over-period comparison (significant additional complexity)
- CSV/PDF export
- Authentication / authorisation
- Docker setup (per reviewer instruction)

---

## 3. User Flow / Behaviour

```
┌─────────────────────────────────────────────────────────────────┐
│  Dashboard loads → /api/meta populates filter dropdowns         │
│  Initial data load → /api/sales-over-time, /api/top-products,  │
│                      /api/top-brands                            │
├─────────────────────────────────────────────────────────────────┤
│  User adjusts filters → debounced (250ms) re-fetch of all      │
│  three data endpoints with filter params                        │
├─────────────────────────────────────────────────────────────────┤
│  Click product row → /api/products/:id/bought-together          │
│                    → /api/products/:id/also-bought               │
│                    → Modal: co-purchases + customer count        │
├─────────────────────────────────────────────────────────────────┤
│  Click brand bar → /api/brands/:id/products                     │
│                  → Modal: brand's products ranked by revenue     │
└─────────────────────────────────────────────────────────────────┘
```

**Request lifecycle**: Browser → Express endpoint → parameterised SQL query via `better-sqlite3` → JSON response → Chart.js / DOM rendering. All aggregation (GROUP BY, JOINs, SUM, COUNT DISTINCT) happens in SQL on the server. The client receives pre-computed totals only.

---

## 4. Technical Approach

### Architecture
```
analytics/
├── dataset.sqlite          # Seed database (readonly)
├── server/
│   ├── package.json
│   ├── db.js               # SQLite connection, WAL mode, cache config
│   ├── index.js             # Express API — 7 endpoints
│   ├── test-app.js          # App module for test isolation
│   └── test.js              # 38 integration tests
├── client/
│   ├── index.html           # Single-page dashboard
│   ├── styles.css           # Dark theme, responsive design
│   └── app.js               # Fetch + Chart.js rendering
├── generate.py              # (provided) Dataset generator
└── reference-queries.sql    # (provided) Reference queries
```

### Key Technical Decisions

| Decision | Rationale |
|---|---|
| **Node.js + Express + better-sqlite3** | Synchronous reads are ideal for analytics (read-only). No ORM overhead. Zero config. |
| **Vanilla HTML/CSS/JS frontend** | No build step, no bundler config. Focus time on queries not tooling. |
| **Chart.js via CDN** | Proven, lightweight. No npm build pipeline needed for the client. |
| **Dynamic WHERE clause composition** | `buildFilters()` composes SQL clauses from query params. Prevents SQL injection via named parameters (`@param`). |
| **Server-side aggregation** | All GROUP BY, SUM, COUNT DISTINCT happens in SQL. Client receives only pre-aggregated JSON arrays. |
| **Half-open date intervals** | `[start, end)` — consistent with the reference queries and avoids off-by-one boundary issues. The end date gets `T23:59:59` appended client-side so the user's selected end date is fully inclusive. |
| **WAL journal mode** | Better concurrent read performance, even though we're single-process. |
| **Existing indexes** | The seed data already has `idx_oi_order`, `idx_oi_product`, `idx_orders_created`, `idx_products_brand`. These cover the main query patterns. For ~5K rows, additional indexes aren't needed. |

### Data Model
The SQLite schema (from `generate.py`):
- `brands(id, name)` — 6 brands
- `products(id, name, brand_id, category, price)` — 36 products across 10 categories
- `customers(id, name, city, created_at)` — 200 customers
- `orders(id, customer_id, created_at, status)` — 2,600 orders (all "completed")
- `order_items(id, order_id, product_id, quantity, unit_price)` — 5,155 line items

No schema changes were needed. The existing indexes are sufficient.

---

## 5. How to Run

**Prerequisites**: Node.js ≥ 18

```bash
# Clone / download, then:
cd analytics

# Install backend dependencies
cd server
npm install

# Start the server (serves API + frontend on port 3001)
cd ..
node server/index.js
```

Open **http://localhost:3001** in your browser.

### Run Tests
```bash
node server/test.js
```

---

## 6. Tests

### What's Tested (38 tests)
- **`/api/meta`** — returns 6 brands, 10 categories, valid date range
- **`/api/sales-over-time`** — 12 months of data, correct period format, revenue is positive
- **Filter composition** — brand filter reduces total revenue; date range produces correct subset
- **Empty ranges** — future date range returns empty array (not an error)
- **`/api/top-products`** — pagination correctness, revenue sort order, total count
- **Category filter** — filtering by "Lehenga" returns only Lehengas
- **`/api/top-brands`** — 6 brands, revenue-sorted, units field present
- **`/api/brands/:id/products`** — correct brand name, products sorted
- **`/api/products/:id/bought-together`** — Lehenga #025's top co-purchase is Dupatta (validates affinity pattern)
- **Invalid product ID** — returns 404
- **`/api/products/:id/also-bought`** — positive customer count

### What I'd Test Next (if more time)
1. **Concurrent filter combinations** — brand + category + date range together
2. **Weekly/daily granularity** — verify period format correctness
3. **Frontend tests** — Playwright/Cypress for filter interaction, chart rendering, modal open/close
4. **Boundary dates** — exact start/end timestamps at midnight
5. **Performance** — response times under 50ms for all endpoints

---

## 7. Tradeoffs

| Tradeoff | Reasoning |
|---|---|
| **Duplicated route logic** between `index.js` and `test-app.js` | Avoids modifying the main server's startup behaviour. In production, I'd extract shared routes into a router module. |
| **No client-side build pipeline** | Saves ~30 min of tooling config. Vanilla JS is sufficient for this dashboard's complexity. |
| **No period-over-period comparison** | Would require a more complex UI (two date ranges, diff calculation). Cut for time. |
| **Chart.js via CDN** | Adds a runtime dependency on jsDelivr. In production, I'd bundle it. |
| **No caching layer** | With ~5K rows and synchronous reads, queries return in <10ms. Caching would add complexity with no measurable benefit at this scale. |
| **No authentication** | Internal analytics tool — auth was out of scope. |

---

## 8. Future Improvements

### Near-term
- **Extract shared route module** — DRY up the `index.js` / `test-app.js` duplication
- **Period-over-period comparison** — "Mar 2026 vs Mar 2025" overlaid chart
- **CSV export** — download filtered results
- **Summary tables / materialised views** — pre-compute monthly aggregates for O(1) lookups at larger scale

### Production-ready
- **Rate limiting + error handling middleware**
- **Structured logging** (pino or winston)
- **Connection pooling** if moving to PostgreSQL
- **Client bundling** (Vite) with tree-shaking
- **CI/CD pipeline** with automated tests
- **Authentication** (JWT or session-based)
- **Monitoring + alerting** (response times, error rates)

---

## 9. AI Usage

AI (Claude via Gemini Code Assist) was used as a pair-programming partner throughout this build. Below is a detailed, timestamped work log of all AI-assisted activities.

### Work Log

| Time (PKT) | Duration | Activity | AI Role | Human Decision |
|---|---|---|---|---|
| 15:32 | 3 min | **Project exploration** — Examined `dataset.sqlite` schema, `generate.py`, and `reference-queries.sql` to understand data shape (6 brands, 36 products, 2,600 orders, 5,155 items, Jul 2025–Jun 2026) | AI wrote a Python script to query table counts, sample rows, date ranges, and categories | I reviewed the output and identified key patterns: all orders are "completed" status, affinity pairs exist (Lehenga↔Dupatta, Kameez↔Shalwar) |
| 15:35 | 3 min | **Architecture planning** — Created implementation plan with endpoint design, query patterns, and scope decisions | AI drafted the plan document with table of endpoints and query logic | I chose Node.js + Express + better-sqlite3 over Python/Flask (faster development for this use case), decided to skip Docker per reviewer feedback, scoped out period-over-period |
| 15:38 | 1 min | **Plan review** — User approved plan with Docker skip | — | Explicit approval to proceed |
| 15:39 | 5 min | **Backend scaffolding** — Created `server/package.json`, `server/db.js`, `server/index.js` | AI generated all three files. I specified the endpoint structure and filter composition approach; AI implemented the SQL queries and Express routing | I verified the SQL matched the reference query patterns, especially the half-open date interval `[start, end)` and the co-occurrence self-join |
| 15:40 | 1 min | **Dependency install** — `npm install` in `server/` | AI ran the command | — |
| 15:41 | 3 min | **Frontend HTML** — Created `client/index.html` with filter bar, KPI cards, charts, tables, and modals | AI generated the full HTML structure | I specified the layout order (KPIs → sales chart → brands + products side-by-side) and the modal interaction pattern |
| 15:42 | 3 min | **CSS styling** — Created `client/styles.css` with dark navy + gold accent theme | AI generated the complete CSS with design tokens, responsive breakpoints, and animations | I chose the dark theme colour palette and specified Inter font |
| 15:43 | 5 min | **Client JavaScript** — Created `client/app.js` with fetch logic, Chart.js rendering, filter handling, pagination, and modal interactions | AI generated all client logic | I reviewed the debounce approach (250ms), the empty-state handling, and the KPI derivation from sales data. I specified that the end date should append T23:59:59 for inclusive behaviour |
| 15:43 | 1 min | **Bug fix** — `SQLITE_READONLY` error when setting WAL pragma on readonly-opened DB | AI identified the issue (WAL requires write access) and removed the `readonly: true` flag | I verified the fix was correct — we never write, so removing readonly is safe |
| 15:44 | 2 min | **API verification** — Tested all endpoints via PowerShell `Invoke-RestMethod` | AI wrote the test commands | I verified the response shapes matched expectations and cross-checked revenue totals against the reference queries |
| 15:45 | 10 min | **Browser testing** — Opened dashboard at localhost:3001, tested all interactions | AI automated browser testing: initial load, Khaadi filter, reset, product modal, brand drill-down | Zero console errors. I verified the co-occurrence results (Lehenga #025 → Dupatta is #1) matched the reference query output |
| 15:57 | 3 min | **Integration tests** — Created `server/test.js` and `server/test-app.js` (38 tests) | AI generated both test files | I specified the test cases: filter composition, pagination ordering, affinity pattern validation, 404 handling, empty range handling |
| 15:59 | 1 min | **Test execution** — All 38 tests pass | AI ran `node server/test.js` | I reviewed the output to confirm all assertions |
| 16:00 | 5 min | **README** — Created comprehensive README with all 9 required sections | AI drafted the README structure and content | I wrote the tradeoffs and future improvements sections based on my actual decision-making process |

### How AI Was Used Responsibly
- **AI generated code; I made architecture and design decisions** — which stack, which endpoints, which scope to cut, which edge cases matter
- **All SQL queries were verified** against the reference queries provided in `reference-queries.sql`
- **Co-occurrence results were validated** against the known affinity patterns in `generate.py` (Lehenga↔Dupatta, Kameez↔Shalwar)
- **Every bug was root-caused** (e.g., the `SQLITE_READONLY` issue) rather than blindly trying fixes
- **Tests validate correctness**, not just that endpoints return 200
