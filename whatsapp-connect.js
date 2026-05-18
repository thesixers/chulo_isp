import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason
} from "@whiskeysockets/baileys";

import pino from "pino";
import qrcode from "qrcode-terminal";

export async function connectToWhatsApp(onMessage) {
    const { state, saveCreds } = await useMultiFileAuthState('auth');

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false
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
                connectToWhatsApp(onMessage);
            }
        }

        if (connection === 'open') {
            console.log("WhatsApp Connected ✔");
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text;

        const from = msg.key.remoteJid;

        await onMessage(sock, from, text);
    });

    return sock;
}