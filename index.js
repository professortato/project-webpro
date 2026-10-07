
const express = require("express");
const session = require("express-session");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "food.db");
const db = new sqlite3.Database(DB_FILE);

// ---------- ข้อมูลร้าน / การชำระเงิน ----------
// แก้ promptpay เป็นเบอร์พร้อมเพย์ หรือเลขบัตร/เลขผู้เสียภาษีของร้านจริง
// (เบอร์มือถือ 10 หลัก เช่น "0812345678" หรือเลข 13 หลัก)
const RESTAURANT = {
  name: "ซากุระ",
  nameEn: "SAKURA",
  tagline: "ร้านอาหารญี่ปุ่น",
  promptpay: "0812345678"
};

// สร้าง payload มาตรฐาน PromptPay (EMVCo) ตามยอดเงิน -> ให้ฝั่งหน้าเว็บเรนเดอร์เป็น QR
function emv(id, value) { return id + String(value.length).padStart(2, "0") + value; }
function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}
function promptpayPayload(target, amount) {
  const acc = String(target || "").replace(/[^0-9]/g, "");
  if (!acc) return "";
  const merchantId = acc.length >= 13
    ? emv("02", acc.slice(0, 13))
    : emv("01", "0066" + acc.replace(/^0/, ""));
  const merchant = emv("29", emv("00", "A000000677010111") + merchantId);
  const amt = Number(amount) || 0;
  let payload =
    emv("00", "01") +
    emv("01", amt > 0 ? "12" : "11") +
    merchant +
    emv("53", "764") +
    (amt > 0 ? emv("54", amt.toFixed(2)) : "") +
    emv("58", "TH");
  payload += "6304" + crc16(payload + "6304");
  return payload;
}

// แปลงเวลา (เก็บเป็น UTC) -> เวลาไทย + "ผ่านไปแล้วกี่นาที"
function orderTime(createdAt) {
  if (!createdAt) return { clock: "", ago: "", mins: 0 };
  const d = new Date(String(createdAt).replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return { clock: "", ago: "", mins: 0 };
  const clock = d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Bangkok" });
  const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  let ago;
  if (mins < 1) ago = "เพิ่งสั่ง";
  else if (mins < 60) ago = mins + " นาทีที่แล้ว";
  else ago = Math.floor(mins / 60) + " ชม. " + (mins % 60) + " นาทีที่แล้ว";
  return { clock, ago, mins };
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use("/public", express.static(path.join(__dirname, "public")));
app.use(session({
  secret: "food-order-project-secret",
  resave: false,
  saveUninitialized: true
}));

// ใส่ข้อมูลร้าน + สรุปตะกร้า ให้ทุกหน้าเรียกใช้ได้
app.use((req, res, next) => {
  const cart = req.session.cart || [];
  res.locals.restaurant = RESTAURANT;
  res.locals.cartCount = cart.reduce((s, x) => s + Number(x.quantity || 0), 0);
  res.locals.cartTotal = cart.reduce((s, x) => s + Number(x.total_price || 0), 0);
  next();
});

const TABLES = Array.from({ length: 16 }, (_, i) => i + 1);
const CATEGORIES = ["ซูชิ", "ของทอด", "เส้น/ซุป", "ของทานเล่น", "เครื่องดื่ม"];

const addonData = [
  ["เส้น/ซุป", "ระดับความเผ็ด", "ไม่เผ็ด", 0, 1, 0],
  ["เส้น/ซุป", "ระดับความเผ็ด", "เผ็ดน้อย", 0, 2, 0],
  ["เส้น/ซุป", "ระดับความเผ็ด", "เผ็ดกลาง", 0, 3, 0],
  ["เส้น/ซุป", "ระดับความเผ็ด", "เผ็ดมาก", 0, 4, 0],
  ["เส้น/ซุป", "Topping", "เพิ่มไข่ต้ม", 10, 1, 1],
  ["เส้น/ซุป", "Topping", "เพิ่มไข่ดอง", 10, 2, 1],
  ["เส้น/ซุป", "Topping", "เพิ่มหน่อไม้", 10, 3, 1],
  ["เส้น/ซุป", "Topping", "เพิ่มสาหร่าย", 10, 4, 1],
  ["เส้น/ซุป", "Topping", "เพิ่มหมูชาชู", 20, 5, 1],

  ["ซูชิ", "เครื่องเคียง", "ไม่รับวาซาบิ/โชยุ", 0, 1, 0],
  ["ซูชิ", "เครื่องเคียง", "รับวาซาบิ/โชยุปกติ", 0, 2, 0],
  ["ซูชิ", "เครื่องเคียง", "เพิ่มวาซาบิ", 10, 3, 1],
  ["ซูชิ", "เครื่องเคียง", "เพิ่มโชยุ", 10, 4, 1],
  ["ซูชิ", "เครื่องเคียง", "เพิ่มขิงดอง", 10, 5, 1],

  ["ของทอด", "ซอส", "ซอสมะเขือเทศ", 0, 1, 0],
  ["ของทอด", "ซอส", "ซอสพริก", 0, 2, 0],
  ["ของทอด", "ซอส", "มายองเนส", 0, 3, 0],
  ["ของทอด", "ซอส", "ไม่รับซอส", 0, 4, 0],
  ["ของทอด", "ผงคลุก", "ผงชีส", 10, 1, 1],
  ["ของทอด", "ผงคลุก", "ผงปาปริก้า", 10, 2, 1],
  ["ของทอด", "ผงคลุก", "ผงบาร์บีคิว", 10, 3, 1],

  ["ของทานเล่น", "ซอส", "ซอสมะเขือเทศ", 0, 1, 0],
  ["ของทานเล่น", "ซอส", "ซอสพริก", 0, 2, 0],
  ["ของทานเล่น", "ซอส", "มายองเนส", 0, 3, 0],
  ["ของทานเล่น", "ซอส", "ไม่รับซอส", 0, 4, 0],
  ["ของทานเล่น", "ผงคลุก", "ผงชีส", 10, 1, 1],
  ["ของทานเล่น", "ผงคลุก", "ผงปาปริก้า", 10, 2, 1],
  ["ของทานเล่น", "ผงคลุก", "ผงบาร์บีคิว", 10, 3, 1],

  ["เครื่องดื่ม", "ระดับความหวาน", "ไม่หวาน 0%", 0, 1, 0],
  ["เครื่องดื่ม", "ระดับความหวาน", "หวานน้อย 25%", 0, 2, 0],
  ["เครื่องดื่ม", "ระดับความหวาน", "หวานปกติ 100%", 0, 3, 0],
  ["เครื่องดื่ม", "ระดับความหวาน", "หวานมาก 150%", 0, 4, 0],
  ["เครื่องดื่ม", "Topping", "เพิ่มไข่มุก", 10, 1, 1],
  ["เครื่องดื่ม", "Topping", "เพิ่มบุก", 10, 2, 1]
];

const menuNames = [
  ["ซูชิแซลมอน", 25, "ซูชิ"], ["ซูชิทูนา", 35, "ซูชิ"], ["ซูชิซาบะดอง", 20, "ซูชิ"], ["ซูชิกุ้งสด", 20, "ซูชิ"], ["ซูชิไข่ปลาแซลมอน", 60, "ซูชิ"], ["ซูชิแซลมอนย่าง", 30, "ซูชิ"], ["ซูชิไข่กุ้ง", 20, "ซูชิ"], ["ซูชิไข่หวาน", 20, "ซูชิ"], ["แซลมอนโรล", 180, "ซูชิ"], ["ทูน่าโรล", 180, "ซูชิ"],
  ["ปีกไก่ทอดน้ำปลา", 100, "ของทอด"], ["ชีสบอล", 80, "ของทอด"], ["ทอดมันกุ้ง", 120, "ของทอด"], ["ไก่คาราอาเกะ", 80, "ของทอด"], ["ปลาหมึกชุบแป้งทอด", 100, "ของทอด"], ["เฟรนช์ฟรายส์", 70, "ของทอด"], ["หอมหัวใหญ่ทอด", 70, "ของทอด"], ["เกี๊ยวซ่าทอด", 80, "ของทอด"], ["เต้าหู้ทอด", 60, "ของทอด"], ["กุ้งเทมปุระ", 130, "ของทอด"],
  ["ทงคัตสึราเมน", 170, "เส้น/ซุป"], ["โชยุราเมน", 150, "เส้น/ซุป"], ["มิโซะราเมน", 140, "เส้น/ซุป"], ["ชาชูเมน", 160, "เส้น/ซุป"], ["โซเมน", 100, "เส้น/ซุป"], ["ยากิโซบะ", 130, "เส้น/ซุป"], ["ซารุโซบะ", 120, "เส้น/ซุป"], ["โอเด้ง", 100, "เส้น/ซุป"], ["ซุปหัวไชเท้าต้มซีอิ๊ว", 70, "เส้น/ซุป"], ["ซุปมิโซะ", 30, "เส้น/ซุป"],
  ["ทาโกยากิ", 80, "ของทานเล่น"], ["พิซซ่าญี่ปุ่น", 130, "ของทานเล่น"], ["ถั่วแระญี่ปุ่น", 40, "ของทานเล่น"], ["ไข่ตุ๋นญี่ปุ่น", 40, "ของทานเล่น"], ["ยำสาหร่าย", 30, "ของทานเล่น"], ["ยากิโทริ", 40, "ของทานเล่น"], ["มันหวานญี่ปุ่นเผา", 100, "ของทานเล่น"], ["ทูน่าทาทากิ", 170, "ของทานเล่น"], ["เต้าหู้เย็นญี่ปุ่น", 60, "ของทานเล่น"], ["ฟักทองญี่ปุ่นต้มซีอิ๊ว", 60, "ของทานเล่น"],
  ["น้ำผึ้งมะนาวโซดา", 50, "เครื่องดื่ม"], ["โค้ก", 30, "เครื่องดื่ม"], ["สไปรท์", 30, "เครื่องดื่ม"], ["ชามะนาวเย็น", 50, "เครื่องดื่ม"], ["ชาดำเย็น", 50, "เครื่องดื่ม"], ["ชาไทยเย็น", 50, "เครื่องดื่ม"], ["โกโก้เย็น", 50, "เครื่องดื่ม"], ["ชาเขียว", 40, "เครื่องดื่ม"], ["น้ำส้ม", 50, "เครื่องดื่ม"], ["น้ำเปล่า", 20, "เครื่องดื่ม"]
];

function localImage(category, index) {
  const map = {
    "ของทอด": "fried_" + (index + 1),
    "ของทานเล่น": "snack_" + (index + 1),
    "ซูชิ": "sushi_" + (index + 1),
    "เครื่องดื่ม": "drink_" + (index + 1),
    "เส้น/ซุป": "noodle_" + (index + 1)
  };
  const base = map[category];
  const files = require("fs").readdirSync(path.join(__dirname, "public", "Pic"));
  const found = files.find(f => path.parse(f).name === base);
  return found ? "/public/Pic/" + encodeURIComponent(found).replace(/%2F/g, "/") : "";
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (err) {
    if (err) reject(err); else resolve(this);
  }));
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}
function tableNo(v) {
  const n = Number(v);
  return TABLES.includes(n) ? n : 1;
}
function money(n) { return Number(n || 0); }

async function initDb() {
  await run(`CREATE TABLE IF NOT EXISTS menu(
    menu_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, price INTEGER NOT NULL,
    image TEXT, category TEXT NOT NULL)`);
  await run(`CREATE TABLE IF NOT EXISTS addon(
    addon_id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, addon_type TEXT NOT NULL,
    option_name TEXT NOT NULL, extra_price INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
    multiple INTEGER NOT NULL DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS tables_status(
    table_no INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'ว่าง', updated_at TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS orders(
    order_id INTEGER PRIMARY KEY AUTOINCREMENT, table_no INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'กำลังทำ', total INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL)`);
  await run(`CREATE TABLE IF NOT EXISTS order_items(
    order_item_id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL,
    menu_id INTEGER NOT NULL, name TEXT NOT NULL, quantity INTEGER NOT NULL,
    unit_price INTEGER NOT NULL, total_price INTEGER NOT NULL, addons TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS payments(
    payment_id INTEGER PRIMARY KEY AUTOINCREMENT, table_no INTEGER NOT NULL,
    total INTEGER NOT NULL, received INTEGER NOT NULL, change_amount INTEGER NOT NULL,
    method TEXT NOT NULL, paid_at TEXT NOT NULL)`);

  const menuCount = await get("SELECT COUNT(*) AS c FROM menu");
  if (menuCount.c !== menuNames.length) {
    await run("DELETE FROM menu");
    for (let i = 0; i < menuNames.length; i++) {
      const [name, price, category] = menuNames[i];
      const sameCategoryIndex = menuNames.slice(0, i).filter(x => x[2] === category).length;
      await run("INSERT INTO menu(name,price,image,category) VALUES(?,?,?,?)",
        [name, price, localImage(category, sameCategoryIndex), category]);
    }
  }

  await run("DELETE FROM addon");
  for (const a of addonData) {
    await run("INSERT INTO addon(category,addon_type,option_name,extra_price,sort_order,multiple) VALUES(?,?,?,?,?,?)", a);
  }

  for (const t of TABLES) {
    await run("INSERT OR IGNORE INTO tables_status(table_no,status,updated_at) VALUES(?,?,datetime('now'))", [t, "ว่าง"]);
  }
}

async function cartItems(req) {
  return req.session.cart || [];
}
function cartTotal(cart) {
  return cart.reduce((s, x) => s + money(x.total_price), 0);
}

app.get("/", async (req, res) => {
  const table = tableNo(req.query.table || req.session.table);
  req.session.table = table;
  const menus = await all("SELECT * FROM menu ORDER BY category, menu_id");
  res.render("home", { menus, table, categories: CATEGORIES, added: req.query.added || "" });
});

app.get("/addon", async (req, res) => {
  const menu = await get("SELECT * FROM menu WHERE menu_id=?", [Number(req.query.menu_id)]);
  if (!menu) return res.status(404).send("ไม่พบเมนู");
  const table = tableNo(req.query.table);
  const addons = await all("SELECT * FROM addon WHERE category=? ORDER BY addon_type, sort_order", [menu.category]);
  const groups = [];
  for (const a of addons) {
    let g = groups.find(x => x.type === a.addon_type);
    if (!g) { g = { type: a.addon_type, multiple: Boolean(a.multiple), options: [] }; groups.push(g); }
    g.options.push(a);
  }
  res.render("addon", { menu, table, groups });
});

app.post("/add-to-cart", async (req, res) => {
  const menu = await get("SELECT * FROM menu WHERE menu_id=?", [Number(req.body.menu_id)]);
  if (!menu) return res.status(404).send("ไม่พบเมนู");
  const table = tableNo(req.body.table);
  const quantity = Math.max(1, Math.min(99, Number(req.body.quantity) || 1));
  let ids = [];
  Object.keys(req.body).filter(k => k.startsWith("addon_")).forEach(k => {
    const v = req.body[k]; ids.push(...(Array.isArray(v) ? v : [v]));
  });
  ids = [...new Set(ids.map(Number).filter(Number.isInteger))];
  let addons = [];
  if (ids.length) addons = await all(`SELECT * FROM addon WHERE category=? AND addon_id IN (${ids.map(() => "?").join(",")})`,
    [menu.category, ...ids]);
  const addonPrice = addons.reduce((s, a) => s + a.extra_price, 0);
  if (!req.session.cart) req.session.cart = [];
  req.session.cart.push({
    cart_id: Date.now() + Math.floor(Math.random() * 100000),
    menu_id: menu.menu_id, name: menu.name, image: menu.image, base_price: menu.price,
    addons: addons.map(a => ({ addon_id: a.addon_id, type: a.addon_type, name: a.option_name, price: a.extra_price })),
    addon_price: addonPrice, quantity, unit_price: menu.price + addonPrice,
    total_price: (menu.price + addonPrice) * quantity
  });
  req.session.table = table;
  // เพิ่มลงตะกร้าแล้ว -> กลับไปหน้าเมนูเพื่อเลือกต่อ พร้อมแจ้งเตือน (มีแถบตะกร้าลอยให้กดไปชำระ)
  res.redirect("/?table=" + table + "&added=" + encodeURIComponent(menu.name));
});

app.get("/cart", async (req, res) => {
  const table = tableNo(req.query.table || req.session.table);
  const cart = await cartItems(req);
  res.render("cart", { cart, total: cartTotal(cart), table });
});
app.post("/remove-from-cart", (req, res) => {
  const id = Number(req.body.cart_id);
  req.session.cart = (req.session.cart || []).filter(x => x.cart_id !== id);
  res.redirect("/cart?table=" + tableNo(req.body.table));
});
app.post("/clear-cart", (req, res) => { req.session.cart = []; res.redirect("/cart?table=" + tableNo(req.body.table)); });

app.get("/orders", async (req, res) => {
  const table = tableNo(req.query.table || req.session.table);
  const orders = await all("SELECT * FROM orders WHERE table_no=? ORDER BY order_id DESC", [table]);
  for (const o of orders) { o.items = await all("SELECT * FROM order_items WHERE order_id=?", [o.order_id]); o.time = orderTime(o.created_at); }
  res.render("orders", { orders, table, placed: req.query.placed || "" });
});

app.post("/confirm-order", async (req, res) => {
  const table = tableNo(req.body.table);
  const cart = req.session.cart || [];
  if (!cart.length) return res.redirect("/cart?table=" + table);
  const total = cartTotal(cart);
  const r = await run("INSERT INTO orders(table_no,status,total,created_at) VALUES(?,?,?,datetime('now'))", [table, "กำลังทำ", total]);
  for (const item of cart) {
    await run("INSERT INTO order_items(order_id,menu_id,name,quantity,unit_price,total_price,addons) VALUES(?,?,?,?,?,?,?)",
      [r.lastID, item.menu_id, item.name, item.quantity, item.unit_price, item.total_price, JSON.stringify(item.addons)]);
  }
  await run("UPDATE tables_status SET status='ไม่ว่าง',updated_at=datetime('now') WHERE table_no=?", [table]);
  req.session.cart = [];
  res.redirect("/orders?table=" + table + "&placed=1");
});

// ---------- KITCHEN ----------
async function getWorkOrders(status) {
  const orders = await all("SELECT * FROM orders WHERE status=? ORDER BY order_id ASC", [status]);
  for (const o of orders) { o.items = await all("SELECT * FROM order_items WHERE order_id=?", [o.order_id]); o.time = orderTime(o.created_at); }
  return orders;
}
app.get("/kitchen", async (req, res) => {
  const orders = await getWorkOrders("กำลังทำ");
  res.render("kitchen", { orders, role: "พนักงานครัว" });
});
app.post("/kitchen/done", async (req, res) => {
  await run("UPDATE orders SET status='พร้อมเสิร์ฟ' WHERE order_id=?", [Number(req.body.order_id)]);
  res.redirect("/kitchen");
});

// ---------- SERVICE ----------
app.get("/service", async (req, res) => {
  const orders = await getWorkOrders("พร้อมเสิร์ฟ");
  res.render("service", { orders, role: "พนักงานบริการ" });
});
app.post("/service/served", async (req, res) => {
  await run("UPDATE orders SET status='เสิร์ฟแล้ว' WHERE order_id=?", [Number(req.body.order_id)]);
  res.redirect("/service");
});

// ---------- CASHIER ----------
async function tableOverview() {
  return await all("SELECT * FROM tables_status ORDER BY table_no");
}
async function billForTable(table) {
  const orders = await all("SELECT * FROM orders WHERE table_no=? AND status!='ชำระแล้ว' ORDER BY order_id", [table]);
  const items = [];
  for (const o of orders) {
    o.items = await all("SELECT * FROM order_items WHERE order_id=?", [o.order_id]);
    o.time = orderTime(o.created_at);
    o.items.forEach(i => items.push({ ...i, order_id: o.order_id }));
  }
  return { orders, items, total: orders.reduce((s, o) => s + o.total, 0) };
}
app.get("/cashier", async (req, res) => {
  const tables = await tableOverview();
  const selected = req.query.selected ? tableNo(req.query.selected) : null;
  const mode = req.query.mode === "change";
  const bill = selected ? await billForTable(selected) : null;
  res.render("cashier", { tables, selected, bill, mode, role: "พนักงานแคชเชียร์" });
});
app.post("/cashier/toggle-mode", (req, res) => {
  const selected = req.body.selected || "";
  res.redirect("/cashier?mode=change" + (selected ? "&selected=" + selected : ""));
});
app.post("/cashier/table-status", async (req, res) => {
  // เลือกโต๊ะในโหมดเปลี่ยนสถานะเท่านั้น ยังไม่เปลี่ยนสถานะจริง
  const table = tableNo(req.body.table);
  res.redirect("/cashier?mode=change&selected=" + table);
});

app.post("/cashier/confirm-status", async (req, res) => {
  const table = tableNo(req.body.table);
  const row = await get("SELECT status FROM tables_status WHERE table_no=?", [table]);
  if (!row) return res.redirect("/cashier");
  const next = row.status === "ว่าง" ? "ไม่ว่าง" : "ว่าง";
  await run("UPDATE tables_status SET status=?,updated_at=datetime('now') WHERE table_no=?", [next, table]);
  // ยืนยันแล้วกลับหน้าสถานะโต๊ะปกติทันที
  res.redirect("/cashier");
});
app.post("/payment/confirm", async (req, res) => {
  const table = tableNo(req.body.table);
  const bill = await billForTable(table);
  const method = req.body.method === "QR CODE" ? "QR CODE" : "เงินสด";
  if (!bill.total) return res.redirect("/cashier?selected=" + table);
  // QR พร้อมเพย์ = จ่ายตามยอดบิลพอดี ไม่ต้องกรอกเงินรับ/ไม่มีเงินทอน
  const received = method === "QR CODE" ? bill.total : Math.max(0, Number(req.body.received) || 0);
  if (received < bill.total) return res.redirect(`/payment/${table}?error=ยอดรับเงินไม่พอ&received=${received}&method=${encodeURIComponent(method)}`);
  const change = received - bill.total;
  await run("INSERT INTO payments(table_no,total,received,change_amount,method,paid_at) VALUES(?,?,?,?,?,datetime('now'))",
    [table, bill.total, received, change, method]);
  await run("UPDATE orders SET status='ชำระแล้ว' WHERE table_no=? AND status!='ชำระแล้ว'", [table]);
  await run("UPDATE tables_status SET status='ว่าง',updated_at=datetime('now') WHERE table_no=?", [table]);
  res.redirect(`/payment/${table}/success?total=${bill.total}&received=${received}&change=${change}&method=${encodeURIComponent(method)}`);
});
app.get("/payment/:table", async (req, res) => {
  const table = tableNo(req.params.table);
  const bill = await billForTable(table);
  if (!bill.total) return res.redirect("/cashier?selected=" + table);
  const qrPayload = promptpayPayload(RESTAURANT.promptpay, bill.total);
  res.render("payment", { table, bill, query: req.query, qrPayload });
});
app.get("/payment/:table/success", (req, res) => {
  const table = tableNo(req.params.table);
  res.render("payment-success", { table, total: Number(req.query.total) || 0, received: Number(req.query.received) || 0, change: Number(req.query.change) || 0, method: req.query.method || "เงินสด", paidAt: orderTime(new Date().toISOString().slice(0, 19).replace("T", " ")) });
});

app.get("/receipt/:table", (req, res) => res.redirect("/cashier?selected=" + tableNo(req.params.table)));

initDb().then(() => {
  app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
}).catch(err => { console.error(err); process.exit(1); });
