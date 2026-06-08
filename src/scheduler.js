import { removeHotspotUser, provisionHotspotUser, buildMikrotikComment } from './mikrotik.js';

const fmt = (d) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

// ─────────────────────────────────────────────────────────────────────────────
// Job A — Remove expired subscribers from MikroTik every 30 minutes
// (only removes from the router; keeps DB record for history)
// ─────────────────────────────────────────────────────────────────────────────
async function cleanupExpiredUsers(db) {
    let removed = 0, failed = 0;
    try {
        const res = await db.query(`
            SELECT s.id AS sub_id, u.hotspot_username, u.id AS user_id
            FROM subscriptions s
            JOIN users u ON u.id = s.user_id
            WHERE s.status = 'active'
              AND s.expiry_time < NOW()
              AND u.hotspot_username IS NOT NULL
        `);

        for (const row of res.rows) {
            // Check if user has a newly activated subscription (from queue)
            const activeCheck = await db.query(`
                SELECT id FROM subscriptions 
                WHERE user_id = $1 AND status = 'active' AND expiry_time > NOW()
            `, [row.user_id]);

            if (activeCheck.rowCount === 0) {
                try {
                    await removeHotspotUser(row.hotspot_username);
                    removed++;
                } catch (err) {
                    console.error(`Scheduler: MikroTik removal failed for '${row.hotspot_username}':`, err.message);
                    failed++;
                }
            } else {
                console.log(`🧹 Cleanup: Skipped removal for '${row.hotspot_username}' (they transitioned to a queued plan)`);
            }
            // Mark as expired in DB regardless of MikroTik result
            await db.query(`UPDATE subscriptions SET status = 'expired' WHERE id = $1`, [row.sub_id]);
        }

        if (res.rows.length > 0) {
            console.log(`🧹 Cleanup: ${removed} removed, ${failed} failed out of ${res.rows.length} expired subscriptions`);
        }
    } catch (err) {
        console.error('Scheduler: cleanupExpiredUsers error:', err.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Job B — Send expiry alerts every hour
//
// Alert thresholds (only fires once per subscription via alert_sent flag):
//   Monthly plans (≥30 days) → alert at 2 days remaining
//   Weekly plans  (7 days)   → alert at 1 day remaining
//   3-day plans              → alert at 1 day remaining
//   1-day plans              → no alert
// ─────────────────────────────────────────────────────────────────────────────
async function sendExpiryAlerts(db, getSock) {
    try {
        const res = await db.query(`
            SELECT s.id, s.expiry_time, s.alert_sent,
                   pl.duration_days, pl.name AS plan_name,
                   u.phone, ws.remote_jid
            FROM subscriptions s
            JOIN users u   ON u.id  = s.user_id
            JOIN plans pl  ON pl.id = s.plan_id
            LEFT JOIN whatsapp_sessions ws ON ws.phone = u.phone
            WHERE s.status = 'active'
              AND s.expiry_time > NOW()
              AND s.alert_sent = false
              AND ws.remote_jid IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM subscriptions sq
                  WHERE sq.user_id = s.user_id
                  AND sq.status = 'queued'
              )
        `);

        const sock = getSock();
        if (!sock) return; // WhatsApp not connected yet

        for (const sub of res.rows) {
            const hoursLeft = (new Date(sub.expiry_time) - new Date()) / (1000 * 60 * 60);
            const daysLeft  = hoursLeft / 24;

            let message = null;

            if (sub.duration_days >= 30 && daysLeft <= 2 && daysLeft > 0) {
                // Monthly plan — 2 days left
                message =
                    `⚠️ *Subscription Expiry Alert*\n\n` +
                    `Your *${sub.plan_name}* plan expires on *${fmt(sub.expiry_time)}* ` +
                    `(~${Math.ceil(daysLeft)} day${Math.ceil(daysLeft) !== 1 ? 's' : ''} left).\n\n` +
                    `🎁 *Renew before it expires and get 3 FREE days added!*\n\n` +
                    `Reply *1* to renew now or *HI* for the main menu.`;

            } else if (sub.duration_days >= 7 && sub.duration_days < 30 && daysLeft <= 1 && daysLeft > 0) {
                // Weekly plan — 1 day left
                message =
                    `⚠️ *Subscription Expiry Alert*\n\n` +
                    `Your *${sub.plan_name}* plan expires *tomorrow* (${fmt(sub.expiry_time)}).\n\n` +
                    `🎁 *Renew before it expires and get 1 FREE day added!*\n\n` +
                    `Reply *1* to renew now or *HI* for the main menu.`;

            }
            // duration_days === 1: no alert

            if (message) {
                try {
                    await sock.sendMessage(sub.remote_jid, { text: message });
                    await db.query(`UPDATE subscriptions SET alert_sent = true WHERE id = $1`, [sub.id]);
                    console.log(`📨 Expiry alert sent to ${sub.phone}`);
                } catch (err) {
                    console.error(`Scheduler: failed to send alert to ${sub.phone}:`, err.message);
                }
            }
        }
    } catch (err) {
        console.error('Scheduler: sendExpiryAlerts error:', err.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Job C — Activate queued subscriptions (Runs every minute)
// ─────────────────────────────────────────────────────────────────────────────
async function activateQueuedUsers(db, getSock) {
    try {
        const res = await db.query(`
            SELECT s.id AS sub_id, s.expiry_time, u.hotspot_username, u.hotspot_password, u.phone,
                   p.mikrotik_profile, p.duration_days, p.name AS plan_name, ws.remote_jid
            FROM subscriptions s
            JOIN users u ON u.id = s.user_id
            JOIN plans p ON p.id = s.plan_id
            LEFT JOIN whatsapp_sessions ws ON ws.phone = u.phone
            WHERE s.status = 'queued'
              AND s.start_time <= NOW()
        `);

        if (res.rows.length === 0) return;

        const sock = getSock();
        
        for (const row of res.rows) {
            if (!row.hotspot_username || !row.hotspot_password) continue;
            
            try {
                // Provision new profile on MikroTik
                const comment = buildMikrotikComment(row.phone, row.duration_days, row.expiry_time);
                await provisionHotspotUser(row.hotspot_username, row.mikrotik_profile, row.hotspot_password, comment);
                
                // Mark active in DB
                await db.query(`UPDATE subscriptions SET status = 'active' WHERE id = $1`, [row.sub_id]);
                console.log(`✅ Scheduler: Activated queued plan for '${row.hotspot_username}'`);

                // Notify user on WhatsApp
                if (sock && row.remote_jid) {
                    await sock.sendMessage(row.remote_jid, {
                        text: `🎉 *Your Queued Plan is Active!*\n\n` +
                              `Your old plan has expired and your new *${row.plan_name}* plan is now running.\n` +
                              `Your MikroTik profile has been updated automatically! 🛰️`
                    });
                }
            } catch (err) {
                console.error(`❌ Scheduler: Failed to activate queued plan for '${row.hotspot_username}':`, err.message);
                // Leave it as 'queued', it will retry on the next minute tick
            }
        }
    } catch (err) {
        console.error('Scheduler: activateQueuedUsers error:', err.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Start all scheduled jobs
// getSock() should return the current live Baileys socket (updated on reconnect)
// ─────────────────────────────────────────────────────────────────────────────
export function startScheduler(db, getSock) {
    console.log('⏰ Scheduler started');

    // Job A: cleanup every 30 minutes
    setInterval(() => cleanupExpiredUsers(db), 30 * 60 * 1000);

    // Job B: expiry alerts every 1 hour
    setInterval(() => sendExpiryAlerts(db, getSock), 60 * 60 * 1000);

    // Job C: activate queued plans every 1 minute
    setInterval(() => activateQueuedUsers(db, getSock), 60 * 1000);

    // Run immediately on startup too
    cleanupExpiredUsers(db);
    sendExpiryAlerts(db, getSock);
    activateQueuedUsers(db, getSock);
}
