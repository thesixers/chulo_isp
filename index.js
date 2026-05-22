import vibe from "vibe-gx"
import { handleMessage } from "./handleMessage.js"
import { connectToWhatsApp } from "./whatsapp-connect.js"
import pg from "pg"
import { fulfillPayment } from "./fulfillPayment.js"
import { processPendingQueue } from "./provisioningQueue.js"
import fs from "fs"

// Prevent third-party library errors (e.g. mikronode-ng socket callbacks) from crashing the server
process.on('uncaughtException', (err) => {
    console.error('⚠️  Uncaught Exception (non-fatal):', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('⚠️  Unhandled Promise Rejection (non-fatal):', reason);
});

const app = vibe({
    logger: {
    lifecycle: true,
    prettyPrint: process.env.NODE_ENV !== "production",
  },
})

const db = new pg.Pool({
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
    port: process.env.PGPORT,
})

app.decorate("db", db);

const setupDB = async () => {
    try {
        const sql = fs.readFileSync("./schema.sql", "utf8");
        await db.query(sql);
        console.log("✅ Database Setup Complete!");
    } catch (err) {
        // Non-fatal — tables/types likely already exist from a previous run
        console.warn("⚠️  DB setup warning (safe to ignore if tables already exist):", err.message);
    }
}

let globalSock = null;

async function startBot() {
    globalSock = await connectToWhatsApp(
        (sock, from, text, pushName) => handleMessage(sock, from, text, pushName, db),
        (newSock) => {
            globalSock = newSock;
            console.log("🔄 globalSock updated to live WhatsApp socket");
        }
    );
}

app.get("/", () => "Welcome to Chulo ISP")

// Test endpoint — hit this to verify proactive WhatsApp sends work
// Usage: curl http://localhost:3003/test-send
app.get("/test-send", async (req, res) => {
    if (!globalSock) return res.status(503).send("WhatsApp not connected");
    try {
        // Use the stored remote_jid from the last known session
        const result = await db.query(`SELECT remote_jid FROM whatsapp_sessions ORDER BY last_updated DESC LIMIT 1`);
        const jid = result.rows[0]?.remote_jid;
        if (!jid) return res.status(404).send("No session found in DB");
        await globalSock.sendMessage(jid, { text: "🔔 Test message from Chulo ISP server" });
        res.send(`✅ Message sent to ${jid}`);
    } catch (err) {
        res.status(500).send(`❌ Failed: ${err.message}`);
    }
})

// Flutterwave Webhook
app.post("/webhook/flutterwave", async (req, res) => {
    // 1. Verify signature — Flutterwave sends the secret hash you set in the dashboard
    //    as a plain string in the 'verif-hash' header (no HMAC needed)
    const signature = req.headers['verif-hash'];
    if (!signature || signature !== process.env.FLW_SECRET_HASH) {
        req.log.error("Invalid Flutterwave webhook signature");
        return res.status(401).send("Invalid signature");
    }

    // 2. Acknowledge immediately — Flutterwave retries if we don't respond quickly
    res.status(200).send("OK");

    const event = req.body;
    console.log("🔔 FLW Webhook received:", JSON.stringify(event, null, 2));

    // v3 bank transfer webhook: flat payload, event type in "event.type" key
    if (event["event.type"] === 'BANK_TRANSFER_TRANSACTION' && event.status === 'successful') {
        const txRef = event.txRef;

        try {
            const paymentRes = await db.query(`
                SELECT u.* FROM payments p
                JOIN users u ON u.id = p.user_id
                WHERE p.virtual_account_reference = $1 AND p.status = 'pending'
                LIMIT 1
            `, [txRef]);

            const user = paymentRes.rows[0];

            if (user) {
                if (!globalSock) {
                    req.log.error("globalSock is null — WhatsApp not connected yet");
                    return;
                }
                await fulfillPayment(db, globalSock, user);
            } else {
                req.log.warn({ txRef }, "Webhook: no pending payment found for txRef");
            }
        } catch (error) {
            req.log.error({ error }, "Webhook Fulfillment Error");
        }
    }
})

app.listen(process.env.PORT || 3001, () => {
  startBot();
  setupDB();

  // Provisioning retry scheduler — checks every 60s for queued MikroTik jobs
  setInterval(async () => {
      if (!globalSock) return; // Don't retry if WhatsApp isn't connected yet
      try {
          await processPendingQueue(db, globalSock);
      } catch (err) {
          console.error('⚠️ Provisioning queue scheduler error:', err.message);
      }
  }, 60_000); // every 60 seconds

  console.log('🕐 Provisioning retry scheduler started (60s interval)');
})