/**
 * Admin command handler.
 * Triggered only when the message comes from the configured ADMIN_PHONE.
 *
 * Commands (all prefixed with !):
 *   !help          — show all admin commands
 *   !stats         — overview: users, active subs, total revenue
 *   !users [page]  — paginated user list (5 per page)
 *   !payments [p]  — paginated payments (5 per page)
 *   !user <phone>  — look up a specific user's details & subscription
 *   !broadcast <msg> — send a message to all active subscribers
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
                `💳 !payments [page]\n` +
                `   Paginated payment history\n\n` +
                `🔍 !user <phone>\n` +
                `   Look up a specific user\n\n` +
                `📢 !broadcast <message>\n` +
                `   Send message to all active subscribers`,
        });
        return true;
    }

    // ── Stats overview ─────────────────────────────────────────────────────
    if (cmd === '!stats') {
        const [users, activeSubs, revenue, pending] = await Promise.all([
            db.query(`SELECT COUNT(*) FROM users`),
            db.query(`SELECT COUNT(*) FROM subscriptions WHERE status = 'active' AND expiry_time > NOW()`),
            db.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE status = 'completed'`),
            db.query(`SELECT COUNT(*) FROM provisioning_queue WHERE status = 'pending'`),
        ]);

        await sock.sendMessage(from, {
            text:
                `📊 *Chulo Speednet Stats*\n\n` +
                `👥 Total Users: *${users.rows[0].count}*\n` +
                `✅ Active Subscriptions: *${activeSubs.rows[0].count}*\n` +
                `💰 Total Revenue: *₦${Number(revenue.rows[0].total).toLocaleString()}*\n` +
                `⏳ Pending Provisions: *${pending.rows[0].count}*`,
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

    // ── Payments list (paginated) ──────────────────────────────────────────
    if (cmd === '!payments') {
        const page   = Math.max(1, parseInt(parts[1] || '1', 10));
        const offset = (page - 1) * PAGE_SIZE;

        const res = await db.query(`
            SELECT p.amount, p.status, p.paid_at, p.created_at,
                   u.phone, u.name, pl.name AS plan_name
            FROM payments p
            JOIN users u ON u.id = p.user_id
            LEFT JOIN plans pl ON pl.id = (
                SELECT ws.plan_id FROM whatsapp_sessions ws WHERE ws.phone = u.phone
            )
            ORDER BY p.created_at DESC
            LIMIT $1 OFFSET $2
        `, [PAGE_SIZE, offset]);

        const total = await db.query(`SELECT COUNT(*) FROM payments`);
        const totalPages = Math.ceil(Number(total.rows[0].count) / PAGE_SIZE);

        if (!res.rows.length) {
            await sock.sendMessage(from, { text: `No payments found on page ${page}.` });
            return true;
        }

        const lines = res.rows.map(p => {
            const icon = p.status === 'completed' ? '✅' : p.status === 'pending' ? '⏳' : '❌';
            return (
                `${icon} *₦${Number(p.amount).toLocaleString()}* — ${p.status}\n` +
                `   👤 ${p.name || p.phone}\n` +
                `   📅 ${fmt(p.paid_at || p.created_at)}`
            );
        }).join('\n\n');

        await sock.sendMessage(from, {
            text:
                `💳 *Payments — Page ${page}/${totalPages}*\n\n` +
                `${lines}\n\n` +
                `${page < totalPages ? `Type *!payments ${page + 1}* for next page.` : 'Last page.'}`,
        });
        return true;
    }

    // ── Look up specific user ──────────────────────────────────────────────
    if (cmd === '!user') {
        const lookupPhone = parts[1]?.replace(/^\+/, '');
        if (!lookupPhone) {
            await sock.sendMessage(from, { text: `Usage: *!user <phone>*  e.g. !user 2348012345678` });
            return true;
        }

        const res = await db.query(`
            SELECT u.*,
                   s.status AS sub_status, s.start_time, s.expiry_time,
                   pl.name AS plan_name, pl.price AS plan_price
            FROM users u
            LEFT JOIN subscriptions s ON s.user_id = u.id
                AND s.status = 'active' AND s.expiry_time > NOW()
            LEFT JOIN plans pl ON pl.id = s.plan_id
            WHERE u.phone = $1
            LIMIT 1
        `, [lookupPhone]);

        if (!res.rows.length) {
            await sock.sendMessage(from, { text: `❌ No user found with phone *${lookupPhone}*.` });
            return true;
        }

        const u = res.rows[0];
        const hasSub = u.sub_status === 'active';

        await sock.sendMessage(from, {
            text:
                `🔍 *User Details*\n\n` +
                `👤 Name: *${u.name || 'Unknown'}*\n` +
                `📞 Phone: *${u.phone}*\n` +
                `🌐 Username: *${u.hotspot_username || 'Not set'}*\n` +
                `🔐 Password: *${u.hotspot_password || 'Not set'}*\n` +
                `📊 Status: *${u.status}*\n\n` +
                (hasSub
                    ? `✅ *Active Plan:* ${u.plan_name}\n` +
                      `   Started: ${fmt(u.start_time)}\n` +
                      `   Expires: ${fmt(u.expiry_time)}`
                    : `🔴 No active subscription`),
        });
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
