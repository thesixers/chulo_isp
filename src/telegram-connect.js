import { Telegraf } from "telegraf";
import https from "https";
import { updateTelegramBot } from "./messaging.js";

export function startTelegramBot(db, onMessage) {
  const token = process.env.TELEGRAM_TOKEN?.trim();

  if (!token) {
    console.log("⚠️ No TELEGRAM_TOKEN found in .env, Telegram bot is disabled.");
    return;
  }

  // Force IPv4 at the socket level — fixes ETIMEDOUT on dual-stack hosts
  // where node-fetch defaults to IPv6 which may not reach api.telegram.org
  const agent = new https.Agent({ family: 4 });
  const bot = new Telegraf(token, { telegram: { agent } });

  // ── Global error handler ───────────────────────────────────────────────
  bot.catch((err) => {
    console.error("❌ Telegraf Handler Error:", err.message);
  });

  // ── /start ────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    try {
      await ctx.reply(
        "👋 Welcome to Chulo Speednet! To securely link your account and access your subscription, please share your phone number.",
        {
          reply_markup: {
            keyboard: [[{ text: "📱 Share Phone Number", request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        }
      );
    } catch (err) {
      console.error("❌ /start error:", err.message);
    }
  });

  // ── Contact handler (phone linking) ───────────────────────────────────
  bot.on("contact", async (ctx) => {
    try {
      const contact  = ctx.message.contact;
      const phone    = contact.phone_number.replace(/^\+/, "");
      const chatId   = ctx.from.id.toString();
      const pushName = ctx.from.first_name || "User";

      await ctx.reply("✅ Account linked successfully!", {
        reply_markup: { remove_keyboard: true },
      });

      await onMessage("telegram", chatId, phone, "hi", pushName);
    } catch (err) {
      console.error("❌ Contact handler failed:", err.message);
    }
  });

  // ── Text handler ───────────────────────────────────────────────────────
  bot.on("text", async (ctx) => {
    try {
      const text     = ctx.message.text;
      const chatId   = ctx.from.id.toString();
      const pushName = ctx.from.first_name || "User";

      if (text.startsWith("/")) return;

      const res = await db.query(
        `SELECT phone FROM chat_sessions WHERE telegram_chat_id = $1`,
        [chatId]
      );

      if (res.rows.length === 0) {
        return await ctx.reply(
          "Please share your phone number using the button below to continue.",
          {
            reply_markup: {
              keyboard: [[{ text: "📱 Share Phone Number", request_contact: true }]],
              resize_keyboard: true,
              one_time_keyboard: true,
            },
          }
        );
      }

      const phone = res.rows[0].phone;
      await onMessage("telegram", chatId, phone, text, pushName);
    } catch (err) {
      console.error("❌ Text handler failed:", err.stack || err);
    }
  });

  process.once("SIGINT",  () => { try { bot.stop("SIGINT");  } catch (_) {} });
  process.once("SIGTERM", () => { try { bot.stop("SIGTERM"); } catch (_) {} });

  // ── Infinite reconnect loop ────────────────────────────────────────────
  // Never gives up — keeps trying until Telegram API is reachable.
  // Backoff: 5s → 10s → 15s → … → 60s (max), then stays at 60s.
  async function tryConnect(attempt = 1) {
    try {
      const me = await bot.telegram.getMe();
      console.log(`🤖 Telegram Bot Connected ✔ (@${me.username})`);

      // Register with the messaging router immediately
      updateTelegramBot(bot);
      console.log("✅ Telegram registered with messaging router");

      // Start long-poll loop (fire-and-forget).
      // If it ever dies (e.g. network drop), restart the whole connect cycle.
      bot.launch().catch((err) => {
        console.error("⚠️ Telegram polling stopped:", err.message);
        console.log("⏳ Telegram reconnecting in 30s...");
        setTimeout(() => tryConnect(1), 30_000);
      });

    } catch (err) {
      const delay = Math.min(60_000, 5_000 * attempt);
      console.warn(`⚠️ Telegram connection attempt ${attempt} failed: ${err.message}`);
      console.log(`⏳ Retrying Telegram in ${Math.round(delay / 1000)}s...`);
      setTimeout(() => tryConnect(attempt + 1), delay);
    }
  }

  console.log("🤖 Telegram Bot connecting...");
  tryConnect();
}