import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
} from "@whiskeysockets/baileys";

import pino from "pino";
import qrcode from "qrcode-terminal";

export async function connectToWhatsApp(onMessage, onReconnect) {
  const { state, saveCreds } = await useMultiFileAuthState("auth");

  const sock = makeWASocket({
    logger: pino({ level: "silent" }),
    auth: state,
    printQRInTerminal: true,
    syncFullHistory: false, // Memory Optimization: Do not download old chats
    markOnlineOnConnect: false, // Memory Optimization: Do not aggressively broadcast presence
    generateHighQualityLinkPreview: false,
    getMessage: async () => {
      // Memory Optimization: Prevents Baileys from locally caching messages for replies
      return { conversation: "hello" };
    },
  });

  // ─────────────────────────────────────────────────────────
  // ANTI-BAN HUMANIZER: Intercept and delay all outgoing messages
  // ─────────────────────────────────────────────────────────
  const originalSendMessage = sock.sendMessage.bind(sock);

  sock.sendMessage = async (jid, content, options) => {
    // If it's a direct text message, simulate human typingmakeWASocket
    if (content && content.text) {
      try {
        await sock.presenceSubscribe(jid);
        await sock.sendPresenceUpdate("composing", jid);

        // Calculate realistic delay: 500ms base + 30ms per character (capped at 3 seconds)
        const delay = Math.min(3000, 500 + content.text.length * 30);
        await new Promise((resolve) => setTimeout(resolve, delay));

        await sock.sendPresenceUpdate("paused", jid);
      } catch (err) {
        // Ignore presence update errors (e.g. if socket reconnects mid-typing)
        console.warn(
          `⚠️ Typing simulation failed for ${jid}, sending anyway...`
        );
      }
    }
    return originalSendMessage(jid, content, options);
  };

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;

      if (shouldReconnect) {
        // On reconnect, update the caller's socket reference
        connectToWhatsApp(onMessage, onReconnect).then((newSock) => {
          if (onReconnect) onReconnect(newSock);
        });
      }
    }

    if (connection === "open") {
      console.log("WhatsApp Connected ✔");
      // Notify caller that this socket is live (covers initial connect too)
      if (onReconnect) onReconnect(sock);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];

    // Ignore messages sent by the bot itself
    if (msg.key.fromMe) return;

    const jid = msg.key.remoteJid;

    // Reject groups, broadcasts, newsletters, status
    if (
      jid.endsWith("@g.us") ||
      jid.endsWith("@broadcast") ||
      jid.endsWith("@newsletter") ||
      jid === "status@broadcast"
    )
      return;

    // Only accept direct DMs — PN (@s.whatsapp.net) or LID (@lid)
    if (!jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@lid")) return;

    if (!msg.message) return;

    const text =
      msg.message.conversation || msg.message.extendedTextMessage?.text;

    if (!text) return;

    // from  = the JID we reply to (could be LID or PN — use as-is)
    // pnJid = the phone-number JID for DB phone extraction
    //         if primary JID is LID, remoteJidAlt should be the PN JID
    const from = jid;
    const pnJid = jid.endsWith("@s.whatsapp.net")
      ? jid
      : msg.key.remoteJidAlt || jid; // fall back to LID if no alt available

    const pushName = msg.pushName || null; // WhatsApp display name

    await onMessage(sock, from, pnJid, text, pushName);
  });

  return sock;
}
