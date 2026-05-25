import { provisionHotspotUser, buildMikrotikComment } from './mikrotik.js';

// Retry backoff schedule (minutes per attempt index)
const BACKOFF_MINUTES = [2, 5, 10, 15, 30, 60, 60, 60, 60, 60];

/**
 * Adds a failed provisioning job to the retry queue.
 * The scheduler will keep retrying until max_attempts is reached.
 */
export async function enqueueProvisioning(db, { userId, remoteJid, phone, mikrotikProfile, planName, pin }) {
    await db.query(`
        INSERT INTO provisioning_queue
            (user_id, remote_jid, phone, mikrotik_profile, plan_name, pin, next_retry_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '2 minutes')
    `, [userId, remoteJid, phone, mikrotikProfile, planName, pin]);

    console.log(`📋 Provisioning queued for ${phone} — will retry in 2 minutes`);
}

/**
 * Processes all due pending provisioning jobs.
 * Called by the scheduler in index.js every minute.
 */
export async function processPendingQueue(db, sock) {
    const due = await db.query(`
        SELECT * FROM provisioning_queue
        WHERE status = 'pending' AND next_retry_at <= NOW()
        ORDER BY next_retry_at ASC
        LIMIT 10
    `);

    if (!due.rows.length) return;

    console.log(`🔄 Processing ${due.rows.length} queued provisioning job(s)...`);

    for (const job of due.rows) {
        await processJob(db, sock, job);
    }
}

async function processJob(db, sock, job) {
    const attempt = job.attempts + 1;
    console.log(`🔄 Provisioning attempt ${attempt}/${job.max_attempts} for ${job.phone}`);

    // Mark attempt in progress
    await db.query(`
        UPDATE provisioning_queue
        SET attempts = $1, last_attempted_at = NOW()
        WHERE id = $2
    `, [attempt, job.id]);

    try {
        // Look up active subscription for comment field
        const subRes = await db.query(`
            SELECT s.expiry_time, pl.duration_days
            FROM subscriptions s
            JOIN plans pl ON pl.id = s.plan_id
            WHERE s.user_id = $1 AND s.status = 'active'
            ORDER BY s.id DESC LIMIT 1
        `, [job.user_id]);
        const sub     = subRes.rows[0];
        const comment = sub ? buildMikrotikComment(job.phone, sub.duration_days, sub.expiry_time) : null;

        await provisionHotspotUser(job.phone, job.mikrotik_profile, job.pin, comment);

        // ✅ Success — mark complete and notify user
        await db.query(`
            UPDATE provisioning_queue SET status = 'completed' WHERE id = $1
        `, [job.id]);

        console.log(`✅ Provisioning succeeded for ${job.phone} on attempt ${attempt}`);

        await sock.sendMessage(job.remote_jid, {
            text:
                `🎉 *Your Chulo ISP account is ready!*\n\n` +
                `📡 Plan: *${job.plan_name}*\n\n` +
                `🌐 *Login Details*\n` +
                `Username: \`${job.phone}\`\n` +
                `Password: \`${job.pin}\`\n\n` +
                `Connect at: *http://10.5.50.1*\n\n` +
                `Welcome to Chulo ISP! 🛰️`,
        });

    } catch (err) {
        console.error(`❌ Provisioning attempt ${attempt} failed for ${job.phone}:`, err.message);

        if (attempt >= job.max_attempts) {
            // Exhausted all retries — mark abandoned, notify user to contact support
            await db.query(`
                UPDATE provisioning_queue SET status = 'abandoned' WHERE id = $1
            `, [job.id]);

            console.error(`🚫 Provisioning permanently failed for ${job.phone} after ${attempt} attempts`);

            await sock.sendMessage(job.remote_jid, {
                text:
                    `⚠️ *Account Setup Delayed*\n\n` +
                    `We've been unable to automatically set up your hotspot login after multiple attempts.\n\n` +
                    `Your payment is confirmed and your subscription is active.\n\n` +
                    `Please contact our support team and we'll set up your credentials manually:\n` +
                    `Reply *6* from the main menu or send *HI* to get started.\n\n` +
                    `We apologize for the inconvenience! 🙏`,
            });
        } else {
            // Schedule next retry with backoff
            const backoffMins = BACKOFF_MINUTES[attempt] ?? 60;
            await db.query(`
                UPDATE provisioning_queue
                SET next_retry_at = NOW() + ($1 || ' minutes')::INTERVAL
                WHERE id = $2
            `, [backoffMins, job.id]);

            console.log(`⏳ Next retry for ${job.phone} in ${backoffMins} minutes (attempt ${attempt}/${job.max_attempts})`);
        }
    }
}
