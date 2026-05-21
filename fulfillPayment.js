import { provisionHotspotUser } from './mikrotik.js';
import { enqueueProvisioning } from './provisioningQueue.js';

/**
 * Fulfills a confirmed payment for a user.
 * Sends an immediate confirmation message, then attempts MikroTik provisioning separately.
 * MikroTik failure does NOT block the confirmation — the user always gets notified.
 *
 * @param {object} db       - pg Pool instance
 * @param {object} sock     - Baileys socket instance
 * @param {object} user     - Full user row from the `users` table
 * @returns {Promise<void>}
 */
export async function fulfillPayment(db, sock, user) {
    // Use the exact JID stored from the user's last message — avoids LID/phone mismatch
    const sessionRes = await db.query(
        `SELECT plan_id, remote_jid FROM whatsapp_sessions WHERE phone = $1`,
        [user.phone]
    );
    const session = sessionRes.rows[0];
    const remoteJid = session?.remote_jid || `${user.phone}@s.whatsapp.net`;

    console.log(`💬 fulfillPayment: sending to remoteJid=${remoteJid}`);

    // 1. Find the user's latest pending payment
    const paymentRes = await db.query(`
        SELECT * FROM payments
        WHERE user_id = $1 AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1
    `, [user.id]);

    const payment = paymentRes.rows[0];
    if (!payment) {
        await sock.sendMessage(remoteJid, {
            text: `⚠️ We couldn't find a pending payment on your account. Please send *HI* to start a new session.`,
        });
        return;
    }

    // 2. Get the plan from the session already fetched above
    const planId = session?.plan_id;

    if (!planId) {
        await sock.sendMessage(remoteJid, {
            text: `⚠️ We couldn't find your selected plan. Please send *HI* to start over.`,
        });
        return;
    }

    const planRes = await db.query(`SELECT * FROM plans WHERE id = $1`, [planId]);
    const plan = planRes.rows[0];

    if (!plan) {
        await sock.sendMessage(remoteJid, {
            text: `⚠️ Your selected plan no longer exists. Please send *HI* to choose a new one.`,
        });
        return;
    }

    // 3. Mark the payment as completed
    await db.query(
        `UPDATE payments SET status = 'completed', paid_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [payment.id]
    );

    // 4. Calculate subscription expiry (extend from current active sub if one exists)
    const activeSubRes = await db.query(`
        SELECT * FROM subscriptions
        WHERE user_id = $1 AND status = 'active' AND expiry_time > CURRENT_TIMESTAMP
        ORDER BY expiry_time DESC LIMIT 1
    `, [user.id]);

    const isRenewal = activeSubRes.rows.length > 0;

    let newExpiry = new Date();
    if (isRenewal) {
        newExpiry = new Date(activeSubRes.rows[0].expiry_time);
    }
    newExpiry.setDate(newExpiry.getDate() + plan.duration_days);

    // 5. Create the subscription record
    await db.query(`
        INSERT INTO subscriptions (user_id, plan_id, status, start_time, expiry_time)
        VALUES ($1, $2, 'active', CURRENT_TIMESTAMP, $3)
    `, [user.id, plan.id, newExpiry]);

    // 6. Reset their WhatsApp session so they can buy again later
    await db.query(`
        UPDATE whatsapp_sessions SET state = 'start', plan_id = NULL, last_updated = CURRENT_TIMESTAMP
        WHERE phone = $1
    `, [user.phone]);

    // 7. Send immediate payment confirmation — this always goes out regardless of MikroTik
    console.log(`📤 Sending payment confirmation to ${remoteJid} (isRenewal=${isRenewal})`);
    try {
        if (isRenewal) {
            await sock.sendMessage(remoteJid, {
                text: `✅ *Payment Confirmed!*\n\n💰 ₦${plan.price} received for your *${plan.name}* plan.\n\n🔄 *Reconnecting you to Chulo Starlink...*\n\n📅 Your access is extended until *${newExpiry.toDateString()}*.\n\nPlease wait a moment while we update your connection.`,
            });
        } else {
            await sock.sendMessage(remoteJid, {
                text: `✅ *Payment Confirmed!*\n\n💰 ₦${plan.price} received for your *${plan.name}* plan.\n\n🚀 *Creating your Chulo Starlink login...*\n\n📅 Your access expires on *${newExpiry.toDateString()}*.\n\nPlease wait a moment while we set up your account.`,
            });
        }
        console.log(`✅ Confirmation message sent to ${remoteJid}`);
    } catch (msgErr) {
        console.error(`❌ Failed to send confirmation message to ${remoteJid}:`, msgErr);
    }

    // 8. Provision on MikroTik — pre-generate PIN so retries always use the same credentials
    const pin = Math.floor(100000 + Math.random() * 900000).toString();

    try {
        await provisionHotspotUser(user.phone, plan.mikrotik_profile, pin);

        // Success — send credentials
        if (isRenewal) {
            await sock.sendMessage(remoteJid, {
                text:
                    `🎉 *You're back online!*\n\n` +
                    `🌐 *Your Starlink Login*\n` +
                    `Username: \`${user.phone}\`\n` +
                    `Password: \`${pin}\`\n\n` +
                    `Connect at: *http://hotspot.chulo*\n` +
                    `Enjoy your internet! 🛰️`,
            });
        } else {
            await sock.sendMessage(remoteJid, {
                text:
                    `🎉 *Your Chulo Starlink account is ready!*\n\n` +
                    `🌐 *Login Details*\n` +
                    `Username: \`${user.phone}\`\n` +
                    `Password: \`${pin}\`\n\n` +
                    `Connect at: *http://hotspot.chulo*\n\n` +
                    `Welcome to Chulo ISP! 🛰️`,
            });
        }

    } catch (err) {
        console.error('MikroTik provisioning failed — queuing for retry:', err.message);

        // Notify user we'll retry automatically
        await sock.sendMessage(remoteJid, {
            text:
                `⚙️ *Account Setup in Progress*\n\n` +
                `Your payment is confirmed and your subscription is active ✅\n\n` +
                `We're having a brief issue setting up your hotspot login. ` +
                `Our system will *automatically retry* and send your credentials ` +
                `once the connection is restored.\n\n` +
                `⏳ You'll receive your username and password shortly — no action needed!`,
        });

        // Save to retry queue — scheduler will keep trying until MikroTik is reachable
        try {
            await enqueueProvisioning(db, {
                userId: user.id,
                remoteJid,
                phone: user.phone,
                mikrotikProfile: plan.mikrotik_profile,
                planName: plan.name,
                pin,
            });
        } catch (queueErr) {
            console.error('Failed to enqueue provisioning job:', queueErr.message);
        }
    }
}
