import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason
} from "@whiskeysockets/baileys";

import pino from "pino";
import qrcode from "qrcode-terminal";

export async function connectToWhatsApp(onMessage, onReconnect) {
    const { state, saveCreds } = await useMultiFileAuthState('auth');

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

            if (shouldReconnect) {
                // On reconnect, update the caller's socket reference
                connectToWhatsApp(onMessage, onReconnect).then(newSock => {
                    if (onReconnect) onReconnect(newSock);
                });
            }
        }

        if (connection === 'open') {
            console.log("WhatsApp Connected ✔");
            // Notify caller that this socket is live (covers initial connect too)
            if (onReconnect) onReconnect(sock);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];

        // Ignore messages sent by the bot itself
        if (msg.key.fromMe) return;

        // Ignore group messages — only handle direct (private) chats
        if (msg.key.remoteJid.endsWith('@g.us')) return;

        if (!msg.message) return;

        const text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text;

        const from     = msg.key.remoteJid;
        const pushName = msg.pushName || null; // WhatsApp display name

        await onMessage(sock, from, text, pushName);
    });

    return sock;
}