const express=require("express");
const session=require("express-session");
const helmet=require("helmet");
const bcrypt=require("bcryptjs");
const Database=require("better-sqlite3");
const path=require("path");

const app=express();
const PORT=process.env.PORT||3000;
const db=new Database("timvella.db");
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:"100kb"}));
app.use(express.urlencoded({extended:false}));
app.use(session({
  secret:process.env.SESSION_SECRET||"dev-only-change-me",
  resave:false,saveUninitialized:false,
  cookie:{httpOnly:true,sameSite:"lax",secure:false,maxAge:1000*60*60*8}
}));
app.use(express.static(path.join(__dirname,"public")));

db.exec(`
CREATE TABLE IF NOT EXISTS products(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL, price INTEGER NOT NULL, old_price INTEGER,
 category TEXT NOT NULL, image TEXT, stock INTEGER DEFAULT 0,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 customer_name TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL,
 items TEXT NOT NULL, total INTEGER NOT NULL,
 payment_method TEXT NOT NULL, status TEXT DEFAULT 'Pending',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admins(
 id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL
);`);

const adminUser=process.env.ADMIN_USER||"admin";
const adminPass=process.env.ADMIN_PASSWORD||"CHANGE_ME";
const exists=db.prepare("SELECT id FROM admins WHERE username=?").get(adminUser);
if(!exists){
  db.prepare("INSERT INTO admins(username,password_hash) VALUES(?,?)")
    .run(adminUser,bcrypt.hashSync(adminPass,12));
}
if(db.prepare("SELECT COUNT(*) c FROM products").get().c===0){
  const ins=db.prepare("INSERT INTO products(name,price,old_price,category,image,stock) VALUES(?,?,?,?,?,?)");
  [["Timvella Classic Black",2490,2990,"Men","",20],["Timvella Royal Gold",3290,3990,"Premium","",15],["Timvella Elegance",2790,3290,"Women","",12],["Timvella Signature",4490,4990,"Premium","",8]].forEach(x=>ins.run(...x));
}

function adminOnly(req,res,next){if(req.session.admin)return next();res.status(401).json({error:"Admin login required"});}
app.get("/api/products",(req,res)=>res.json(db.prepare("SELECT * FROM products ORDER BY id DESC").all()));

app.post("/api/admin/login",(req,res)=>{
  const {username,password}=req.body||{};
  const a=db.prepare("SELECT * FROM admins WHERE username=?").get(username);
  if(!a||!bcrypt.compareSync(password||"",a.password_hash))return res.status(401).json({error:"Invalid login"});
  req.session.admin={id:a.id,username:a.username};res.json({ok:true});
});
app.post("/api/admin/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/admin/me",(req,res)=>res.json({loggedIn:!!req.session.admin}));

app.post("/api/products",adminOnly,(req,res)=>{
 const {name,price,old_price,category,image,stock}=req.body||{};
 if(!name||!Number.isInteger(+price)||+price<1)return res.status(400).json({error:"Invalid product"});
 const r=db.prepare("INSERT INTO products(name,price,old_price,category,image,stock) VALUES(?,?,?,?,?,?)")
 .run(name,+price,old_price?+old_price:null,category||"Premium",image||"",Number.isInteger(+stock)?+stock:0);
 res.json(db.prepare("SELECT * FROM products WHERE id=?").get(r.lastInsertRowid));
});
app.put("/api/products/:id",adminOnly,(req,res)=>{
 const p=db.prepare("SELECT * FROM products WHERE id=?").get(req.params.id); if(!p)return res.status(404).json({error:"Not found"});
 const b=req.body;
 db.prepare("UPDATE products SET name=?,price=?,old_price=?,category=?,image=?,stock=? WHERE id=?")
 .run(b.name||p.name,Number(b.price??p.price),b.old_price===""?null:Number(b.old_price??p.old_price),b.category||p.category,b.image??p.image,Number(b.stock??p.stock),p.id);
 res.json(db.prepare("SELECT * FROM products WHERE id=?").get(p.id));
});
app.delete("/api/products/:id",adminOnly,(req,res)=>{db.prepare("DELETE FROM products WHERE id=?").run(req.params.id);res.json({ok:true});});

app.post("/api/orders",(req,res)=>{
 const {customer_name,phone,address,items,payment_method}=req.body||{};
 if(!customer_name||!phone||!address||!Array.isArray(items)||!items.length)return res.status(400).json({error:"Missing order details"});
 let total=0; const safe=[];
 for(const it of items){
   const p=db.prepare("SELECT id,name,price,stock FROM products WHERE id=?").get(it.id);
   const qty=Math.max(1,Math.min(20,Number(it.qty)||1));
   if(!p||p.stock<qty)return res.status(400).json({error:`Stock unavailable: ${p?.name||"item"}`});
   total+=p.price*qty; safe.push({id:p.id,name:p.name,price:p.price,qty});
 }
 const tx=db.transaction(()=>{
   const r=db.prepare("INSERT INTO orders(customer_name,phone,address,items,total,payment_method) VALUES(?,?,?,?,?,?)")
    .run(customer_name,phone,address,JSON.stringify(safe),total,payment_method||"Cash on Delivery");
   for(const x of safe)db.prepare("UPDATE products SET stock=stock-? WHERE id=?").run(x.qty,x.id);
   return r.lastInsertRowid;
 });
 const id=tx(); res.json({ok:true,order_id:id,total,payment_status:payment_method==="Cash on Delivery"?"cod":"pending"});
});
app.get("/api/orders",adminOnly,(req,res)=>{
 const rows=db.prepare("SELECT * FROM orders ORDER BY id DESC").all().map(x=>({...x,items:JSON.parse(x.items)}));res.json(rows);
});
app.patch("/api/orders/:id",adminOnly,(req,res)=>{
 const allowed=["Pending","Confirmed","Shipped","Delivered","Cancelled"];
 if(!allowed.includes(req.body.status))return res.status(400).json({error:"Invalid status"});
 db.prepare("UPDATE orders SET status=? WHERE id=?").run(req.body.status,req.params.id);res.json({ok:true});
});

/* Payment note:
   A real payment gateway must be initialized server-side with merchant
   credentials and its official SDK/API. This starter deliberately does
   NOT contain fake credentials or pretend that a payment succeeded. */
app.listen(PORT,()=>console.log(`Timvella running on http://localhost:${PORT}`));
