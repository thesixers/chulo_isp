import { provisionHotspotUser, buildMikrotikComment } from './mikrotik.js';
import { enqueueProvisioning } from './provisioningQueue.js';

/**
 * Fulfills a confirmed payment:
 * - First-time users: sends confirmation, then asks them to choose a hotspot username/password
 * - Renewals: sends confirmation, then re-provisions on MikroTik using stored credentials
 *
 * @param {object} db   - pg Pool instance
 * @param {object} sock - Baileys socket instance
 * @param {object} user - Full user row from the `users` table
 */
export async function fulfillPayment(db, sock, user) {
    // Use the exact JID stored from the user's last message — avoids LID/phone mismatch
    const sessionRes = await db.query(
        `SELECT plan_id, remote_jid FROM whatsapp_sessions WHERE phone = $1`,
        [user.phone]
    );
    const session   = sessionRes.rows[0];
    const remoteJid = session?.remote_jid || `${user.phone}@s.whatsapp.net`;

    console.log(`💬 fulfillPayment: remoteJid=${remoteJid}`);

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

    // 2. Get the plan from the session
    const planId = session?.plan_id;
    if (!planId) {
        await sock.sendMessage(remoteJid, {
            text: `⚠️ We couldn't find your selected plan. Please send *HI* to start over.`,
        });
        return;
    }

    const planRes = await db.query(`SELECT * FROM plans WHERE id = $1`, [planId]);
    const plan    = planRes.rows[0];
    if (!plan) {
        await sock.sendMessage(remoteJid, {
            text: `⚠️ Your selected plan no longer exists. Please send *HI* to choose a new one.`,
        });
        return;
    }

    // 3. Mark payment as completed
    await db.query(
        `UPDATE payments SET status = 'completed', paid_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [payment.id]
    );

    // 4. Calculate subscription expiry (extend from current active sub if renewal)
    const activeSubRes = await db.query(`
        SELECT s.*, p.mikrotik_profile FROM subscriptions s
        JOIN plans p ON p.id = s.plan_id
        WHERE s.user_id = $1 AND s.status = 'active' AND s.expiry_time > CURRENT_TIMESTAMP
        ORDER BY s.expiry_time DESC LIMIT 1
    `, [user.id]);

    const activeSub = activeSubRes.rows[0];
    const isRenewal = !!activeSub;
    const isCrossProfile = isRenewal && activeSub.mikrotik_profile !== plan.mikrotik_profile;

    const renewingEarly = isRenewal && new Date(activeSub.expiry_time) > new Date();
    // Loyalty bonus: monthly plans get 3 free days, weekly/3-day get 1 free day
    const bonusDays = renewingEarly ? (plan.duration_days >= 28 ? 3 : 1) : 0;

    let newExpiry = new Date();
    if (isRenewal) newExpiry = new Date(activeSub.expiry_time);
    newExpiry.setDate(newExpiry.getDate() + plan.duration_days + bonusDays);

    // 5. Create the subscription record
    if (isCrossProfile) {
        await db.query(`
            INSERT INTO subscriptions (user_id, plan_id, status, start_time, expiry_time, alert_sent)
            VALUES ($1, $2, 'queued', $3, $4, false)
        `, [user.id, plan.id, activeSub.expiry_time, newExpiry]);
    } else {
        await db.query(`
            INSERT INTO subscriptions (user_id, plan_id, status, start_time, expiry_time, alert_sent)
            VALUES ($1, $2, 'active', CURRENT_TIMESTAMP, $3, false)
        `, [user.id, plan.id, newExpiry]);
    }

    // 6. Send payment confirmation
    console.log(`📤 Sending payment confirmation to ${remoteJid} (isRenewal=${isRenewal}, isCrossProfile=${isCrossProfile})`);
    try {
        if (isCrossProfile) {
            await sock.sendMessage(remoteJid, {
                text:
                    `✅ *Payment Confirmed!*\n\n` +
                    `💰 ₦${Number(plan.price).toLocaleString()} received for *${plan.name}*\n\n` +
                    `⏳ *Plan Queued*\n` +
                    `Your new plan will automatically activate exactly when your current plan expires on *${new Date(activeSub.expiry_time).toDateString()}*.\n` +
                    (bonusDays > 0 ? `\n🎁 *+${bonusDays} free day${bonusDays > 1 ? 's' : ''} added* for renewing early! 🎉` : ''),
            });
        } else {
            await sock.sendMessage(remoteJid, {
                text:
                    `✅ *Payment Confirmed!*\n\n` +
                    `💰 ₦${Number(plan.price).toLocaleString()} received for *${plan.name}*\n` +
                    `📅 Expires: *${newExpiry.toDateString()}*` +
                    (renewingEarly ? `\n\n🎁 *+${bonusDays} free day${bonusDays > 1 ? 's' : ''} added* for renewing early! 🎉` : '') +
                    promoTip(plan.duration_days),
            });
        }
    } catch (msgErr) {
        console.error(`❌ Failed to send confirmation to ${remoteJid}:`, msgErr.message);
    }

    // 7. Branch: renewal vs first-time vs cross-profile
    if (isCrossProfile) {
        // ── CROSS-PROFILE: Do not provision on MikroTik yet. Reset session. ──
        await db.query(
            `UPDATE whatsapp_sessions SET state = 'start', plan_id = NULL WHERE phone = $1`,
            [user.phone]
        );
    } else if (isRenewal && user.hotspot_username && user.hotspot_password) {
        // ── RENEWAL: provision using stored credentials immediately ────────────────
        await db.query(
            `UPDATE whatsapp_sessions SET state = 'start', plan_id = NULL WHERE phone = $1`,
            [user.phone]
        );
        await provisionOrQueue(db, sock, user, plan, remoteJid, user.hotspot_username, user.hotspot_password, true, newExpiry);

    } else {
        // ── FIRST TIME (or credentials not yet set): ask user to choose them ──
        await db.query(`
            UPDATE whatsapp_sessions
            SET state = 'awaiting_hotspot_username', plan_id = $1, last_updated = CURRENT_TIMESTAMP
            WHERE phone = $2
        `, [plan.id, user.phone]);

        await sock.sendMessage(remoteJid, {
            text:
                `🔐 *Set Up Your Hotspot Login*\n\n` +
                `Please choose a *username* for your internet connection.\n\n` +
                `Rules:\n` +
                `• Letters and numbers only (no emojis or spaces)\n` +
                `• 3–20 characters\n` +
                `• Example: \`john2024\`\n\n` +
                `Reply with your desired username:`,
        });
    }
}

/**
 * Returns a loyalty promo tip message based on plan duration.
 * Shown in payment confirmation and provisioning success messages.
 */
function promoTip(durationDays) {
    if (durationDays >= 28) return '\n\n🎁 *Tip: Renew before your plan expires and get 3 FREE days added!*';
    if (durationDays >=  3) return '\n\n🎁 *Tip: Renew before your plan expires and get 1 FREE day added!*';
    return '';
}

/**
 * Provisions the user on MikroTik or queues for retry on failure.
 */
export async function provisionOrQueue(db, sock, user, plan, remoteJid, username, password, isRenewal, expiryTime = null) {
    try {
        const comment = expiryTime ? buildMikrotikComment(user.phone, plan.duration_days, expiryTime) : null;
        await provisionHotspotUser(username, plan.mikrotik_profile, password, comment);

        // Save credentials on the user record
        await db.query(
            `UPDATE users SET hotspot_username = $1, hotspot_password = $2 WHERE id = $3`,
            [username, password, user.id]
        );

        if (isRenewal) {
            await sock.sendMessage(remoteJid, {
                text:
                    `🎉 *You're back online!*\n\n` +
                    `🌐 *Your Starlink Login*\n` +
                    `Username: \`${username}\`\n` +
                    `Password: \`${password}\`\n\n` +
                    `Connect at: *http://10.5.50.1*\n` +
                    `Enjoy your internet! 🛰️` +
                    promoTip(plan.duration_days),
            });
        } else {
            await sock.sendMessage(remoteJid, {
                text:
                    `🎉 *Your Chulo ISP account is ready!*\n\n` +
                    `🌐 *Login Details*\n` +
                    `Username: \`${username}\`\n` +
                    `Password: \`${password}\`\n\n` +
                    `Connect at: *http://10.5.50.1*\n\n` +
                    `Welcome to Chulo ISP! 🛰️` +
                    promoTip(plan.duration_days),
            });
        }

    } catch (err) {
        console.error('MikroTik provisioning failed — queuing for retry:', err.message);

        await sock.sendMessage(remoteJid, {
            text:
                `⚙️ *Account Setup in Progress*\n\n` +
                `Your payment is confirmed ✅\n\n` +
                `We're having a brief issue connecting to the hotspot router. ` +
                `Our system will *automatically retry* and send your credentials once restored.\n\n` +
                `⏳ No action needed — you'll receive your login details shortly!`,
        });

        try {
            await enqueueProvisioning(db, {
                userId: user.id,
                remoteJid,
                phone: username, // username IS the MikroTik username
                mikrotikProfile: plan.mikrotik_profile,
                planName: plan.name,
                pin: password,
            });
        } catch (queueErr) {
            console.error('Failed to enqueue provisioning job:', queueErr.message);
        }
    }
}
