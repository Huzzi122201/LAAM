/**
 * index.js — Express API for the LAAM analytics dashboard.
 *
 * Every endpoint computes its aggregation server-side in SQL and
 * returns compact JSON.  The frontend never receives raw rows.
 *
 * Endpoints
 * ─────────
 *   GET /api/meta                  → brands, categories, date range
 *   GET /api/sales-over-time       → [{period, revenue, orders}]
 *   GET /api/top-products          → [{id, name, brand, category, units, revenue}]
 *   GET /api/top-brands            → [{id, name, units, revenue}]
 *   GET /api/brands/:id/products   → [{id, name, category, units, revenue}]
 *   GET /api/products/:id/bought-together  → [{id, name, category, brand, count}]
 *   GET /api/products/:id/also-bought      → {count}
 */

const express = require("express");
const cors = require("cors");
const path = require("path");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve the client directory as static files
app.use(express.static(path.resolve(__dirname, "..", "client")));

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Build dynamic WHERE clause fragments from common query-string filters.
 * Returns { clauses: string[], params: object }.
 */
function buildFilters(query) {
  const clauses = [];
  const params = {};

  if (query.start) {
    clauses.push("o.created_at >= @start");
    params.start = query.start;
  }
  if (query.end) {
    clauses.push("o.created_at < @end");
    params.end = query.end;
  }
  if (query.brand) {
    clauses.push("b.id = @brandId");
    params.brandId = Number(query.brand);
  }
  if (query.category) {
    clauses.push("p.category = @category");
    params.category = query.category;
  }
  return { clauses, params };
}

/** Compose WHERE string from an array of clause strings. */
function whereSQL(clauses) {
  return clauses.length ? "WHERE " + clauses.join(" AND ") : "";
}

// ────────────────────────────────────────────────────────────────────
// GET /api/meta — filter options + date range
// ────────────────────────────────────────────────────────────────────
app.get("/api/meta", (_req, res) => {
  const brands = db.prepare("SELECT id, name FROM brands ORDER BY name").all();
  const categories = db
    .prepare("SELECT DISTINCT category FROM products ORDER BY category")
    .all()
    .map((r) => r.category);
  const dateRange = db
    .prepare("SELECT MIN(created_at) AS min_date, MAX(created_at) AS max_date FROM orders")
    .get();

  res.json({ brands, categories, dateRange });
});

// ────────────────────────────────────────────────────────────────────
// GET /api/sales-over-time
// Query params: start, end, brand, category, granularity (month|week|day)
// ────────────────────────────────────────────────────────────────────
app.get("/api/sales-over-time", (req, res) => {
  const granularity = req.query.granularity || "month";
  let timeBucket;
  switch (granularity) {
    case "week":
      timeBucket = "strftime('%Y-W%W', o.created_at)";
      break;
    case "day":
      timeBucket = "strftime('%Y-%m-%d', o.created_at)";
      break;
    default: // month
      timeBucket = "strftime('%Y-%m', o.created_at)";
  }

  const { clauses, params } = buildFilters(req.query);

  // Always join products+brands so brand/category filters can apply
  const sql = `
    SELECT ${timeBucket}                              AS period,
           ROUND(SUM(oi.quantity * oi.unit_price), 2) AS revenue,
           COUNT(DISTINCT o.id)                       AS orders,
           SUM(oi.quantity)                            AS units
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN products   p  ON p.id = oi.product_id
    JOIN brands     b  ON b.id = p.brand_id
    ${whereSQL(clauses)}
    GROUP BY period
    ORDER BY period
  `;

  const rows = db.prepare(sql).all(params);
  res.json(rows);
});

// ────────────────────────────────────────────────────────────────────
// GET /api/top-products
// Query params: start, end, brand, category, limit (default 10), offset
// ────────────────────────────────────────────────────────────────────
app.get("/api/top-products", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 100);
  const offset = Number(req.query.offset) || 0;
  const { clauses, params } = buildFilters(req.query);

  params.limit = limit;
  params.offset = offset;

  const sql = `
    SELECT p.id,
           p.name,
           b.name                                      AS brand,
           p.category,
           SUM(oi.quantity)                             AS units,
           ROUND(SUM(oi.quantity * oi.unit_price), 2)   AS revenue
    FROM order_items oi
    JOIN orders   o ON o.id = oi.order_id
    JOIN products p ON p.id = oi.product_id
    JOIN brands   b ON b.id = p.brand_id
    ${whereSQL(clauses)}
    GROUP BY p.id
    ORDER BY revenue DESC
    LIMIT @limit OFFSET @offset
  `;

  // Also get total count for pagination
  const countSql = `
    SELECT COUNT(DISTINCT p.id) AS total
    FROM order_items oi
    JOIN orders   o ON o.id = oi.order_id
    JOIN products p ON p.id = oi.product_id
    JOIN brands   b ON b.id = p.brand_id
    ${whereSQL(clauses)}
  `;

  const rows = db.prepare(sql).all(params);
  const { total } = db.prepare(countSql).get(params);

  res.json({ data: rows, total, limit, offset });
});

// ────────────────────────────────────────────────────────────────────
// GET /api/top-brands
// Query params: start, end, category
// ────────────────────────────────────────────────────────────────────
app.get("/api/top-brands", (req, res) => {
  const { clauses, params } = buildFilters(req.query);

  const sql = `
    SELECT b.id,
           b.name,
           SUM(oi.quantity)                             AS units,
           ROUND(SUM(oi.quantity * oi.unit_price), 2)   AS revenue,
           COUNT(DISTINCT o.id)                         AS orders
    FROM order_items oi
    JOIN orders   o ON o.id = oi.order_id
    JOIN products p ON p.id = oi.product_id
    JOIN brands   b ON b.id = p.brand_id
    ${whereSQL(clauses)}
    GROUP BY b.id
    ORDER BY revenue DESC
  `;

  const rows = db.prepare(sql).all(params);
  res.json(rows);
});

// ────────────────────────────────────────────────────────────────────
// GET /api/brands/:id/products — drill-down into a brand
// Query params: start, end, category
// ────────────────────────────────────────────────────────────────────
app.get("/api/brands/:id/products", (req, res) => {
  const brandId = Number(req.params.id);
  const { clauses, params } = buildFilters(req.query);

  // Force brand filter to the URL param
  clauses.push("b.id = @drillBrandId");
  params.drillBrandId = brandId;

  const sql = `
    SELECT p.id,
           p.name,
           p.category,
           SUM(oi.quantity)                             AS units,
           ROUND(SUM(oi.quantity * oi.unit_price), 2)   AS revenue
    FROM order_items oi
    JOIN orders   o ON o.id = oi.order_id
    JOIN products p ON p.id = oi.product_id
    JOIN brands   b ON b.id = p.brand_id
    ${whereSQL(clauses)}
    GROUP BY p.id
    ORDER BY revenue DESC
  `;

  const brand = db.prepare("SELECT name FROM brands WHERE id = ?").get(brandId);
  const rows = db.prepare(sql).all(params);
  res.json({ brand: brand?.name || "Unknown", products: rows });
});

// ────────────────────────────────────────────────────────────────────
// GET /api/products/:id/bought-together — co-occurrence / market basket
// ────────────────────────────────────────────────────────────────────
app.get("/api/products/:id/bought-together", (req, res) => {
  const productId = Number(req.params.id);
  const limit = Math.min(Number(req.query.limit) || 10, 50);

  const sql = `
    SELECT p2.id,
           p2.name,
           p2.category,
           b.name AS brand,
           COUNT(*) AS times_together
    FROM order_items a
    JOIN order_items b2 ON b2.order_id = a.order_id AND b2.product_id <> a.product_id
    JOIN products   p2 ON p2.id = b2.product_id
    JOIN brands     b  ON b.id  = p2.brand_id
    WHERE a.product_id = @productId
    GROUP BY p2.id
    ORDER BY times_together DESC
    LIMIT @limit
  `;

  const product = db
    .prepare(
      `SELECT p.id, p.name, p.category, b.name AS brand
       FROM products p JOIN brands b ON b.id = p.brand_id
       WHERE p.id = ?`
    )
    .get(productId);

  if (!product) {
    return res.status(404).json({ error: "Product not found" });
  }

  const rows = db.prepare(sql).all({ productId, limit });
  res.json({ product, boughtTogether: rows });
});

// ────────────────────────────────────────────────────────────────────
// GET /api/products/:id/also-bought — "N other customers also bought"
// ────────────────────────────────────────────────────────────────────
app.get("/api/products/:id/also-bought", (req, res) => {
  const productId = Number(req.params.id);

  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT o.customer_id) AS customer_count
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE oi.product_id = @productId`
    )
    .get({ productId });

  res.json({ productId, customerCount: row.customer_count });
});

// ────────────────────────────────────────────────────────────────────
// Catch-all: serve index.html for SPA-style routing
// ────────────────────────────────────────────────────────────────────
app.get("*", (_req, res) => {
  res.sendFile(path.resolve(__dirname, "..", "client", "index.html"));
});

// ────────────────────────────────────────────────────────────────────
// Start
// ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`LAAM Analytics API running on http://localhost:${PORT}`);
});
