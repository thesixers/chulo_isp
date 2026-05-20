import { provisionHotspotUser } from './mikrotik.js';

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
    const remoteJid = `${user.phone}@s.whatsapp.net`;

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

    // 2. Get the plan they selected (stored in their WhatsApp session)
    const sessionRes = await db.query(`SELECT plan_id FROM whatsapp_sessions WHERE phone = $1`, [user.phone]);
    const planId = sessionRes.rows[0]?.plan_id;

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

    // 8. Provision on MikroTik (over WireGuard) — handled separately so failure doesn't block confirmation
    try {
        const pin = await provisionHotspotUser(user.phone, plan.name);

        // Send credentials once MikroTik responds
        if (isRenewal) {
            await sock.sendMessage(remoteJid, {
                text: `🎉 *You're back online!*\n\n🌐 *Your Starlink Login*\nUsername: \`${user.phone}\`\nPassword: \`${pin}\`\n\nConnect at: *http://hotspot.chulo*\nEnjoy your internet! 🛰️`,
            });
        } else {
            await sock.sendMessage(remoteJid, {
                text: `🎉 *Your Chulo Starlink account is ready!*\n\n🌐 *Login Details*\nUsername: \`${user.phone}\`\nPassword: \`${pin}\`\n\nConnect at: *http://hotspot.chulo*\n\nWelcome to Chulo ISP! 🛰️`,
            });
        }
    } catch (err) {
        console.error('MikroTik provisioning failed:', err);

        // Let the user know credentials will be sent manually
        await sock.sendMessage(remoteJid, {
            text: `⚙️ Your account is active but we're experiencing a brief delay setting up your login credentials.\n\nOur team will send your *username and password* shortly. Thank you for your patience! 🙏`,
        });
    }
}
