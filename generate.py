#!/usr/bin/env python3
"""
Generate dataset.sqlite for the analytics-dashboard assessment.

Deterministic (fixed RNG seed) so top-N and "frequently bought together" results
are stable and can be checked against reference-queries.sql. Standard library only.

Re-run to regenerate:  python3 generate.py
"""
import os
import random
import sqlite3
from datetime import date, timedelta

random.seed(42)

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "dataset.sqlite")

START = date(2025, 7, 1)
END = date(2026, 6, 30)
N_CUSTOMERS = 200
N_ORDERS = 2600

BRANDS = ["Sana Safinaz", "Khaadi", "Maria B", "Generation", "Junaid Jamshed", "Gul Ahmed"]
CITIES = ["Karachi", "Lahore", "Islamabad", "Faisalabad", "Rawalpindi", "Multan", "Peshawar"]

# category -> (price_low, price_high)
CATEGORIES = {
    "Kurta": (2500, 5500),
    "Kameez": (3500, 6500),
    "Shalwar": (1500, 2800),
    "Dupatta": (1200, 2600),
    "Saree": (7000, 18000),
    "Lehenga": (25000, 70000),
    "Kurti": (2200, 3800),
    "Waistcoat": (5000, 9000),
    "Shawl": (4000, 8000),
    "Trousers": (2500, 4200),
}

# If a category is in a basket, its partner is often added too -> market-basket signal.
AFFINITY = {
    "Kameez": "Shalwar",
    "Shalwar": "Kameez",
    "Kurta": "Dupatta",
    "Saree": "Waistcoat",
    "Lehenga": "Dupatta",
    "Kurti": "Trousers",
}

FIRST = ["Ayesha", "Bilal", "Fatima", "Hamza", "Zara", "Usman", "Sana", "Ali",
         "Maryam", "Ahmed", "Hira", "Bilawal", "Noor", "Saad", "Iqra", "Umar"]
LAST = ["Khan", "Malik", "Sheikh", "Butt", "Chaudhry", "Qureshi", "Farooqi",
        "Raza", "Hussain", "Iqbal", "Awan", "Baig"]


def build_products():
    products = []  # (id, name, brand_id, category, price, weight)
    pid = 1
    for brand_id, brand in enumerate(BRANDS, start=1):
        for category in random.sample(list(CATEGORIES), 6):
            lo, hi = CATEGORIES[category]
            price = round(random.randint(lo, hi), -1)
            weight = random.choice([1, 1, 2, 2, 3, 5])  # popularity skew -> non-degenerate top-N
            products.append((pid, f"{category} - {brand} #{pid:03d}", brand_id, category, price, weight))
            pid += 1
    return products


def rand_order_date():
    span = (END - START).days
    while True:
        d = START + timedelta(days=random.randint(0, span))
        boost = 1.8 if d.month in (3, 4, 10, 11) else 1.0          # wedding / Eid season
        boost *= 0.7 + 0.6 * ((d - START).days / span)             # gentle upward trend
        if random.random() < boost / 1.8:
            return d


def main():
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.executescript(
        """
        CREATE TABLE brands (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE products (
            id INTEGER PRIMARY KEY, name TEXT NOT NULL, brand_id INTEGER NOT NULL,
            category TEXT NOT NULL, price REAL NOT NULL,
            FOREIGN KEY (brand_id) REFERENCES brands(id));
        CREATE TABLE customers (
            id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE orders (
            id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, created_at TEXT NOT NULL,
            status TEXT NOT NULL, FOREIGN KEY (customer_id) REFERENCES customers(id));
        CREATE TABLE order_items (
            id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL, unit_price REAL NOT NULL,
            FOREIGN KEY (order_id) REFERENCES orders(id),
            FOREIGN KEY (product_id) REFERENCES products(id));
        """
    )

    c.executemany("INSERT INTO brands (id, name) VALUES (?, ?)",
                  [(i, b) for i, b in enumerate(BRANDS, start=1)])

    products = build_products()
    c.executemany(
        "INSERT INTO products (id, name, brand_id, category, price) VALUES (?, ?, ?, ?, ?)",
        [(p[0], p[1], p[2], p[3], p[4]) for p in products],
    )

    for cid in range(1, N_CUSTOMERS + 1):
        name = f"{random.choice(FIRST)} {random.choice(LAST)}"
        created = START - timedelta(days=random.randint(0, 400))
        c.execute("INSERT INTO customers (id, name, city, created_at) VALUES (?, ?, ?, ?)",
                  (cid, name, random.choice(CITIES), created.isoformat()))

    by_cat = {}
    for p in products:
        by_cat.setdefault(p[3], []).append(p)
    pop_weighted = [p for p in products for _ in range(p[5])]

    oid = 0
    item_id = 0
    for _ in range(N_ORDERS):
        oid += 1
        customer_id = random.randint(1, N_CUSTOMERS)
        created = rand_order_date()
        # timestamp within the day
        ts = f"{created.isoformat()} {random.randint(8, 22):02d}:{random.randint(0, 59):02d}:00"
        c.execute("INSERT INTO orders (id, customer_id, created_at, status) VALUES (?, ?, ?, ?)",
                  (oid, customer_id, ts, "completed"))

        basket = set()
        seed_product = random.choice(pop_weighted)
        basket.add(seed_product)
        # add affinity partner(s) with high probability -> co-purchase signal
        partner_cat = AFFINITY.get(seed_product[3])
        if partner_cat and by_cat.get(partner_cat) and random.random() < 0.65:
            basket.add(random.choice(by_cat[partner_cat]))
        # occasional extra unrelated items
        for _ in range(random.randint(0, 2)):
            if random.random() < 0.5:
                basket.add(random.choice(pop_weighted))

        for prod in basket:
            item_id += 1
            qty = random.choices([1, 2, 3], weights=[70, 22, 8])[0]
            unit_price = prod[4]
            if random.random() < 0.2:  # occasional discount
                unit_price = round(unit_price * random.choice([0.9, 0.85, 0.8]), 2)
            c.execute(
                "INSERT INTO order_items (id, order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?, ?)",
                (item_id, oid, prod[0], qty, unit_price),
            )

    # helpful indexes (candidates may add their own)
    c.executescript(
        """
        CREATE INDEX idx_oi_order ON order_items(order_id);
        CREATE INDEX idx_oi_product ON order_items(product_id);
        CREATE INDEX idx_orders_created ON orders(created_at);
        CREATE INDEX idx_products_brand ON products(brand_id);
        """
    )
    conn.commit()

    print(f"Wrote {DB_PATH}")
    for label, q in [
        ("brands", "SELECT COUNT(*) FROM brands"),
        ("products", "SELECT COUNT(*) FROM products"),
        ("customers", "SELECT COUNT(*) FROM customers"),
        ("orders", "SELECT COUNT(*) FROM orders"),
        ("order_items", "SELECT COUNT(*) FROM order_items"),
    ]:
        print(f"  {label:12} {c.execute(q).fetchone()[0]}")
    conn.close()


if __name__ == "__main__":
    main()
