/**
 * Admin command handler.
 * Triggered only when the message comes from the configured ADMIN_PHONE.
 *
 * Commands (all prefixed with !):
 *   !help                        — show all admin commands
 *   !stats                       — overview: users, active subs, revenue
 *   !users [page]                — paginated user list (5 per page)
 *   !user <username>             — look up a user by hotspot username
 *   !payments [page|username]    — paginated payments (all or by user)
 *   !subscriptions [page|username] — paginated subscriptions (all or by user)
 *   !broadcast <msg>             — send a message to all active subscribers
 */

const PAGE_SIZE = 5;

function fmt(date) {
    return new Date(date).toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
    });
}

export async function handleAdminMessage(sock, from, text, db) {
    const raw   = text.trim();
    const parts = raw.split(/\s+/);
    const cmd   = parts[0].toLowerCase();

    // ── Admin help menu ────────────────────────────────────────────────────
    if (cmd === '!help' || cmd === '!admin') {
        await sock.sendMessage(from, {
            text:
                `🛠️ *Admin Panel — Chulo Speednet*\n\n` +
                `*Available Commands:*\n\n` +
                `📊 !stats\n` +
                `   Overview: users, subs, revenue\n\n` +
                `👥 !users [page]\n` +
                `   Paginated user list (${PAGE_SIZE} per page)\n\n` +
                `🔍 !user <username>\n` +
                `   Look up a user by hotspot username\n\n` +
                `💳 !payments [page | username]\n` +
                `   All payments (paginated) or payments for a specific user\n\n` +
                `📋 !subscriptions [page | username]\n` +
                `   All subscriptions (paginated) or subs for a specific user\n\n` +
                `📢 !broadcast <message>\n` +
                `   Send message to all active subscribers`,
        });
        return true;
    }

    // ── Stats overview ─────────────────────────────────────────────────────
    if (cmd === '!stats') {
        const [totalUsersRes, activeSubsRes, queuedSubsRes, revenueRes, pendingProvRes] = await Promise.all([
            db.query(`SELECT COUNT(*) FROM users`),
            db.query(`SELECT COUNT(*) FROM subscriptions WHERE status = 'active' AND expiry_time > NOW()`),
            db.query(`SELECT COUNT(*) FROM subscriptions WHERE status = 'queued'`),
            db.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE status = 'completed'`),
            db.query(`SELECT COUNT(*) FROM provisioning_queue WHERE status = 'pending'`),
        ]);

        await sock.sendMessage(from, {
            text:
                `📊 *Chulo Speednet Stats*\n\n` +
                `👥 Total Users: *${totalUsersRes.rows[0].count}*\n` +
                `✅ Active Subscribers: *${activeSubsRes.rows[0].count}*\n` +
                `⏳ Pending Subscriptions: *${queuedSubsRes.rows[0].count}*\n` +
                `💰 Total Revenue: *₦${Number(revenueRes.rows[0].total).toLocaleString()}*\n` +
                `⚙️ Pending Provisions: *${pendingProvRes.rows[0].count}*`,
        });
        return true;
    }


    // ── Users list (paginated) ─────────────────────────────────────────────
    if (cmd === '!users') {
        const page   = Math.max(1, parseInt(parts[1] || '1', 10));
        const offset = (page - 1) * PAGE_SIZE;

        const res = await db.query(`
            SELECT u.phone, u.name, u.hotspot_username,
                   s.status AS sub_status, s.expiry_time,
                   pl.name AS plan_name
            FROM users u
            LEFT JOIN subscriptions s ON s.user_id = u.id
                AND s.status = 'active' AND s.expiry_time > NOW()
            LEFT JOIN plans pl ON pl.id = s.plan_id
            ORDER BY u.created_at DESC
            LIMIT $1 OFFSET $2
        `, [PAGE_SIZE, offset]);

        const total = await db.query(`SELECT COUNT(*) FROM users`);
        const totalPages = Math.ceil(Number(total.rows[0].count) / PAGE_SIZE);

        if (!res.rows.length) {
            await sock.sendMessage(from, { text: `No users found on page ${page}.` });
            return true;
        }

        const lines = res.rows.map((u, i) => {
            const icon = u.sub_status === 'active' ? '🟢' : '🔴';
            const sub  = u.sub_status === 'active'
                ? `${u.plan_name} (exp: ${fmt(u.expiry_time)})`
                : 'No active plan';
            return (
                `${icon} *${u.name || 'Unknown'}*\n` +
                `   📞 ${u.phone}\n` +
                `   👤 ${u.hotspot_username || 'No username'}\n` +
                `   📡 ${sub}`
            );
        }).join('\n\n');

        await sock.sendMessage(from, {
            text:
                `👥 *Users — Page ${page}/${totalPages}*\n\n` +
                `${lines}\n\n` +
                `${page < totalPages ? `Type *!users ${page + 1}* for next page.` : 'Last page.'}`,
        });
        return true;
    }

    // ── Payments list (paginated, optional user filter) ────────────────────
    if (cmd === '!payments') {
        const arg1  = parts[1] || null;
        // If arg1 is a pure number → global page. If string → username filter.
        const isUsername = arg1 && /[a-zA-Z]/.test(arg1);
        const username   = isUsername ? arg1 : null;
        const page       = Math.max(1, parseInt(isUsername ? (parts[2] || '1') : (arg1 || '1'), 10));
        const offset     = (page - 1) * PAGE_SIZE;

        let res, totalRes;
        if (username) {
            // Look up user by hotspot username first
            const userRes = await db.query(
                `SELECT id, name FROM users WHERE LOWER(hotspot_username) = LOWER($1)`,
                [username]
            );
            if (!userRes.rows.length) {
                await sock.sendMessage(from, { text: `❌ No user found with username *${username}*.` });
                return true;
            }
            const targetId = userRes.rows[0].id;
            const targetName = userRes.rows[0].name || username;

            [res, totalRes] = await Promise.all([
                db.query(`
                    SELECT p.amount, p.status, p.paid_at, p.created_at, pl.name AS plan_name
                    FROM payments p
                    LEFT JOIN subscriptions s ON s.user_id = p.user_id
                        AND s.created_at >= p.created_at
                    LEFT JOIN plans pl ON pl.id = s.plan_id
                    WHERE p.user_id = $1
                    ORDER BY p.created_at DESC
                    LIMIT $2 OFFSET $3
                `, [targetId, PAGE_SIZE, offset]),
                db.query(`SELECT COUNT(*) FROM payments WHERE user_id = $1`, [targetId]),
            ]);

            const totalPages = Math.ceil(Number(totalRes.rows[0].count) / PAGE_SIZE);
            if (!res.rows.length) {
                await sock.sendMessage(from, { text: `No payments found for *${username}* on page ${page}.` });
                return true;
            }
            const lines = res.rows.map(p => {
                const icon = p.status === 'completed' ? '✅' : p.status === 'pending' ? '⏳' : '❌';
                return (
                    `${icon} *₦${Number(p.amount).toLocaleString()}* — ${p.status}\n` +
                    `   📡 ${p.plan_name || 'Unknown plan'}\n` +
                    `   📅 ${fmt(p.paid_at || p.created_at)}`
                );
            }).join('\n\n');

            await sock.sendMessage(from, {
                text:
                    `💳 *Payments for ${targetName} (${username})* — Page ${page}/${totalPages}\n\n` +
                    `${lines}\n\n` +
                    `${page < totalPages ? `Type *!payments ${username} ${page + 1}* for next page.` : 'Last page.'}`,
            });
        } else {
            // Global paginated list
            [res, totalRes] = await Promise.all([
                db.query(`
                    SELECT p.amount, p.status, p.paid_at, p.created_at,
                           u.name, u.hotspot_username
                    FROM payments p
                    JOIN users u ON u.id = p.user_id
                    ORDER BY p.created_at DESC
                    LIMIT $1 OFFSET $2
                `, [PAGE_SIZE, offset]),
                db.query(`SELECT COUNT(*) FROM payments`),
            ]);

            const totalPages = Math.ceil(Number(totalRes.rows[0].count) / PAGE_SIZE);
            if (!res.rows.length) {
                await sock.sendMessage(from, { text: `No payments found on page ${page}.` });
                return true;
            }
            const lines = res.rows.map(p => {
                const icon = p.status === 'completed' ? '✅' : p.status === 'pending' ? '⏳' : '❌';
                return (
                    `${icon} *₦${Number(p.amount).toLocaleString()}* — ${p.status}\n` +
                    `   👤 ${p.name || p.hotspot_username || 'Unknown'}\n` +
                    `   📅 ${fmt(p.paid_at || p.created_at)}`
                );
            }).join('\n\n');

            await sock.sendMessage(from, {
                text:
                    `💳 *Payments — Page ${page}/${totalPages}*\n\n` +
                    `${lines}\n\n` +
                    `${page < totalPages ? `Type *!payments ${page + 1}* for next page.` : 'Last page.'}`,
            });
        }
        return true;
    }

    // ── Look up specific user by hotspot username ──────────────────────────
    if (cmd === '!user') {
        const lookupUsername = parts[1];
        if (!lookupUsername) {
            await sock.sendMessage(from, { text: `Usage: *!user <username>*  e.g. !user john2024` });
            return true;
        }

        // Fetch user by hotspot username
        const userRes = await db.query(
            `SELECT * FROM users WHERE LOWER(hotspot_username) = LOWER($1)`,
            [lookupUsername]
        );
        if (!userRes.rows.length) {
            await sock.sendMessage(from, { text: `❌ No user found with username *${lookupUsername}*.` });
            return true;
        }
        const u = userRes.rows[0];

        // Fetch active sub, most recent queued sub, and last payment in parallel
        const [activeRes, queuedRes, lastPayRes] = await Promise.all([
            db.query(`
                SELECT s.start_time, s.expiry_time, p.name AS plan_name
                FROM subscriptions s JOIN plans p ON p.id = s.plan_id
                WHERE s.user_id = $1 AND s.status = 'active' AND s.expiry_time > NOW()
                ORDER BY s.expiry_time DESC LIMIT 1
            `, [u.id]),
            db.query(`
                SELECT s.start_time, p.name AS plan_name
                FROM subscriptions s JOIN plans p ON p.id = s.plan_id
                WHERE s.user_id = $1 AND s.status = 'queued'
                ORDER BY s.start_time ASC LIMIT 1
            `, [u.id]),
            db.query(`
                SELECT amount, status, paid_at, created_at
                FROM payments WHERE user_id = $1
                ORDER BY created_at DESC LIMIT 1
            `, [u.id]),
        ]);

        const activeSub  = activeRes.rows[0];
        const queuedSub  = queuedRes.rows[0];
        const lastPayment = lastPayRes.rows[0];

        const activeBlock = activeSub
            ? `✅ *Active Plan:* ${activeSub.plan_name}\n` +
              `   Started: ${fmt(activeSub.start_time)}\n` +
              `   Expires: ${fmt(activeSub.expiry_time)}`
            : `🔴 No active subscription`;

        const queuedBlock = queuedSub
            ? `\n\n⏳ *Queued Plan:* ${queuedSub.plan_name}\n` +
              `   Activates: ${fmt(queuedSub.start_time)}`
            : '';

        const payBlock = lastPayment
            ? `\n\n💳 *Last Payment:* ₦${Number(lastPayment.amount).toLocaleString()} · ${fmt(lastPayment.paid_at || lastPayment.created_at)} (${lastPayment.status})`
            : '';

        await sock.sendMessage(from, {
            text:
                `🔍 *User Details*\n\n` +
                `👤 Name: *${u.name || 'Unknown'}*\n` +
                `📞 Phone: *${u.phone}*\n` +
                `🌐 Username: *${u.hotspot_username || 'Not set'}*\n` +
                `🔐 Password: *${u.hotspot_password || 'Not set'}*\n` +
                `📊 Status: *${u.status}*\n\n` +
                `${activeBlock}` +
                `${queuedBlock}` +
                `${payBlock}`,
        });
        return true;
    }

    // ── Subscriptions list (paginated, optional user filter) ───────────────
    if (cmd === '!subscriptions') {
        const arg1  = parts[1] || null;
        const isUsername = arg1 && /[a-zA-Z]/.test(arg1);
        const username   = isUsername ? arg1 : null;
        const page       = Math.max(1, parseInt(isUsername ? (parts[2] || '1') : (arg1 || '1'), 10));
        const offset     = (page - 1) * PAGE_SIZE;

        const statusIcon = s =>
            s === 'active' ? '🟢' : s === 'queued' ? '⏳' : s === 'expired' ? '🔴' : '⚫';

        let res, totalRes;
        if (username) {
            const userRes = await db.query(
                `SELECT id, name FROM users WHERE LOWER(hotspot_username) = LOWER($1)`,
                [username]
            );
            if (!userRes.rows.length) {
                await sock.sendMessage(from, { text: `❌ No user found with username *${username}*.` });
                return true;
            }
            const targetId   = userRes.rows[0].id;
            const targetName = userRes.rows[0].name || username;

            [res, totalRes] = await Promise.all([
                db.query(`
                    SELECT s.status, s.start_time, s.expiry_time, p.name AS plan_name
                    FROM subscriptions s JOIN plans p ON p.id = s.plan_id
                    WHERE s.user_id = $1
                    ORDER BY s.created_at DESC
                    LIMIT $2 OFFSET $3
                `, [targetId, PAGE_SIZE, offset]),
                db.query(`SELECT COUNT(*) FROM subscriptions WHERE user_id = $1`, [targetId]),
            ]);

            const totalPages = Math.ceil(Number(totalRes.rows[0].count) / PAGE_SIZE);
            if (!res.rows.length) {
                await sock.sendMessage(from, { text: `No subscriptions found for *${username}* on page ${page}.` });
                return true;
            }
            const lines = res.rows.map(s =>
                `${statusIcon(s.status)} *${s.plan_name}* (${s.status})\n` +
                `   📅 ${fmt(s.start_time)} → ${fmt(s.expiry_time)}`
            ).join('\n\n');

            await sock.sendMessage(from, {
                text:
                    `📋 *Subscriptions for ${targetName} (${username})* — Page ${page}/${totalPages}\n\n` +
                    `${lines}\n\n` +
                    `${page < totalPages ? `Type *!subscriptions ${username} ${page + 1}* for next page.` : 'Last page.'}`,
            });
        } else {
            [res, totalRes] = await Promise.all([
                db.query(`
                    SELECT s.status, s.start_time, s.expiry_time,
                           p.name AS plan_name, u.hotspot_username, u.name AS user_name
                    FROM subscriptions s
                    JOIN plans p ON p.id = s.plan_id
                    JOIN users u ON u.id = s.user_id
                    ORDER BY s.created_at DESC
                    LIMIT $1 OFFSET $2
                `, [PAGE_SIZE, offset]),
                db.query(`SELECT COUNT(*) FROM subscriptions`),
            ]);

            const totalPages = Math.ceil(Number(totalRes.rows[0].count) / PAGE_SIZE);
            if (!res.rows.length) {
                await sock.sendMessage(from, { text: `No subscriptions found on page ${page}.` });
                return true;
            }
            const lines = res.rows.map(s =>
                `${statusIcon(s.status)} *${s.plan_name}* (${s.status})\n` +
                `   👤 ${s.hotspot_username || s.user_name || 'Unknown'}\n` +
                `   📅 ${fmt(s.start_time)} → ${fmt(s.expiry_time)}`
            ).join('\n\n');

            await sock.sendMessage(from, {
                text:
                    `📋 *Subscriptions — Page ${page}/${totalPages}*\n\n` +
                    `${lines}\n\n` +
                    `${page < totalPages ? `Type *!subscriptions ${page + 1}* for next page.` : 'Last page.'}`,
            });
        }
        return true;
    }

    // ── Broadcast to all active subscribers ───────────────────────────────
    if (cmd === '!broadcast') {
        const broadcastMsg = parts.slice(1).join(' ');
        if (!broadcastMsg) {
            await sock.sendMessage(from, { text: `Usage: *!broadcast <message>*` });
            return true;
        }

        const subs = await db.query(`
            SELECT DISTINCT ws.remote_jid
            FROM whatsapp_sessions ws
            JOIN users u ON u.phone = ws.phone
            JOIN subscriptions s ON s.user_id = u.id
            WHERE s.status = 'active' AND s.expiry_time > NOW()
              AND ws.remote_jid IS NOT NULL
        `);

        if (!subs.rows.length) {
            await sock.sendMessage(from, { text: `No active subscribers with known JIDs.` });
            return true;
        }

        let sent = 0, failed = 0;
        for (const row of subs.rows) {
            try {
                await sock.sendMessage(row.remote_jid, {
                    text: `📢 *Chulo Speednet*\n\n${broadcastMsg}`,
                });
                sent++;
                // Small delay to avoid rate limits
                await new Promise(r => setTimeout(r, 500));
            } catch {
                failed++;
            }
        }

        await sock.sendMessage(from, {
            text: `📢 Broadcast complete.\n✅ Sent: ${sent}\n❌ Failed: ${failed}`,
        });
        return true;
    }

    // Not an admin command (starts with ! but unrecognised)
    if (cmd.startsWith('!')) {
        await sock.sendMessage(from, {
            text: `Unknown command. Type *!help* to see all admin commands.`,
        });
        return true;
    }

    // Not an admin command — let normal flow handle it
    return false;
}
