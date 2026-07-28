-- Reference queries for the analytics dataset (dataset.sqlite).
-- These are to help you get oriented and to sanity-check your own numbers.
-- They are NOT a required solution — your API/dashboard can compute things differently.
-- Run with:  sqlite3 dataset.sqlite < reference-queries.sql
-- (Queries using :params below are templates; substitute values to run them.)

-- 1) Sales over time (monthly revenue + order count)
SELECT strftime('%Y-%m', o.created_at)            AS month,
       ROUND(SUM(oi.quantity * oi.unit_price), 2) AS revenue,
       COUNT(DISTINCT o.id)                        AS orders
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
GROUP BY month
ORDER BY month;

-- 2) Top 10 products by revenue
SELECT p.id, p.name, b.name AS brand,
       SUM(oi.quantity)                            AS units,
       ROUND(SUM(oi.quantity * oi.unit_price), 2)  AS revenue
FROM order_items oi
JOIN products p ON p.id = oi.product_id
JOIN brands   b ON b.id = p.brand_id
GROUP BY p.id
ORDER BY revenue DESC
LIMIT 10;

-- 3) Top brands by revenue
SELECT b.name,
       ROUND(SUM(oi.quantity * oi.unit_price), 2) AS revenue,
       SUM(oi.quantity)                            AS units
FROM order_items oi
JOIN products p ON p.id = oi.product_id
JOIN brands   b ON b.id = p.brand_id
GROUP BY b.id
ORDER BY revenue DESC;

-- 4) Frequently bought together with product :pid  (co-occurrence within the same order)
--    e.g. replace :pid with 1
SELECT p2.id, p2.name, p2.category, COUNT(*) AS times_together
FROM order_items a
JOIN order_items b  ON b.order_id = a.order_id AND b.product_id <> a.product_id
JOIN products    p2 ON p2.id = b.product_id
WHERE a.product_id = :pid
GROUP BY p2.id
ORDER BY times_together DESC
LIMIT 10;

-- 5) How many OTHER customers also bought product :pid
SELECT COUNT(DISTINCT o.customer_id) AS customers_who_bought
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
WHERE oi.product_id = :pid;

-- 6) Sales over time filtered by date range + brand (params :start, :end, :brand)
--    :start / :end are ISO dates, e.g. '2026-01-01' / '2026-04-01' ( [start, end) )
SELECT strftime('%Y-%m', o.created_at)            AS month,
       ROUND(SUM(oi.quantity * oi.unit_price), 2) AS revenue
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
JOIN products p ON p.id = oi.product_id
JOIN brands   b ON b.id = p.brand_id
WHERE o.created_at >= :start AND o.created_at < :end
  AND b.name = :brand
GROUP BY month
ORDER BY month;
