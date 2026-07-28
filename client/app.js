/**
 * app.js — LAAM Analytics Dashboard client logic.
 *
 * Fetches server-computed aggregates and renders them with Chart.js.
 * All heavy lifting (GROUP BY, JOINs, filtering) happens server-side;
 * this file is purely presentation + user interaction.
 */

const API = window.location.origin;

// ── State ──────────────────────────────────────────────────────────
let salesChart = null;
let brandsChart = null;
let salesChartType = "line";
let productsPage = 0;
const PRODUCTS_PER_PAGE = 10;

// Cached metadata
let meta = { brands: [], categories: [], dateRange: {} };

// ── DOM refs ───────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const els = {
  filterStart:       $("filter-start"),
  filterEnd:         $("filter-end"),
  filterBrand:       $("filter-brand"),
  filterCategory:    $("filter-category"),
  filterGranularity: $("filter-granularity"),
  btnReset:          $("btn-reset-filters"),
  headerDateRange:   $("header-date-range"),
  kpiRevenue:        $("kpi-revenue-value"),
  kpiOrders:         $("kpi-orders-value"),
  kpiUnits:          $("kpi-units-value"),
  kpiAvgOrder:       $("kpi-avg-order-value"),
  salesEmpty:        $("sales-empty"),
  brandsEmpty:       $("brands-empty"),
  productsEmpty:     $("products-empty"),
  productsTbody:     $("products-tbody"),
  productsPagination:$("products-pagination"),
  loading:           $("loading"),

  // Modals
  brandOverlay:      $("modal-brand-overlay"),
  brandTitle:        $("modal-brand-title"),
  brandClose:        $("modal-brand-close"),
  brandTbody:        $("brand-products-tbody"),

  productOverlay:    $("modal-product-overlay"),
  productTitle:      $("modal-product-title"),
  productClose:      $("modal-product-close"),
  alsoBoughtCount:   $("also-bought-count"),
  boughtTogetherTbody: $("bought-together-tbody"),
  boughtTogetherEmpty: $("bought-together-empty"),
};

// ── Helpers ─────────────────────────────────────────────────────────
function formatCurrency(n) {
  if (n == null) return "—";
  return "₨ " + Number(n).toLocaleString("en-PK", { maximumFractionDigits: 0 });
}

function formatNumber(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString("en-PK");
}

function showLoading() { els.loading.classList.remove("hidden"); }
function hideLoading() { els.loading.classList.add("hidden"); }

function buildQuery(extra = {}) {
  const params = new URLSearchParams();
  if (els.filterStart.value)       params.set("start", els.filterStart.value);
  if (els.filterEnd.value)         params.set("end", els.filterEnd.value + "T23:59:59");
  if (els.filterBrand.value)       params.set("brand", els.filterBrand.value);
  if (els.filterCategory.value)    params.set("category", els.filterCategory.value);
  if (els.filterGranularity.value) params.set("granularity", els.filterGranularity.value);
  Object.entries(extra).forEach(([k, v]) => { if (v != null) params.set(k, v); });
  return params.toString();
}

async function apiFetch(path, extra = {}) {
  const qs = buildQuery(extra);
  const url = `${API}${path}${qs ? "?" + qs : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// Chart.js colour palette
const PALETTE = [
  "#f59e0b", "#3b82f6", "#8b5cf6", "#ec4899",
  "#14b8a6", "#f97316", "#06b6d4", "#a3e635",
];

function chartColor(i, alpha = 1) {
  const hex = PALETTE[i % PALETTE.length];
  if (alpha === 1) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Initialise ─────────────────────────────────────────────────────
async function init() {
  showLoading();
  try {
    meta = await (await fetch(`${API}/api/meta`)).json();

    // Populate brand dropdown
    meta.brands.forEach((b) => {
      const opt = document.createElement("option");
      opt.value = b.id;
      opt.textContent = b.name;
      els.filterBrand.appendChild(opt);
    });

    // Populate category dropdown
    meta.categories.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      els.filterCategory.appendChild(opt);
    });

    // Set date range defaults
    const minDate = meta.dateRange.min_date?.split(" ")[0] || "";
    const maxDate = meta.dateRange.max_date?.split(" ")[0] || "";
    els.filterStart.value = minDate;
    els.filterEnd.value = maxDate;
    els.filterStart.min = minDate;
    els.filterStart.max = maxDate;
    els.filterEnd.min = minDate;
    els.filterEnd.max = maxDate;
    els.headerDateRange.textContent = `${minDate}  →  ${maxDate}`;

    // Wire events
    wireEvents();

    // Initial data load
    await refreshAll();
  } catch (err) {
    console.error("Init error:", err);
  } finally {
    hideLoading();
  }
}

function wireEvents() {
  // Filters trigger refresh (debounced)
  let debounce;
  const onFilterChange = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      productsPage = 0;
      refreshAll();
    }, 250);
  };
  els.filterStart.addEventListener("change", onFilterChange);
  els.filterEnd.addEventListener("change", onFilterChange);
  els.filterBrand.addEventListener("change", onFilterChange);
  els.filterCategory.addEventListener("change", onFilterChange);
  els.filterGranularity.addEventListener("change", onFilterChange);

  // Reset
  els.btnReset.addEventListener("click", () => {
    const minDate = meta.dateRange.min_date?.split(" ")[0] || "";
    const maxDate = meta.dateRange.max_date?.split(" ")[0] || "";
    els.filterStart.value = minDate;
    els.filterEnd.value = maxDate;
    els.filterBrand.value = "";
    els.filterCategory.value = "";
    els.filterGranularity.value = "month";
    productsPage = 0;
    salesChartType = "line";
    document.querySelectorAll(".toggle-btn").forEach((b) => b.classList.remove("active"));
    $("btn-line").classList.add("active");
    refreshAll();
  });

  // Chart type toggle
  document.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".toggle-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      salesChartType = btn.dataset.chartType;
      refreshSalesChart();
    });
  });

  // Modal close handlers
  els.brandClose.addEventListener("click", closeBrandModal);
  els.brandOverlay.addEventListener("click", (e) => {
    if (e.target === els.brandOverlay) closeBrandModal();
  });
  els.productClose.addEventListener("click", closeProductModal);
  els.productOverlay.addEventListener("click", (e) => {
    if (e.target === els.productOverlay) closeProductModal();
  });

  // ESC key closes modals
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeBrandModal();
      closeProductModal();
    }
  });
}

// ── Refresh All ────────────────────────────────────────────────────
let _salesData = [];

async function refreshAll() {
  showLoading();
  try {
    await Promise.all([
      refreshSalesChart(),
      refreshTopBrands(),
      refreshTopProducts(),
    ]);
  } catch (err) {
    console.error("Refresh error:", err);
  } finally {
    hideLoading();
  }
}

// ── Sales Over Time ────────────────────────────────────────────────
async function refreshSalesChart() {
  const data = await apiFetch("/api/sales-over-time");
  _salesData = data;

  // Update KPIs
  const totalRevenue = data.reduce((s, d) => s + (d.revenue || 0), 0);
  const totalOrders  = data.reduce((s, d) => s + (d.orders || 0), 0);
  const totalUnits   = data.reduce((s, d) => s + (d.units || 0), 0);
  const avgOrder     = totalOrders ? totalRevenue / totalOrders : 0;

  els.kpiRevenue.textContent  = formatCurrency(totalRevenue);
  els.kpiOrders.textContent   = formatNumber(totalOrders);
  els.kpiUnits.textContent    = formatNumber(totalUnits);
  els.kpiAvgOrder.textContent = formatCurrency(avgOrder);

  // Update header date range badge to reflect active filters
  const start = els.filterStart.value || "start";
  const end   = els.filterEnd.value   || "end";
  els.headerDateRange.textContent = `${start}  →  ${end}`;

  // Toggle empty state
  if (data.length === 0) {
    els.salesEmpty.classList.remove("hidden");
    if (salesChart) { salesChart.destroy(); salesChart = null; }
    return;
  }
  els.salesEmpty.classList.add("hidden");

  const labels = data.map((d) => d.period);
  const revenueData = data.map((d) => d.revenue);

  if (salesChart) salesChart.destroy();

  const ctx = $("chart-sales").getContext("2d");
  salesChart = new Chart(ctx, {
    type: salesChartType,
    data: {
      labels,
      datasets: [
        {
          label: "Revenue (₨)",
          data: revenueData,
          borderColor: "#f59e0b",
          backgroundColor:
            salesChartType === "line"
              ? "rgba(245,158,11,0.08)"
              : "rgba(245,158,11,0.6)",
          borderWidth: 2.5,
          fill: salesChartType === "line",
          tension: 0.35,
          pointRadius: salesChartType === "line" ? 4 : 0,
          pointBackgroundColor: "#f59e0b",
          pointBorderColor: "#0b0f1a",
          pointBorderWidth: 2,
          pointHoverRadius: 7,
          borderRadius: salesChartType === "bar" ? 4 : 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#1a2235",
          titleColor: "#f1f5f9",
          bodyColor: "#94a3b8",
          borderColor: "#1e293b",
          borderWidth: 1,
          padding: 12,
          callbacks: {
            label: (ctx) => `Revenue: ${formatCurrency(ctx.raw)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: "rgba(30,41,59,0.4)" },
          ticks: { color: "#64748b", font: { size: 11 } },
        },
        y: {
          grid: { color: "rgba(30,41,59,0.4)" },
          ticks: {
            color: "#64748b",
            font: { size: 11 },
            callback: (v) => "₨ " + (v / 1000).toFixed(0) + "k",
          },
        },
      },
    },
  });
}

// ── Top Brands ─────────────────────────────────────────────────────
async function refreshTopBrands() {
  const data = await apiFetch("/api/top-brands");

  if (data.length === 0) {
    els.brandsEmpty.classList.remove("hidden");
    if (brandsChart) { brandsChart.destroy(); brandsChart = null; }
    return;
  }
  els.brandsEmpty.classList.add("hidden");

  const labels = data.map((d) => d.name);
  const revenues = data.map((d) => d.revenue);
  const bgColors = data.map((_, i) => chartColor(i, 0.75));
  const borderColors = data.map((_, i) => chartColor(i));

  if (brandsChart) brandsChart.destroy();

  const ctx = $("chart-brands").getContext("2d");
  brandsChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Revenue (₨)",
          data: revenues,
          backgroundColor: bgColors,
          borderColor: borderColors,
          borderWidth: 1.5,
          borderRadius: 6,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      onClick: (_e, elements) => {
        if (elements.length > 0) {
          const idx = elements[0].index;
          openBrandDrillDown(data[idx].id, data[idx].name);
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#1a2235",
          titleColor: "#f1f5f9",
          bodyColor: "#94a3b8",
          borderColor: "#1e293b",
          borderWidth: 1,
          padding: 12,
          callbacks: {
            label: (ctx) => `Revenue: ${formatCurrency(ctx.raw)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: "rgba(30,41,59,0.4)" },
          ticks: {
            color: "#64748b",
            font: { size: 11 },
            callback: (v) => "₨ " + (v / 1000000).toFixed(1) + "M",
          },
        },
        y: {
          grid: { display: false },
          ticks: { color: "#94a3b8", font: { size: 12, weight: "500" } },
        },
      },
    },
  });
}

// ── Top Products ───────────────────────────────────────────────────
async function refreshTopProducts() {
  const data = await apiFetch("/api/top-products", {
    limit: PRODUCTS_PER_PAGE,
    offset: productsPage * PRODUCTS_PER_PAGE,
  });

  const { data: products, total } = data;

  if (products.length === 0) {
    els.productsEmpty.classList.remove("hidden");
    els.productsTbody.innerHTML = "";
    els.productsPagination.innerHTML = "";
    return;
  }
  els.productsEmpty.classList.add("hidden");

  // Render table
  els.productsTbody.innerHTML = products
    .map(
      (p, i) => `
    <tr data-product-id="${p.id}" data-product-name="${escapeHTML(p.name)}">
      <td>${productsPage * PRODUCTS_PER_PAGE + i + 1}</td>
      <td title="${escapeHTML(p.name)}">${escapeHTML(p.name)}</td>
      <td>${escapeHTML(p.brand)}</td>
      <td>${escapeHTML(p.category)}</td>
      <td class="num">${formatNumber(p.units)}</td>
      <td class="num">${formatCurrency(p.revenue)}</td>
    </tr>`
    )
    .join("");

  // Click handler for product rows
  els.productsTbody.querySelectorAll("tr").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.productId;
      const name = row.dataset.productName;
      openProductInsights(id, name);
    });
  });

  // Pagination
  const totalPages = Math.ceil(total / PRODUCTS_PER_PAGE);
  const currentPage = productsPage + 1;
  els.productsPagination.innerHTML = `
    <button id="btn-prev" ${productsPage === 0 ? "disabled" : ""}>← Prev</button>
    <span class="page-info">${currentPage} / ${totalPages} (${total} products)</span>
    <button id="btn-next" ${currentPage >= totalPages ? "disabled" : ""}>Next →</button>
  `;

  $("btn-prev")?.addEventListener("click", () => {
    if (productsPage > 0) { productsPage--; refreshTopProducts(); }
  });
  $("btn-next")?.addEventListener("click", () => {
    if (currentPage < totalPages) { productsPage++; refreshTopProducts(); }
  });
}

// ── Brand Drill-Down Modal ─────────────────────────────────────────
async function openBrandDrillDown(brandId, brandName) {
  els.brandTitle.textContent = `${brandName} — Products`;
  els.brandOverlay.classList.remove("hidden");

  // Fetch with current filters but force brand
  const qs = buildQuery({ brand: brandId });
  const url = `${API}/api/brands/${brandId}/products?${qs}`;
  const data = await (await fetch(url)).json();

  els.brandTbody.innerHTML = data.products
    .map(
      (p, i) => `
    <tr>
      <td>${i + 1}</td>
      <td title="${escapeHTML(p.name)}">${escapeHTML(p.name)}</td>
      <td>${escapeHTML(p.category)}</td>
      <td class="num">${formatNumber(p.units)}</td>
      <td class="num">${formatCurrency(p.revenue)}</td>
    </tr>`
    )
    .join("");
}

function closeBrandModal() {
  els.brandOverlay.classList.add("hidden");
}

// ── Product Insights Modal ─────────────────────────────────────────
async function openProductInsights(productId, productName) {
  els.productTitle.textContent = productName;
  els.productOverlay.classList.remove("hidden");
  els.alsoBoughtCount.textContent = "…";
  els.boughtTogetherTbody.innerHTML = "";
  els.boughtTogetherEmpty.classList.add("hidden");

  try {
    const [together, alsoBought] = await Promise.all([
      (await fetch(`${API}/api/products/${productId}/bought-together`)).json(),
      (await fetch(`${API}/api/products/${productId}/also-bought`)).json(),
    ]);

    els.alsoBoughtCount.textContent = formatNumber(alsoBought.customerCount);

    if (together.boughtTogether.length === 0) {
      els.boughtTogetherEmpty.classList.remove("hidden");
    } else {
      els.boughtTogetherTbody.innerHTML = together.boughtTogether
        .map(
          (p, i) => `
        <tr>
          <td>${i + 1}</td>
          <td title="${escapeHTML(p.name)}">${escapeHTML(p.name)}</td>
          <td>${escapeHTML(p.brand)}</td>
          <td>${escapeHTML(p.category)}</td>
          <td class="num">${formatNumber(p.times_together)}</td>
        </tr>`
        )
        .join("");
    }
  } catch (err) {
    console.error("Product insights error:", err);
    els.boughtTogetherEmpty.textContent = "Failed to load insights.";
    els.boughtTogetherEmpty.classList.remove("hidden");
  }
}

function closeProductModal() {
  els.productOverlay.classList.add("hidden");
}

// ── Utilities ──────────────────────────────────────────────────────
function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Boot ───────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", init);
