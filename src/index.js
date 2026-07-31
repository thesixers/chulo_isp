import vibe, { cors } from "vibe-gx";
import { handleMessage } from "./handleMessage.js";
import { connectToWhatsApp } from "./whatsapp-connect.js";
import { startTelegramBot } from "./telegram-connect.js";
import { initMessaging, updateWhatsAppSocket, updateTelegramBot } from "./messaging.js";
import pg from "pg";
import { fulfillPayment } from "./fulfillPayment.js";
import { processPendingQueue } from "./provisioningQueue.js";
import { startScheduler } from "./scheduler.js";
import fs from "fs";
import { createDynamicVirtualAccount } from "./flutterwave.js";

// Prevent third-party library errors (e.g. mikronode-ng socket callbacks) from crashing the server
process.on("uncaughtException", (err) => {
  console.error("⚠️  Uncaught Exception (non-fatal):", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("⚠️  Unhandled Promise Rejection (non-fatal):", reason);
});

const app = vibe({
  logger: {
    lifecycle: true,
    prettyPrint: process.env.NODE_ENV !== "production",
    dest: process.env.NODE_ENV === "test" ? "console" : "file",
    logFile: "./chulo_logs.txt"
  },
});

// Enable CORS for all origins (we strictly filter by origin header in production inside POST handlers)
app.plugin(cors({
  origin: "*",
  allowedHeaders: ["Content-Type", "Origin", "Accept"]
}));

const db = new pg.Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
});

app.decorate("db", db);

// ── Rate Limiting & Origin Validation Helpers ───────────────────────────────
const rateLimits = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const limitWindow = 10 * 60 * 1000; // 10 minutes
  const maxRequests = 5;

  if (!rateLimits.has(ip)) {
    rateLimits.set(ip, [now]);
    return true;
  }

  const timestamps = rateLimits.get(ip).filter(t => now - t < limitWindow);
  if (timestamps.length >= maxRequests) {
    return false;
  }

  timestamps.push(now);
  rateLimits.set(ip, timestamps);
  return true;
}

const allowedOrigin = process.env.CHECKOUT_ORIGIN || "http://10.5.50.1";

function validateOrigin(req, res) {
  if (process.env.NODE_ENV !== "production") {
    return true; // Bypass in development/local test mode
  }
  const origin = req.headers["origin"];
  if (!origin || origin !== allowedOrigin) {
    res.status(403).send(JSON.stringify({ error: "Access Denied: Invalid Origin" }));
    return false;
  }
  return true;
}

function sanitizePhone(phone) {
  let cleaned = phone.replace(/\D/g, "");
  if (cleaned.startsWith("0") && cleaned.length === 11) {
    cleaned = "234" + cleaned.slice(1);
  }
  return cleaned;
}

// ── Database Setup & Bot Start ──────────────────────────────────────────────
const setupDB = async () => {
  try {
    const sql = fs.readFileSync("./db/schema.sql", "utf8");
    await db.query(sql);
    console.log("✅ Database Setup Complete!");
  } catch (err) {
    // Non-fatal — tables/types likely already exist from a previous run
    console.warn(
      "⚠️  DB setup warning (safe to ignore if tables already exist):",
      err.message,
    );
  }
};

let globalSock = null;
let telegramBot = null;

async function startBot() {
  const enableTelegram = process.env.ENABLE_TELEGRAM !== "false";
  const enableWhatsApp = process.env.ENABLE_WHATSAPP === "true";

  console.log(`\n🚀 Bot startup config:`);
  console.log(`   📱 WhatsApp : ${enableWhatsApp ? "✅ enabled" : "❌ disabled"}`);
  console.log(`   ✈️  Telegram : ${enableTelegram ? "✅ enabled" : "❌ disabled"}\n`);

  if (enableTelegram) {
    // startTelegramBot is non-blocking — it retries forever in the background.
    // updateTelegramBot() is called automatically once the bot connects.
    startTelegramBot(
      db,
      (platform, remoteId, phone, text, pushName) =>
        handleMessage(platform, remoteId, phone, text, pushName, db)
    );
  }

  if (enableWhatsApp) {
    globalSock = await connectToWhatsApp(
      (sock, from, pnJid, text, pushName) =>
        handleMessage("whatsapp", from, pnJid, text, pushName, db),
      (newSock) => {
        globalSock = newSock;
        updateWhatsAppSocket(newSock);
        console.log("🔄 globalSock updated to live WhatsApp socket");
      },
    );
  }

  // Initialize the central messaging router with whatever connected
  initMessaging(db, globalSock || null, telegramBot);
  console.log("✅ Messaging router initialized. Telegram:", telegramBot ? "connected" : "disabled", "| WhatsApp:", globalSock ? "connected" : "disabled");
}

app.get("/", () => "Welcome to Chulo Speednet");

// ── API Endpoints for Checkout ───────────────────────────────────────────────

app.get("/api/plans", async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  try {
    const plansRes = await db.query("SELECT id, name, price, duration_days FROM plans ORDER BY id ASC");
    return res.status(200).send(JSON.stringify(plansRes.rows));
  } catch (err) {
    console.error("API error fetching plans:", err.message);
    return res.status(500).send(JSON.stringify({ error: "Failed to fetch plans" }));
  }
});

app.post("/api/checkout/new", async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (!validateOrigin(req, res)) return;

  const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown-ip";
  if (!checkRateLimit(ip)) {
    return res.status(429).send(JSON.stringify({ error: "Too many payment requests. Please wait 10 minutes." }));
  }

  const { phone, username, password, planId } = req.body || {};

  // Form Validations
  if (!phone || !username || !password || !planId) {
    return res.status(400).send(JSON.stringify({ error: "Missing required fields (phone, username, password, planId)." }));
  }

  const cleanPhone = sanitizePhone(phone);
  if (cleanPhone.length < 10) {
    return res.status(400).send(JSON.stringify({ error: "Invalid phone number format." }));
  }

  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).send(JSON.stringify({ error: "Username must be alphanumeric (3-20 chars)." }));
  }

  if (!/^\d{4}$/.test(password)) {
    return res.status(400).send(JSON.stringify({ error: "Hotspot PIN must be exactly 4 digits (e.g. 1234)." }));
  }

  const planRes = await db.query("SELECT * FROM plans WHERE id = $1", [planId]);
  const plan = planRes.rows[0];
  if (!plan) {
    return res.status(400).send(JSON.stringify({ error: "Selected plan does not exist." }));
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Check unique username (excluding this phone number if they are updating a pending registration)
    const userCheck = await client.query(
      `SELECT id FROM users 
       WHERE LOWER(hotspot_username) = LOWER($1) AND phone != $2`, 
      [username, cleanPhone]
    );
    if (userCheck.rows.length > 0) {
      throw new Error("Username already taken. Please choose another.");
    }

    // Check if the phone number already exists
    const phoneCheck = await client.query("SELECT id, hotspot_username FROM users WHERE phone = $1", [cleanPhone]);
    let userId;

    if (phoneCheck.rows.length > 0) {
      const existingUser = phoneCheck.rows[0];
      
      // Check if they have ever completed a subscription (meaning they paid at least once)
      const subCheck = await client.query("SELECT 1 FROM subscriptions WHERE user_id = $1 LIMIT 1", [existingUser.id]);
      const hasPaid = subCheck.rows.length > 0;

      if (existingUser.hotspot_username && hasPaid) {
        throw new Error("This phone number is already registered. Please check out as an 'Existing User'.");
      } else {
        // Either they have no username, or they registered but never paid.
        // Allow updating/overwriting the pending credentials!
        await client.query(
          `UPDATE users
           SET hotspot_username = $1, hotspot_password = $2, name = $3
           WHERE id = $4`,
          [username, password, username, existingUser.id]
        );
        userId = existingUser.id;
      }
    } else {
      // Create new User
      const insertUser = await client.query(
        `INSERT INTO users (phone, name, hotspot_username, hotspot_password, status)
         VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
        [cleanPhone, username, username, password]
      );
      userId = insertUser.rows[0].id;
    }

    // Create/link chat session
    await client.query(
      `INSERT INTO chat_sessions (phone, state, plan_id, preferred_platform)
       VALUES ($1, 'awaiting_payment', $2, 'whatsapp')
       ON CONFLICT (phone) DO UPDATE SET
         state = EXCLUDED.state,
         plan_id = EXCLUDED.plan_id`,
      [cleanPhone, plan.id]
    );

    // Call Flutterwave to generate Virtual Account details
    const { txRef, accountNumber, accountName, bankName } = await createDynamicVirtualAccount(cleanPhone, plan.price, plan.name);

    // Create payment entry
    await client.query(
      `INSERT INTO payments (user_id, amount, provider, status, virtual_account_reference)
       VALUES ($1, $2, 'flutterwave', 'pending', $3)`,
      [userId, plan.price, txRef]
    );

    await client.query("COMMIT");

    return res.status(200).send(JSON.stringify({
      success: true,
      account_number: accountNumber,
      bank_name: bankName,
      amount: plan.price,
      narration: accountName,
      phone: cleanPhone,
      txRef: txRef
    }));

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("API error during checkout new:", err.message);
    return res.status(400).send(JSON.stringify({ error: err.message }));
  } finally {
    client.release();
  }
});

app.post("/api/checkout/existing", async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (!validateOrigin(req, res)) return;

  const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown-ip";
  if (!checkRateLimit(ip)) {
    return res.status(429).send(JSON.stringify({ error: "Too many payment requests. Please wait 10 minutes." }));
  }

  const { username, planId } = req.body || {};

  if (!username || !planId) {
    return res.status(400).send(JSON.stringify({ error: "Missing required fields (username, planId)." }));
  }

  const planRes = await db.query("SELECT * FROM plans WHERE id = $1", [planId]);
  const plan = planRes.rows[0];
  if (!plan) {
    return res.status(400).send(JSON.stringify({ error: "Selected plan does not exist." }));
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Find User
    const userRes = await client.query("SELECT * FROM users WHERE LOWER(hotspot_username) = LOWER($1) LIMIT 1", [username]);
    if (userRes.rows.length === 0) {
      throw new Error("Hotspot username not found. If you don't have an account, please use the 'New User' tab.");
    }
    const user = userRes.rows[0];

    // Create/update chat session (needed for fulfillPayment webhook)
    await client.query(
      `INSERT INTO chat_sessions (phone, state, plan_id, preferred_platform)
       VALUES ($1, 'awaiting_payment', $2, 'whatsapp')
       ON CONFLICT (phone) DO UPDATE SET
         state = EXCLUDED.state,
         plan_id = EXCLUDED.plan_id`,
      [user.phone, plan.id]
    );

    // Call Flutterwave to generate Virtual Account details
    const { txRef, accountNumber, accountName, bankName } = await createDynamicVirtualAccount(user.phone, plan.price, plan.name);

    // Create payment entry
    await client.query(
      `INSERT INTO payments (user_id, amount, provider, status, virtual_account_reference)
       VALUES ($1, $2, 'flutterwave', 'pending', $3)`,
      [user.id, plan.price, txRef]
    );

    await client.query("COMMIT");

    return res.status(200).send(JSON.stringify({
      success: true,
      account_number: accountNumber,
      bank_name: bankName,
      amount: plan.price,
      narration: accountName,
      phone: user.phone,
      txRef: txRef
    }));

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("API error during checkout existing:", err.message);
    return res.status(400).send(JSON.stringify({ error: err.message }));
  } finally {
    client.release();
  }
});

app.get("/api/checkout/status/:txRef", async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  const txRef = req.params.txRef;
  if (!txRef) {
    return res.status(400).send(JSON.stringify({ error: "Missing txRef" }));
  }

  try {
    const paymentRes = await db.query(
      `SELECT status FROM payments WHERE virtual_account_reference = $1 LIMIT 1`,
      [txRef]
    );

    if (paymentRes.rows.length === 0) {
      return res.status(404).send(JSON.stringify({ error: "Transaction not found" }));
    }

    return res.status(200).send(JSON.stringify({ status: paymentRes.rows[0].status }));
  } catch (err) {
    console.error("API error checking status:", err.message);
    return res.status(500).send(JSON.stringify({ error: "Server error" }));
  }
});


// Flutterwave Webhook
app.post("/webhook/flutterwave", async (req, res) => {
  console.log("Received flutterwave webhook");
  // 1. Verify signature — Flutterwave sends the secret hash you set in the dashboard
  //    as a plain string in the 'verif-hash' header (no HMAC needed)
  const signature = req.headers["verif-hash"];
  if (!signature || signature !== process.env.FLW_SECRET_HASH) {
    req.log.error("Invalid Flutterwave webhook signature");
    return res.status(401).send("Invalid signature");
  }

  // 2. Acknowledge immediately — Flutterwave retries if we don't respond quickly
  res.status(200).send("OK");

  const event = req.body;

  console.log(event);

  if (process.env.NODE_ENV == "production") {
    // v3 bank transfer webhook: status and tx_ref are inside event.data
    const data = event.data || {};

    if (
      event["event.type"] === "BANK_TRANSFER_TRANSACTION" &&
      data.status === "successful"
    ) {
      const txRef = data.tx_ref;
      const amountPaid = Number(data.amount || 0);

      if (!txRef) {
        req.log.error("Webhook: missing tx_ref in event.data");
        return;
      }

      try {
        const paymentRes = await db.query(
          `
                SELECT u.* FROM payments p
                JOIN users u ON u.id = p.user_id
                WHERE p.virtual_account_reference = $1 AND p.status = 'pending'
                LIMIT 1
            `,
          [txRef],
        );

        const user = paymentRes.rows[0];

        if (user) {
          if (!globalSock && !telegramBot) {
            req.log.error("Bots are not connected yet");
            return;
          }
          await fulfillPayment(db, user, amountPaid);
        } else {
          req.log.warn(
            { txRef },
            "Webhook: no pending payment found for txRef",
          );
        }
      } catch (error) {
        req.log.error({ error }, "Webhook Fulfillment Error");
      }
    }
  } else {
    // v3 bank transfer webhook: flat payload, event type in "event.type" key
    if (
      event["event.type"] === "BANK_TRANSFER_TRANSACTION" &&
      event.status === "successful"
    ) {
      const txRef = event.txRef;
      const amountPaid = Number(event.amount || 0);

      try {
        const paymentRes = await db.query(
          `
                SELECT u.* FROM payments p
                JOIN users u ON u.id = p.user_id
                WHERE p.virtual_account_reference = $1 AND p.status = 'pending'
                LIMIT 1
            `,
          [txRef],
        );

        const user = paymentRes.rows[0];

        if (user) {
          if (!globalSock && !telegramBot) {
            req.log.error("Bots are not connected yet");
            return;
          }
          await fulfillPayment(db, user, amountPaid);

        } else {
          req.log.warn(
            { txRef },
            "Webhook: no pending payment found for txRef",
          );
        }
      } catch (error) {
        req.log.error({ error }, "Webhook Fulfillment Error");
      }
    }
  }
});

app.listen(process.env.PORT || 3001, async () => {
  // 1. Ensure DB tables exist before running anything else
  await setupDB();

  // 2. Pre-initialize the messaging router with db pool immediately
  // to avoid "DB pool not initialized" if schedulers run before bots connect
  initMessaging(db, null, null);

  // 3. Start bots in background
  startBot().catch(err => console.error("❌ Error starting bots:", err));

  // Provisioning retry scheduler — checks every 60s for queued MikroTik jobs
  setInterval(async () => {
    try {
      await processPendingQueue(db);
    } catch (err) {
      console.error("⚠️ Provisioning queue scheduler error:", err.message);
    }
  }, 60_000); // every 60 seconds

  console.log("🕐 Provisioning retry scheduler started (60s interval)");

  // Expiry alerts + MikroTik cleanup
  startScheduler(db);
});
