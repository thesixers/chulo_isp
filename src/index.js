import vibe from "vibe-gx";
import { handleMessage } from "./handleMessage.js";
import { connectToWhatsApp } from "./whatsapp-connect.js";
import { startTelegramBot } from "./telegram-connect.js";
import { initMessaging, updateWhatsAppSocket, updateTelegramBot } from "./messaging.js";
import pg from "pg";
import { fulfillPayment } from "./fulfillPayment.js";
import { processPendingQueue } from "./provisioningQueue.js";
import { startScheduler } from "./scheduler.js";
import fs from "fs";

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

const db = new pg.Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
});

app.decorate("db", db);

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
