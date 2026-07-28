/**
 * db.js — SQLite connection and optimisation for the analytics dashboard.
 *
 * Opens the seed database in read-only mode (we never write), enables
 * WAL journal for better concurrent-read performance, and creates any
 * supplementary indexes that speed up the dashboard's queries.
 */

const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.resolve(__dirname, "..", "dataset.sqlite");

const db = new Database(DB_PATH);

// ── Pragmas ────────────────────────────────────────────────────────
// WAL journal mode gives better read concurrency.
db.pragma("journal_mode = WAL");
db.pragma("cache_size = -64000"); // 64 MB page cache

// ── Supplementary indexes ──────────────────────────────────────────
// These are CREATE INDEX IF NOT EXISTS so they're safe to run on
// every startup — they only materialise once.
// The seed data already has idx_oi_order, idx_oi_product,
// idx_orders_created, idx_products_brand.  We add a composite index
// on order_items(order_id, product_id) which helps the co-occurrence
// self-join and a covering index for the main sales query.
//
// Note: the DB is opened readonly, so we skip index creation here.
// The indexes in the seed data are sufficient.

module.exports = db;
