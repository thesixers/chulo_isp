export let waSock = null;
export let tgBot = null;
export let dbPool = null;

export function initMessaging(db, whatsappSock, telegramBot) {
  dbPool = db;
  if (whatsappSock) waSock = whatsappSock;
  if (telegramBot) tgBot = telegramBot;
}

export function updateWhatsAppSocket(sock) {
  waSock = sock;
}

export function updateTelegramBot(bot) {
  tgBot = bot;
}

// Internal function to send specifically to WhatsApp with delay
async function sendViaWhatsApp(jid, text) {
  if (!waSock) throw new Error("WhatsApp bot not initialized");
  if (!waSock.user) throw new Error("WhatsApp socket not fully authenticated");

  try {
    await waSock.sendPresenceUpdate("composing", jid);
    const delay = Math.min(3000, 500 + text.length * 30);
    await new Promise((resolve) => setTimeout(resolve, delay));
    await waSock.sendPresenceUpdate("paused", jid);
  } catch (err) {
    console.warn(`⚠️ Typing simulation failed for ${jid}, sending anyway...`);
  }

  // The actual send (we'll call the original function, avoiding infinite loops if overridden)
  return await waSock.sendMessage(jid, { text });
}

// Internal function to send specifically to Telegram
async function sendViaTelegram(chatId, text) {
  if (!tgBot) throw new Error("Telegram bot not initialized");
  try {
    return await tgBot.telegram.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } catch (err) {
    // Fallback to plain text if Markdown parsing fails (e.g. unescaped special chars)
    if (err.message?.includes("can't parse entities")) {
      return await tgBot.telegram.sendMessage(chatId, text);
    }
    throw err;
  }
}

// Queue message for later
async function queueMessage(phone, text, sendToBoth) {
  if (!dbPool) return;
  await dbPool.query(
    `INSERT INTO message_queue (phone, message_text, send_to_both) VALUES ($1, $2, $3)`,
    [phone, text, sendToBoth]
  );
  console.log(`📥 Message queued for ${phone} due to delivery failure.`);
}

/**
 * Smart centralized sender
 * @param {string} phone The user's phone number (primary key)
 * @param {string} text The message text
 * @param {object} options { sendToBoth: boolean }
 */
export async function sendMessage(phone, text, options = {}) {
  const { sendToBoth = false } = options;

  if (!dbPool) {
    console.error("❌ Messaging router: DB pool not initialized.");
    return false;
  }

  const res = await dbPool.query(
    `SELECT remote_jid, telegram_chat_id, preferred_platform FROM chat_sessions WHERE phone = $1`,
    [phone]
  );

  if (res.rows.length === 0) {
    console.warn(`⚠️ No chat session found for ${phone}, dropping message.`);
    return false;
  }

  const session = res.rows[0];
  const { remote_jid, telegram_chat_id, preferred_platform } = session;

  let waSuccess = false;
  let tgSuccess = false;

  // Try WhatsApp
  const tryWA = async () => {
    if (remote_jid) {
      try {
        await sendViaWhatsApp(remote_jid, text);
        waSuccess = true;
      } catch (e) {
        console.warn(`⚠️ WhatsApp send failed for ${phone}:`, e.message);
      }
    }
  };

  // Try Telegram
  const tryTG = async () => {
    if (telegram_chat_id) {
      try {
        await sendViaTelegram(telegram_chat_id, text);
        tgSuccess = true;
      } catch (e) {
        console.warn(`⚠️ Telegram send failed for ${phone}:`, e.message);
      }
    }
  };

  if (sendToBoth) {
    // Fire both sequentially or parallel
    await tryWA();
    await tryTG();
    
    // If BOTH failed (or neither existed), queue it
    if (!waSuccess && !tgSuccess) {
      await queueMessage(phone, text, true);
      return false;
    }
    return true;
  }

  // Otherwise, use preferred platform with fallback
  if (preferred_platform === "whatsapp") {
    await tryWA();
    if (!waSuccess) {
      console.log(`🔄 WhatsApp failed/unavailable for ${phone}, falling back to Telegram...`);
      await tryTG();
    }
  } else if (preferred_platform === "telegram") {
    await tryTG();
    if (!tgSuccess) {
      console.log(`🔄 Telegram failed/unavailable for ${phone}, falling back to WhatsApp...`);
      await tryWA();
    }
  } else {
    // If no preference (shouldn't happen, defaults to whatsapp), just try what we have
    if (remote_jid) {
      await tryWA();
    }
    if (!waSuccess && telegram_chat_id) {
      await tryTG();
    }
  }

  if (!waSuccess && !tgSuccess) {
    await queueMessage(phone, text, false);
    return false;
  }

  return true;
}
