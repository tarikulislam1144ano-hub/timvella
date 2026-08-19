const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
app.set("trust proxy", 1);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-only-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);

app.use(express.static(path.join(__dirname, "public")));

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products(
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      old_price INTEGER,
      category TEXT NOT NULL,
      image TEXT,
      stock INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders(
      id SERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      items TEXT NOT NULL,
      total INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      status TEXT DEFAULT 'Pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS admins(
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL
    );
  `);

  const adminUser = process.env.ADMIN_USER || "admin";
  const adminPass = process.env.ADMIN_PASSWORD || "CHANGE_ME";

  const admin = await pool.query(
    "SELECT id FROM admins WHERE username=$1",
    [adminUser]
  );

  if (admin.rowCount === 0) {
    const hash = bcrypt.hashSync(adminPass, 12);

    await pool.query(
      "INSERT INTO admins(username,password_hash) VALUES($1,$2)",
      [adminUser, hash]
    );
  }

  const count = await pool.query("SELECT COUNT(*) FROM products");

  if (Number(count.rows[0].count) === 0) {
    const products = [
      ["Timvella Classic Black",2490,2990,"Men","",20],
      ["Timvella Royal Gold",3290,3990,"Premium","",15],
      ["Timvella Elegance",2790,3290,"Women","",12],
      ["Timvella Signature",4490,4990,"Premium","",8]
    ];

    for (const p of products) {
      await pool.query(
        `INSERT INTO products
        (name,price,old_price,category,image,stock)
        VALUES($1,$2,$3,$4,$5,$6)`,
        p
      );
    }
  }

  console.log("PostgreSQL database ready");
}

function adminOnly(req, res, next) {
  if (req.session.admin) return next();
  res.status(401).json({ error: "Admin login required" });
}

app.get("/api/products", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM products ORDER BY id DESC"
  );
  res.json(result.rows);
});

app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body || {};

  const result = await pool.query(
    "SELECT * FROM admins WHERE username=$1",
    [username]
  );

  const admin = result.rows[0];

  if (!admin || !bcrypt.compareSync(password || "", admin.password_hash)) {
    return res.status(401).json({ error: "Invalid login" });
  }

  req.session.admin = {
    id: admin.id,
    username: admin.username
  };

  res.json({ ok: true });
});

app.post("/api/admin/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/admin/me", (req, res) => {
  res.json({ loggedIn: !!req.session.admin });
});

app.post("/api/products", adminOnly, async (req, res) => {
  const { name, price, old_price, category, image, stock } = req.body || {};

  if (!name || !Number.isInteger(+price) || +price < 1) {
    return res.status(400).json({ error: "Invalid product" });
  }

  const result = await pool.query(
    `INSERT INTO products
    (name,price,old_price,category,image,stock)
    VALUES($1,$2,$3,$4,$5,$6)
    RETURNING *`,
    [
      name,
      +price,
      old_price ? +old_price : null,
      category || "Premium",
      image || "",
      Number.isInteger(+stock) ? +stock : 0
    ]
  );

  res.json(result.rows[0]);
});

app.put("/api/products/:id", adminOnly, async (req, res) => {
  const p = await pool.query(
    "SELECT * FROM products WHERE id=$1",
    [req.params.id]
  );

  if (p.rowCount === 0) {
    return res.status(404).json({ error: "Not found" });
  }

  const old = p.rows[0];
  const b = req.body;

  const result = await pool.query(
    `UPDATE products SET
      name=$1,
      price=$2,
      old_price=$3,
      category=$4,
      image=$5,
      stock=$6
    WHERE id=$7
    RETURNING *`,
    [
      b.name || old.name,
      Number(b.price ?? old.price),
      b.old_price === "" ? null : Number(b.old_price ?? old.old_price),
      b.category || old.category,
      b.image ?? old.image,
      Number(b.stock ?? old.stock),
      old.id
    ]
  );

  res.json(result.rows[0]);
});

app.delete("/api/products/:id", adminOnly, async (req, res) => {
  await pool.query(
    "DELETE FROM products WHERE id=$1",
    [req.params.id]
  );

  res.json({ ok: true });
});

app.post("/api/orders", async (req, res) => {
  const {
    customer_name,
    phone,
    address,
    items,
    payment_method
  } = req.body || {};

  if (
    !customer_name ||
    !phone ||
    !address ||
    !Array.isArray(items) ||
    !items.length
  ) {
    return res.status(400).json({
      error: "Missing order details"
    });
  }

  let total = 0;
  const safe = [];

  for (const it of items) {
    const result = await pool.query(
      "SELECT id,name,price,stock FROM products WHERE id=$1",
      [it.id]
    );

    const p = result.rows[0];
    const qty = Math.max(
      1,
      Math.min(20, Number(it.qty) || 1)
    );

    if (!p || p.stock < qty) {
      return res.status(400).json({
        error: `Stock unavailable: ${p?.name || "item"}`
      });
    }

    total += p.price * qty;

    safe.push({
      id: p.id,
      name: p.name,
      price: p.price,
      qty
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const order = await client.query(
      `INSERT INTO orders
      (customer_name,phone,address,items,total,payment_method)
      VALUES($1,$2,$3,$4,$5,$6)
      RETURNING id`,
      [
        customer_name,
        phone,
        address,
        JSON.stringify(safe),
        total,
        payment_method || "Cash on Delivery"
      ]
    );

    for (const x of safe) {
      await client.query(
        "UPDATE products SET stock=stock-$1 WHERE id=$2",
        [x.qty, x.id]
      );
    }

    await client.query("COMMIT");

    res.json({
      ok: true,
      order_id: order.rows[0].id,
      total,
      payment_status:
        payment_method === "Cash on Delivery"
          ? "cod"
          : "pending"
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Order failed" });
  } finally {
    client.release();
  }
});

app.get("/api/orders", adminOnly, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM orders ORDER BY id DESC"
  );

  res.json(
    result.rows.map(x => ({
      ...x,
      items: JSON.parse(x.items)
    }))
  );
});

app.patch("/api/orders/:id", adminOnly, async (req, res) => {
  const allowed = [
    "Pending",
    "Confirmed",
    "Shipped",
    "Delivered",
    "Cancelled"
  ];

  if (!allowed.includes(req.body.status)) {
    return res.status(400).json({
      error: "Invalid status"
    });
  }

  await pool.query(
    "UPDATE orders SET status=$1 WHERE id=$2",
    [req.body.status, req.params.id]
  );

  res.json({ ok: true });
});

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Timvella running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error("Database error:", err);
    process.exit(1);
  });
