/**
 * test.js — Basic API tests for the LAAM analytics dashboard.
 *
 * Tests verify that:
 *   1. All endpoints return well-structured JSON.
 *   2. Filters (date range, brand, category) produce correct subsets.
 *   3. Edge cases (empty ranges, invalid IDs) are handled gracefully.
 *   4. Co-occurrence results reflect known data patterns.
 *
 * Run:  node test.js  (starts a temporary server on port 3099)
 */

const http = require("http");
const app = require("./test-app"); // same Express app but doesn't call listen()

const PORT = 3099;
let server;
let passed = 0;
let failed = 0;

// ── Helpers ────────────────────────────────────────────────────────

function get(path) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://localhost:${PORT}${path}`, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(body) });
          } catch (e) {
            resolve({ status: res.statusCode, data: body });
          }
        });
      })
      .on("error", reject);
  });
}

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// ── Tests ──────────────────────────────────────────────────────────

async function runTests() {
  console.log("\n─── LAAM Analytics API Tests ───\n");

  // ── /api/meta ──────────────────────────────────────────────
  console.log("GET /api/meta");
  {
    const { status, data } = await get("/api/meta");
    assert(status === 200, "status 200");
    assert(Array.isArray(data.brands) && data.brands.length === 6, "6 brands");
    assert(Array.isArray(data.categories) && data.categories.length === 10, "10 categories");
    assert(data.dateRange.min_date && data.dateRange.max_date, "date range present");
  }

  // ── /api/sales-over-time ───────────────────────────────────
  console.log("\nGET /api/sales-over-time (monthly)");
  {
    const { status, data } = await get("/api/sales-over-time?granularity=month");
    assert(status === 200, "status 200");
    assert(Array.isArray(data) && data.length === 12, "12 months of data");
    assert(data[0].period === "2025-07", "first month is 2025-07");
    assert(typeof data[0].revenue === "number" && data[0].revenue > 0, "revenue is positive number");
    assert(typeof data[0].orders === "number" && data[0].orders > 0, "orders is positive number");
  }

  console.log("\nGET /api/sales-over-time (filtered by brand)");
  {
    const { data } = await get("/api/sales-over-time?brand=1&granularity=month");
    assert(Array.isArray(data) && data.length > 0, "returns data for brand 1");
    // Should be less than total
    const totalAll = (await get("/api/sales-over-time?granularity=month")).data;
    const totalRevenueAll = totalAll.reduce((s, d) => s + d.revenue, 0);
    const totalRevenueBrand = data.reduce((s, d) => s + d.revenue, 0);
    assert(totalRevenueBrand < totalRevenueAll, "brand filter reduces total revenue");
  }

  console.log("\nGET /api/sales-over-time (filtered by date range)");
  {
    const { data } = await get(
      "/api/sales-over-time?start=2026-01-01&end=2026-03-01&granularity=month"
    );
    assert(Array.isArray(data), "returns array");
    assert(data.every((d) => d.period >= "2026-01" && d.period <= "2026-02"), "all within range");
  }

  console.log("\nGET /api/sales-over-time (empty date range)");
  {
    const { data } = await get(
      "/api/sales-over-time?start=2030-01-01&end=2030-02-01&granularity=month"
    );
    assert(Array.isArray(data) && data.length === 0, "empty array for future dates");
  }

  // ── /api/top-products ──────────────────────────────────────
  console.log("\nGET /api/top-products");
  {
    const { status, data } = await get("/api/top-products?limit=10");
    assert(status === 200, "status 200");
    assert(Array.isArray(data.data) && data.data.length === 10, "returns 10 products");
    assert(data.total === 36, "total is 36 products");
    assert(data.data[0].revenue >= data.data[1].revenue, "sorted by revenue desc");
    assert(typeof data.data[0].brand === "string", "brand field is string");
  }

  console.log("\nGET /api/top-products (pagination)");
  {
    const page1 = (await get("/api/top-products?limit=5&offset=0")).data;
    const page2 = (await get("/api/top-products?limit=5&offset=5")).data;
    assert(page1.data[0].id !== page2.data[0].id, "different products on different pages");
    assert(page1.data[page1.data.length - 1].revenue >= page2.data[0].revenue, "revenue ordering across pages");
  }

  console.log("\nGET /api/top-products (category filter)");
  {
    const { data } = await get("/api/top-products?category=Lehenga&limit=50");
    assert(data.data.every((p) => p.category === "Lehenga"), "all products are Lehengas");
  }

  // ── /api/top-brands ────────────────────────────────────────
  console.log("\nGET /api/top-brands");
  {
    const { status, data } = await get("/api/top-brands");
    assert(status === 200, "status 200");
    assert(Array.isArray(data) && data.length === 6, "6 brands");
    assert(data[0].revenue >= data[1].revenue, "sorted by revenue desc");
    assert(typeof data[0].units === "number", "units field present");
  }

  // ── /api/brands/:id/products ───────────────────────────────
  console.log("\nGET /api/brands/1/products");
  {
    const { status, data } = await get("/api/brands/1/products");
    assert(status === 200, "status 200");
    assert(data.brand === "Sana Safinaz", "correct brand name");
    assert(Array.isArray(data.products) && data.products.length > 0, "has products");
    assert(data.products[0].revenue >= data.products[1].revenue, "sorted by revenue desc");
  }

  // ── /api/products/:id/bought-together ──────────────────────
  console.log("\nGET /api/products/25/bought-together");
  {
    const { status, data } = await get("/api/products/25/bought-together");
    assert(status === 200, "status 200");
    assert(data.product.id === 25, "correct product ID");
    assert(data.product.category === "Lehenga", "product is Lehenga");
    assert(Array.isArray(data.boughtTogether) && data.boughtTogether.length > 0, "has co-purchases");
    // Lehenga → Dupatta affinity should show up
    const topCategory = data.boughtTogether[0].category;
    assert(topCategory === "Dupatta", "top co-purchased category is Dupatta (matching affinity)");
  }

  console.log("\nGET /api/products/9999/bought-together (invalid ID)");
  {
    const { status } = await get("/api/products/9999/bought-together");
    assert(status === 404, "404 for invalid product ID");
  }

  // ── /api/products/:id/also-bought ──────────────────────────
  console.log("\nGET /api/products/25/also-bought");
  {
    const { status, data } = await get("/api/products/25/also-bought");
    assert(status === 200, "status 200");
    assert(typeof data.customerCount === "number" && data.customerCount > 0, "customer count is positive");
  }

  // ── Summary ────────────────────────────────────────────────
  console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
  return failed;
}

// ── Run ────────────────────────────────────────────────────────────
server = app.listen(PORT, async () => {
  try {
    const failures = await runTests();
    server.close();
    process.exit(failures > 0 ? 1 : 0);
  } catch (err) {
    console.error("Test runner error:", err);
    server.close();
    process.exit(1);
  }
});
