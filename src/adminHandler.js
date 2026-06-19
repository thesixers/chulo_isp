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

import { provisionOrQueue } from "./fulfillPayment.js";
import { isValidPassword, isValidUsername, sanitizeUsername } from "./handleMessage.js";

const adminSessions = new Map();
const PAGE_SIZE = 5;

function fmt(date) {
  return new Date(date).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export async function handleAdminMessage(sock, from, text, db) {
  const raw = text.trim();
  const parts = raw.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  // ── Check for active admin session (e.g. multi-step !activate) ─────────
  const session = adminSessions.get(from);
  if (session && !cmd.startsWith("!")) {
    return handleAdminSession(sock, from, raw, db, session);
  }

  // ── Admin help menu ────────────────────────────────────────────────────
  if (cmd === "!help" || cmd === "!admin") {
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
        `⚡ !activate <username>\n` +
        `   Manually activate a plan for an existing user (cash payment)\n\n` +
        `🆕 !newuser <phone>\n` +
        `   Create & activate a plan for a brand-new customer\n\n` +
        `🗑️ !delsub <username>\n` +
        `   Delete a subscription for a user (active or queued)\n\n` +
        `📢 !broadcast <message>\n` +
        `   Send message to all active subscribers\n\n` +
        `➕ !addplan\n` +
        `   Add a new data plan`,
    });
    return true;
  }

  // ── Stats overview ─────────────────────────────────────────────────────
  if (cmd === "!stats") {
    const [
      totalUsersRes,
      activeSubsRes,
      queuedSubsRes,
      revenueRes,
      pendingProvRes,
    ] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM users`),
      db.query(
        `SELECT COUNT(DISTINCT user_id) FROM subscriptions WHERE status = 'active' AND expiry_time > NOW()`,
      ),
      db.query(`SELECT COUNT(*) FROM subscriptions WHERE status = 'queued'`),
      db.query(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE status = 'completed'`,
      ),
      db.query(
        `SELECT COUNT(*) FROM provisioning_queue WHERE status = 'pending'`,
      ),
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
  if (cmd === "!users") {
    const page = Math.max(1, parseInt(parts[1] || "1", 10));
    const offset = (page - 1) * PAGE_SIZE;

    const res = await db.query(
      `
            SELECT u.phone, u.name, u.hotspot_username,
                   s.status AS sub_status, s.expiry_time,
                   pl.name AS plan_name
            FROM users u
            LEFT JOIN LATERAL (
                SELECT sub.status, sub.expiry_time, sub.plan_id
                FROM subscriptions sub
                WHERE sub.user_id = u.id AND sub.status = 'active' AND sub.expiry_time > NOW()
                ORDER BY sub.expiry_time DESC
                LIMIT 1
            ) s ON true
            LEFT JOIN plans pl ON pl.id = s.plan_id
            ORDER BY u.created_at DESC
            LIMIT $1 OFFSET $2
        `,
      [PAGE_SIZE, offset],
    );

    const total = await db.query(`SELECT COUNT(*) FROM users`);
    const totalPages = Math.ceil(Number(total.rows[0].count) / PAGE_SIZE);

    if (!res.rows.length) {
      await sock.sendMessage(from, { text: `No users found on page ${page}.` });
      return true;
    }

    const lines = res.rows
      .map((u, i) => {
        const icon = u.sub_status === "active" ? "🟢" : "🔴";
        const sub =
          u.sub_status === "active"
            ? `${u.plan_name} (exp: ${fmt(u.expiry_time)})`
            : "No active plan";
        return (
          `${icon} *${u.name || "Unknown"}*\n` +
          `   📞 ${u.phone}\n` +
          `   👤 ${u.hotspot_username || "No username"}\n` +
          `   📡 ${sub}`
        );
      })
      .join("\n\n");

    await sock.sendMessage(from, {
      text:
        `👥 *Users — Page ${page}/${totalPages}*\n\n` +
        `${lines}\n\n` +
        `${page < totalPages ? `Type *!users ${page + 1}* for next page.` : "Last page."}`,
    });
    return true;
  }

  // ── Payments list (paginated, optional user filter) ────────────────────
  if (cmd === "!payments") {
    const arg1 = parts[1] || null;
    // If arg1 is a pure number → global page. If string → username filter.
    const isUsername = arg1 && /[a-zA-Z]/.test(arg1);
    const username = isUsername ? arg1 : null;
    const page = Math.max(
      1,
      parseInt(isUsername ? parts[2] || "1" : arg1 || "1", 10),
    );
    const offset = (page - 1) * PAGE_SIZE;

    let res, totalRes;
    if (username) {
      // Look up user by hotspot username first
      const userRes = await db.query(
        `SELECT id, name FROM users WHERE LOWER(hotspot_username) = LOWER($1)`,
        [username],
      );
      if (!userRes.rows.length) {
        await sock.sendMessage(from, {
          text: `❌ No user found with username *${username}*.`,
        });
        return true;
      }
      const targetId = userRes.rows[0].id;
      const targetName = userRes.rows[0].name || username;

      [res, totalRes] = await Promise.all([
        db.query(
          `
                    SELECT p.amount, p.status, p.paid_at, p.created_at,
                           (SELECT pl.name FROM subscriptions s
                            JOIN plans pl ON pl.id = s.plan_id
                            WHERE s.user_id = p.user_id
                            AND s.created_at >= p.created_at
                            ORDER BY s.created_at ASC LIMIT 1
                           ) AS plan_name
                    FROM payments p
                    WHERE p.user_id = $1
                    ORDER BY p.created_at DESC
                    LIMIT $2 OFFSET $3
                `,
          [targetId, PAGE_SIZE, offset],
        ),
        db.query(`SELECT COUNT(*) FROM payments WHERE user_id = $1`, [
          targetId,
        ]),
      ]);

      const totalPages = Math.ceil(Number(totalRes.rows[0].count) / PAGE_SIZE);
      if (!res.rows.length) {
        await sock.sendMessage(from, {
          text: `No payments found for *${username}* on page ${page}.`,
        });
        return true;
      }
      const lines = res.rows
        .map((p) => {
          const icon =
            p.status === "completed"
              ? "✅"
              : p.status === "pending"
                ? "⏳"
                : "❌";
          return (
            `${icon} *₦${Number(p.amount).toLocaleString()}* — ${p.status}\n` +
            `   📡 ${p.plan_name || "Unknown plan"}\n` +
            `   📅 ${fmt(p.paid_at || p.created_at)}`
          );
        })
        .join("\n\n");

      await sock.sendMessage(from, {
        text:
          `💳 *Payments for ${targetName} (${username})* — Page ${page}/${totalPages}\n\n` +
          `${lines}\n\n` +
          `${page < totalPages ? `Type *!payments ${username} ${page + 1}* for next page.` : "Last page."}`,
      });
    } else {
      // Global paginated list
      [res, totalRes] = await Promise.all([
        db.query(
          `
                    SELECT p.amount, p.status, p.paid_at, p.created_at,
                           u.name, u.hotspot_username
                    FROM payments p
                    JOIN users u ON u.id = p.user_id
                    ORDER BY p.created_at DESC
                    LIMIT $1 OFFSET $2
                `,
          [PAGE_SIZE, offset],
        ),
        db.query(`SELECT COUNT(*) FROM payments`),
      ]);

      const totalPages = Math.ceil(Number(totalRes.rows[0].count) / PAGE_SIZE);
      if (!res.rows.length) {
        await sock.sendMessage(from, {
          text: `No payments found on page ${page}.`,
        });
        return true;
      }
      const lines = res.rows
        .map((p) => {
          const icon =
            p.status === "completed"
              ? "✅"
              : p.status === "pending"
                ? "⏳"
                : "❌";
          return (
            `${icon} *₦${Number(p.amount).toLocaleString()}* — ${p.status}\n` +
            `   👤 ${p.name || p.hotspot_username || "Unknown"}\n` +
            `   📅 ${fmt(p.paid_at || p.created_at)}`
          );
        })
        .join("\n\n");

      await sock.sendMessage(from, {
        text:
          `💳 *Payments — Page ${page}/${totalPages}*\n\n` +
          `${lines}\n\n` +
          `${page < totalPages ? `Type *!payments ${page + 1}* for next page.` : "Last page."}`,
      });
    }
    return true;
  }

  // ── Look up specific user by hotspot username ──────────────────────────
  if (cmd === "!user") {
    const lookupUsername = parts[1];
    if (!lookupUsername) {
      await sock.sendMessage(from, {
        text: `Usage: *!user <username>*  e.g. !user john2024`,
      });
      return true;
    }

    // Fetch user by hotspot username
    const userRes = await db.query(
      `SELECT * FROM users WHERE LOWER(hotspot_username) = LOWER($1)`,
      [lookupUsername],
    );
    if (!userRes.rows.length) {
      await sock.sendMessage(from, {
        text: `❌ No user found with username *${lookupUsername}*.`,
      });
      return true;
    }
    const u = userRes.rows[0];

    // Fetch active sub, most recent queued sub, and last payment in parallel
    const [activeRes, queuedRes, lastPayRes] = await Promise.all([
      db.query(
        `
                SELECT s.start_time, s.expiry_time, p.name AS plan_name
                FROM subscriptions s JOIN plans p ON p.id = s.plan_id
                WHERE s.user_id = $1 AND s.status = 'active' AND s.expiry_time > NOW()
                ORDER BY s.expiry_time DESC LIMIT 1
            `,
        [u.id],
      ),
      db.query(
        `
                SELECT s.start_time, p.name AS plan_name
                FROM subscriptions s JOIN plans p ON p.id = s.plan_id
                WHERE s.user_id = $1 AND s.status = 'queued'
                ORDER BY s.start_time ASC LIMIT 1
            `,
        [u.id],
      ),
      db.query(
        `
                SELECT amount, status, paid_at, created_at
                FROM payments WHERE user_id = $1
                ORDER BY created_at DESC LIMIT 1
            `,
        [u.id],
      ),
    ]);

    const activeSub = activeRes.rows[0];
    const queuedSub = queuedRes.rows[0];
    const lastPayment = lastPayRes.rows[0];

    const activeBlock = activeSub
      ? `✅ *Active Plan:* ${activeSub.plan_name}\n` +
        `   Started: ${fmt(activeSub.start_time)}\n` +
        `   Expires: ${fmt(activeSub.expiry_time)}`
      : `🔴 No active subscription`;

    const queuedBlock = queuedSub
      ? `\n\n⏳ *Queued Plan:* ${queuedSub.plan_name}\n` +
        `   Activates: ${fmt(queuedSub.start_time)}`
      : "";

    const payBlock = lastPayment
      ? `\n\n💳 *Last Payment:* ₦${Number(lastPayment.amount).toLocaleString()} · ${fmt(lastPayment.paid_at || lastPayment.created_at)} (${lastPayment.status})`
      : "";

    await sock.sendMessage(from, {
      text:
        `🔍 *User Details*\n\n` +
        `👤 Name: *${u.name || "Unknown"}*\n` +
        `📞 Phone: *${u.phone}*\n` +
        `🌐 Username: *${u.hotspot_username || "Not set"}*\n` +
        `🔐 Password: *${u.hotspot_password || "Not set"}*\n` +
        `📊 Status: *${u.status}*\n\n` +
        `${activeBlock}` +
        `${queuedBlock}` +
        `${payBlock}`,
    });
    return true;
  }

  // ── Subscriptions list (paginated, optional user filter) ───────────────
  if (cmd === "!subscriptions") {
    const arg1 = parts[1] || null;
    const isUsername = arg1 && /[a-zA-Z]/.test(arg1);
    const username = isUsername ? arg1 : null;
    const page = Math.max(
      1,
      parseInt(isUsername ? parts[2] || "1" : arg1 || "1", 10),
    );
    const offset = (page - 1) * PAGE_SIZE;

    const statusIcon = (s) =>
      s === "active"
        ? "🟢"
        : s === "queued"
          ? "⏳"
          : s === "expired"
            ? "🔴"
            : "⚫";

    let res, totalRes;
    if (username) {
      const userRes = await db.query(
        `SELECT id, name FROM users WHERE LOWER(hotspot_username) = LOWER($1)`,
        [username],
      );
      if (!userRes.rows.length) {
        await sock.sendMessage(from, {
          text: `❌ No user found with username *${username}*.`,
        });
        return true;
      }
      const targetId = userRes.rows[0].id;
      const targetName = userRes.rows[0].name || username;

      [res, totalRes] = await Promise.all([
        db.query(
          `
                    SELECT s.status, s.start_time, s.expiry_time, p.name AS plan_name
                    FROM subscriptions s JOIN plans p ON p.id = s.plan_id
                    WHERE s.user_id = $1
                    ORDER BY s.created_at DESC
                    LIMIT $2 OFFSET $3
                `,
          [targetId, PAGE_SIZE, offset],
        ),
        db.query(`SELECT COUNT(*) FROM subscriptions WHERE user_id = $1`, [
          targetId,
        ]),
      ]);

      const totalPages = Math.ceil(Number(totalRes.rows[0].count) / PAGE_SIZE);
      if (!res.rows.length) {
        await sock.sendMessage(from, {
          text: `No subscriptions found for *${username}* on page ${page}.`,
        });
        return true;
      }
      const lines = res.rows
        .map(
          (s) =>
            `${statusIcon(s.status)} *${s.plan_name}* (${s.status})\n` +
            `   📅 ${fmt(s.start_time)} → ${fmt(s.expiry_time)}`,
        )
        .join("\n\n");

      await sock.sendMessage(from, {
        text:
          `📋 *Subscriptions for ${targetName} (${username})* — Page ${page}/${totalPages}\n\n` +
          `${lines}\n\n` +
          `${page < totalPages ? `Type *!subscriptions ${username} ${page + 1}* for next page.` : "Last page."}`,
      });
    } else {
      [res, totalRes] = await Promise.all([
        db.query(
          `
                    SELECT s.status, s.start_time, s.expiry_time,
                           p.name AS plan_name, u.hotspot_username, u.name AS user_name
                    FROM subscriptions s
                    JOIN plans p ON p.id = s.plan_id
                    JOIN users u ON u.id = s.user_id
                    ORDER BY s.created_at DESC
                    LIMIT $1 OFFSET $2
                `,
          [PAGE_SIZE, offset],
        ),
        db.query(`SELECT COUNT(*) FROM subscriptions`),
      ]);

      const totalPages = Math.ceil(Number(totalRes.rows[0].count) / PAGE_SIZE);
      if (!res.rows.length) {
        await sock.sendMessage(from, {
          text: `No subscriptions found on page ${page}.`,
        });
        return true;
      }
      const lines = res.rows
        .map(
          (s) =>
            `${statusIcon(s.status)} *${s.plan_name}* (${s.status})\n` +
            `   👤 ${s.hotspot_username || s.user_name || "Unknown"}\n` +
            `   📅 ${fmt(s.start_time)} → ${fmt(s.expiry_time)}`,
        )
        .join("\n\n");

      await sock.sendMessage(from, {
        text:
          `📋 *Subscriptions — Page ${page}/${totalPages}*\n\n` +
          `${lines}\n\n` +
          `${page < totalPages ? `Type *!subscriptions ${page + 1}* for next page.` : "Last page."}`,
      });
    }
    return true;
  }

  // ── Broadcast to all active subscribers ───────────────────────────────
  if (cmd === "!broadcast") {
    const broadcastMsg = parts.slice(1).join(" ");
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
      await sock.sendMessage(from, {
        text: `No active subscribers with known JIDs.`,
      });
      return true;
    }

    let sent = 0,
      failed = 0;
    for (const row of subs.rows) {
      try {
        await sock.sendMessage(row.remote_jid, {
          text: `📢 *Chulo Speednet*\n\n${broadcastMsg}`,
        });
        sent++;
        // Small delay to avoid rate limits
        await new Promise((r) => setTimeout(r, 500));
      } catch {
        failed++;
      }
    }

    await sock.sendMessage(from, {
      text: `📢 Broadcast complete.\n✅ Sent: ${sent}\n❌ Failed: ${failed}`,
    });
    return true;
  }

  // ── Admin activate (manual cash payment) ───────────────────────────────
  if (cmd === "!activate") {
    const targetUsername = parts[1];
    if (!targetUsername) {
      await sock.sendMessage(from, { text: `Usage: *!activate <username>*` });
      return true;
    }

    const targetRes = await db.query(
      `SELECT * FROM users WHERE LOWER(hotspot_username) = LOWER($1)`,
      [targetUsername],
    );

    if (!targetRes.rows.length) {
      await sock.sendMessage(from, {
        text: `❌ User *${targetUsername}* not found.`,
      });
      return true;
    }

    adminSessions.set(from, {
      step: "awaiting_device_selection",
      targetUser: targetRes.rows[0],
    });

    await sock.sendMessage(from, {
      text:
        `✅ Activating for *${targetRes.rows[0].hotspot_username}*\n\n` +
        `*Select Device Limit:*\n` +
        `1️⃣ Single Device\n` +
        `2️⃣ Two Devices\n` +
        `3️⃣ Three Devices\n\n` +
        `Reply with a number (1-3) or type !cancel.`,
    });
    return true;
  }

  // ── Delete a subscription ──────────────────────────────────────────────
  if (cmd === "!delsub") {
    const targetUsername = parts[1];
    if (!targetUsername) {
      await sock.sendMessage(from, {
        text: `Usage: *!delsub <username>*  e.g. !delsub emeka`,
      });
      return true;
    }

    const targetRes = await db.query(
      `SELECT * FROM users WHERE LOWER(hotspot_username) = LOWER($1)`,
      [targetUsername],
    );
    if (!targetRes.rows.length) {
      await sock.sendMessage(from, {
        text: `❌ No user found with username *${targetUsername}*.`,
      });
      return true;
    }
    const targetUser = targetRes.rows[0];

    // Fetch all active and queued subscriptions
    const subsRes = await db.query(
      `
            SELECT s.id, s.status, s.start_time, s.expiry_time, p.name AS plan_name
            FROM subscriptions s
            JOIN plans p ON p.id = s.plan_id
            WHERE s.user_id = $1 AND s.status IN ('active', 'queued')
            ORDER BY s.expiry_time ASC
        `,
      [targetUser.id],
    );

    if (!subsRes.rows.length) {
      await sock.sendMessage(from, {
        text: `ℹ️ *${targetUser.hotspot_username}* has no active or queued subscriptions.`,
      });
      return true;
    }

    const statusIcon = (s) => (s === "active" ? "🟢" : "⏳");
    const lines = subsRes.rows
      .map(
        (s, i) =>
          `${i + 1}. ${statusIcon(s.status)} *${s.plan_name}* (${s.status})\n` +
          `   📅 ${fmt(s.start_time)} → ${fmt(s.expiry_time)}`,
      )
      .join("\n\n");

    adminSessions.set(from, {
      step: "awaiting_sub_selection",
      targetUser,
      subs: subsRes.rows,
    });

    await sock.sendMessage(from, {
      text:
        `🗑️ *Delete Subscription for ${targetUser.hotspot_username}*\n\n` +
        `${lines}\n\n` +
        `Reply with the *number* of the plan to delete, or type *!cancel*.`,
    });
    return true;
  }

  // ── Create & activate a plan for a brand-new user ─────────────────────
  if (cmd === "!newuser") {
    const rawPhone = (parts[1] || "").replace(/\D/g, "");

    // Normalise first so we can validate final length
    let phoneCheck = rawPhone;
    if (phoneCheck.startsWith("0")) phoneCheck = "234" + phoneCheck.slice(1);
    if (!phoneCheck.startsWith("234")) phoneCheck = "234" + phoneCheck;

    // Nigerian numbers: country code 234 + 10 digits = 13 digits total
    if (!rawPhone || phoneCheck.length !== 13) {
      await sock.sendMessage(from, {
        text: `❌ Invalid phone number.\nUsage: *!newuser <phone>*\nExample: !newuser 08012345678 or !newuser 2348012345678`,
      });
      return true;
    }

    // Normalise: strip leading 0, prepend 234 if needed
    let phone = rawPhone;
    if (phone.startsWith("0")) phone = "234" + phone.slice(1);
    else if (!phone.startsWith("234")) phone = "234" + phone;

    // Three-way check on the phone number:
    //   1. Phone in DB with hotspot_username set  → fully onboarded → redirect to !activate
    //   2. Phone in DB but hotspot_username NULL   → messaged bot, never subscribed → reuse row
    //   3. Phone not in DB at all                  → full new user creation
    const existingRes = await db.query(`SELECT * FROM users WHERE phone = $1`, [
      phone,
    ]);

    if (existingRes.rows.length) {
      const u = existingRes.rows[0];
      if (u.hotspot_username) {
        // Case 1 — already fully set up
        await sock.sendMessage(from, {
          text:
            `ℹ️ *User already exists!*\n\n` +
            `👤 Name: *${u.name || "Unknown"}*\n` +
            `📞 Phone: *${u.phone}*\n` +
            `🌐 Username: *${u.hotspot_username}*\n\n` +
            `Use *!activate ${u.hotspot_username}* to give them a plan instead.`,
        });
        return true;
      }

      // Case 2 — partial user (in DB but never subscribed)
      // We'll reuse their existing row and just fill in the missing credentials.
      if (u.name) {
        // Name already known — skip straight to device selection
        adminSessions.set(from, {
          step: "newuser_device",
          phone,
          existingUserId: u.id,
          name: u.name,
        });
        await sock.sendMessage(from, {
          text:
            `🔄 *Resume Customer Setup*\n\n` +
            `📞 Phone: *+${phone}* (found in system — no plan yet)\n\n` +
            `*Select Device Limit for ${u.name}:*\n` +
            `1️⃣ Single Device\n` +
            `2️⃣ Two Devices\n` +
            `3️⃣ Three Devices\n\n` +
            `Reply with *1*, *2*, or *3*, or type *!cancel*.`,
        });
      } else {
        // Name unknown — ask for it first (same as new user flow)
        adminSessions.set(from, {
          step: "newuser_name",
          phone,
          existingUserId: u.id,
        });
        await sock.sendMessage(from, {
          text:
            `🔄 *Resume Customer Setup*\n\n` +
            `📞 Phone: *+${phone}* (found in system — no plan yet)\n\n` +
            `What is the customer's *name*?\n` +
            `(Reply with their name or type *!cancel*)`,
        });
      }
      return true;
    }

    // Case 3 — completely new user
    adminSessions.set(from, { step: "newuser_name", phone });
    await sock.sendMessage(from, {
      text:
        `🆕 *New Customer Setup*\n\n` +
        `📞 Phone: *+${phone}*\n\n` +
        `What is the customer's *name*?\n` +
        `(Reply with their name or type *!cancel*)`,
    });
    return true;
  }

  // ── Add a new plan ────────────────────────────────────────────────────
  if (cmd === "!addplan") {
    adminSessions.set(from, { step: "addplan_device" });
    await sock.sendMessage(from, {
      text:
        `➕ *Add New Plan*\n\n` +
        `*Select device limit:*\n` +
        `1️⃣ Single Device\n` +
        `2️⃣ Two Devices\n` +
        `3️⃣ Three Devices\n\n` +
        `Reply with *1*, *2*, or *3*, or type *!cancel*.`,
    });
    return true;
  }

  if (cmd === "!cancel") {
    if (adminSessions.has(from)) {
      adminSessions.delete(from);
      await sock.sendMessage(from, { text: `✅ Action cancelled.` });
    } else {
      await sock.sendMessage(from, { text: `No active action to cancel.` });
    }
    return true;
  }

  // Not an admin command (starts with ! but unrecognised)
  if (cmd.startsWith("!")) {
    await sock.sendMessage(from, {
      text: `Unknown command. Type *!help* to see all admin commands.`,
    });
    return true;
  }

  // Not an admin command — let normal flow handle it
  return false;
}

// ── Multi-step session handler for Admin commands ──────────────────────────
async function handleAdminSession(sock, from, text, db, session) {
  const { step, targetUser } = session;

  if (step === "awaiting_device_selection") {
    const profileMap = {
      1: { profile: "7/7_Mbps_1Users", label: "Single Device" },
      2: { profile: "7/7_Mbps_2Users", label: "Two Devices" },
      3: { profile: "7/7_Mbps_3Users", label: "Three Devices" },
    };
    const choice = profileMap[text];
    if (!choice) {
      await sock.sendMessage(from, {
        text: `Please reply with 1, 2, or 3. (Or type !cancel)`,
      });
      return true;
    }

    const res = await db.query(
      `SELECT * FROM plans WHERE mikrotik_profile = $1 ORDER BY duration_days DESC`,
      [choice.profile],
    );

    adminSessions.set(from, {
      ...session,
      step: "awaiting_plan_selection",
      plans: res.rows,
    });

    const lines = res.rows
      .map(
        (p, i) =>
          `${i + 1}️⃣ *${p.name}* — ₦${Number(p.price).toLocaleString()}`,
      )
      .join("\n");

    await sock.sendMessage(from, {
      text: `*Select Plan for ${choice.label}:*\n\n${lines}\n\nReply with a number (1-${res.rows.length}).`,
    });

    return true;
  }

  if (step === "awaiting_plan_selection") {
    const position = parseInt(text, 10);
    const { plans } = session;
    if (isNaN(position) || position < 1 || position > plans.length) {
      await sock.sendMessage(from, {
        text: `Please reply with a valid number from the list. (Or type !cancel)`,
      });
      return true;
    }

    const plan = plans[position - 1];
    adminSessions.delete(from); // Clear session early

    await sock.sendMessage(from, {
      text: `⏳ Activating *${plan.name}* for *${targetUser.hotspot_username}*...`,
    });

    try {
      // 1. Create a "cash" payment
      await db.query(
        `
                INSERT INTO payments (user_id, amount, status, provider, method, paid_at)
                VALUES ($1, $2, 'completed', 'admin_manual', 'cash', CURRENT_TIMESTAMP)
            `,
        [targetUser.id, plan.price],
      );

      // 2. Fetch active sub to determine if queueing is needed
      const activeSubRes = await db.query(
        `
                SELECT s.*, p.duration_days AS active_duration_days FROM subscriptions s
                JOIN plans p ON p.id = s.plan_id
                WHERE s.user_id = $1 AND s.status IN ('active', 'queued') AND s.expiry_time > CURRENT_TIMESTAMP
                ORDER BY s.expiry_time DESC LIMIT 1
            `,
        [targetUser.id],
      );

      const activeSub = activeSubRes.rows[0];
      const isRenewal = !!activeSub;
      const renewingEarly =
        isRenewal && new Date(activeSub.expiry_time) > new Date();

      function sameTierBonus(activeDays, newDays) {
        if (activeDays >= 28 && newDays >= 28) return 3;
        if (activeDays >= 7 && newDays >= 7 && activeDays < 28 && newDays < 28)
          return 1;
        return 0;
      }
      const bonusDays = renewingEarly
        ? sameTierBonus(activeSub.active_duration_days, plan.duration_days)
        : 0;

      let newExpiry = new Date();
      if (isRenewal) newExpiry = new Date(activeSub.expiry_time);
      newExpiry.setDate(newExpiry.getDate() + plan.duration_days + bonusDays);

      if (isRenewal) {
        await db.query(
          `
                    INSERT INTO subscriptions (user_id, plan_id, status, start_time, expiry_time, alert_sent)
                    VALUES ($1, $2, 'queued', $3, $4, false)
                `,
          [targetUser.id, plan.id, activeSub.expiry_time, newExpiry],
        );
      } else {
        await db.query(
          `
                    INSERT INTO subscriptions (user_id, plan_id, status, start_time, expiry_time, alert_sent)
                    VALUES ($1, $2, 'active', CURRENT_TIMESTAMP, $3, false)
                `,
          [targetUser.id, plan.id, newExpiry],
        );
      }

      // 3. Notify Admin
      await sock.sendMessage(from, {
        text:
          `✅ Successfully activated *${plan.name}* for *${targetUser.hotspot_username}*.\n` +
          (isRenewal
            ? `⏳ Plan was queued to start on ${new Date(activeSub.expiry_time).toDateString()}.`
            : `📡 Plan is now active.`),
      });

      // 4. Notify User
      const targetJidRes = await db.query(
        `SELECT remote_jid FROM whatsapp_sessions WHERE phone = $1`,
        [targetUser.phone],
      );
      const targetJid =
        targetJidRes.rows[0]?.remote_jid ||
        `${targetUser.phone}@s.whatsapp.net`;

      try {
        if (isRenewal) {
          await sock.sendMessage(targetJid, {
            text:
              `✅ *Your plan has been activated!* (by Admin)\n\n` +
              `📡 Plan: *${plan.name}*\n` +
              `⏳ *Queued* — activates on *${new Date(activeSub.expiry_time).toDateString()}* when your current plan expires.` +
              (bonusDays > 0
                ? `\n🎁 *+${bonusDays} free day${bonusDays > 1 ? "s" : ""} added!* 🎉`
                : ""),
          });
        } else {
          await sock.sendMessage(targetJid, {
            text:
              `✅ *Your plan has been activated!* (by Admin)\n\n` +
              `📡 Plan: *${plan.name}*\n` +
              `📅 Expires: *${newExpiry.toDateString()}*\n\n` +
              `Your plan is now active — connect at *http://10.5.50.1* and enjoy! 🛰️`,
          });
        }
      } catch (err) {
        console.error(
          "Failed to notify user of admin activation:",
          err.message,
        );
      }

      // 5. Provision if not queued
      if (
        !isRenewal &&
        targetUser.hotspot_username &&
        targetUser.hotspot_password
      ) {
        await provisionOrQueue(
          db,
          sock,
          targetUser,
          plan,
          targetJid,
          targetUser.hotspot_username,
          targetUser.hotspot_password,
          false,
          newExpiry,
          true,
        );
      } else if (!isRenewal) {
        // User doesn't have credentials yet, tell admin they need to log in to the bot
        await sock.sendMessage(from, {
          text: `⚠️ *Note:* User *${targetUser.hotspot_username}* hasn't set up their MikroTik credentials yet. They need to reply to the bot to finish setup.`,
        });
      }
    } catch (err) {
      console.error("Admin activation failed:", err);
      await sock.sendMessage(from, {
        text: `❌ Failed to activate plan: ${err.message}`,
      });
    }
    return true;
  }

  if (step === "awaiting_sub_selection") {
    const { subs, targetUser } = session;
    const position = parseInt(text, 10);
    if (isNaN(position) || position < 1 || position > subs.length) {
      await sock.sendMessage(from, {
        text: `Please reply with a number between 1 and ${subs.length}. (Or type !cancel)`,
      });
      return true;
    }

    const sub = subs[position - 1];
    const statusIcon = sub.status === "active" ? "🟢 Active" : "⏳ Queued";

    adminSessions.set(from, {
      step: "awaiting_delsub_confirm",
      targetUser,
      sub,
    });

    await sock.sendMessage(from, {
      text:
        `⚠️ *Confirm Deletion*\n\n` +
        `User: *${targetUser.hotspot_username}*\n` +
        `Plan: *${sub.plan_name}*\n` +
        `Status: *${statusIcon}*\n` +
        `Period: ${fmt(sub.start_time)} → ${fmt(sub.expiry_time)}\n\n` +
        (sub.status === "active"
          ? `🔴 This will *cut their internet immediately* and remove them from MikroTik.\n\n`
          : `ℹ️ This plan is queued and not yet active — no internet will be cut.\n\n`) +
        `Reply *YES* to confirm or *NO* to cancel.`,
    });
    return true;
  }

  if (step === "awaiting_delsub_confirm") {
    const { targetUser, sub } = session;

    if (text.toLowerCase() !== "yes") {
      adminSessions.delete(from);
      await sock.sendMessage(from, { text: `❌ Deletion cancelled.` });
      return true;
    }

    adminSessions.delete(from);

    try {
      // 1. Delete subscription from DB
      await db.query(`DELETE FROM subscriptions WHERE id = $1`, [sub.id]);

      // 2. If active — remove from MikroTik immediately
      if (sub.status === "active" && targetUser.hotspot_username) {
        try {
          const { RouterOSAPI } = await import("node-routeros");
          const apiConn = new RouterOSAPI({
            host: process.env.MIKROTIK_TUNNEL_IP,
            user: process.env.MIKROTIK_USER,
            password: process.env.MIKROTIK_PASS,
            port: parseInt(process.env.MIKROTIK_PORT) || 8728,
            timeout: 10,
          });
          await apiConn.connect();
          try {
            await apiConn.write("/ip/hotspot/user/remove", [
              `=numbers=${targetUser.hotspot_username}`,
            ]);
          } catch (_) {
            /* user may not exist on router — ignore */
          }
          apiConn.close();
        } catch (mikrotikErr) {
          console.error(
            "MikroTik removal failed during !delsub:",
            mikrotikErr.message,
          );
          await sock.sendMessage(from, {
            text: `⚠️ Subscription deleted from DB but *could not remove from MikroTik*: ${mikrotikErr.message}\nYou may need to remove *${targetUser.hotspot_username}* manually from the router.`,
          });
        }
      }

      // 3. Confirm to admin
      await sock.sendMessage(from, {
        text:
          `✅ *Subscription Deleted*\n\n` +
          `User: *${targetUser.hotspot_username}*\n` +
          `Plan: *${sub.plan_name}*\n` +
          (sub.status === "active"
            ? `🔴 Removed from MikroTik — internet access cut.`
            : `ℹ️ Queued plan removed — no internet disruption.`),
      });

      // 4. Notify user
      try {
        const targetJidRes = await db.query(
          `SELECT remote_jid FROM whatsapp_sessions WHERE phone = $1`,
          [targetUser.phone],
        );
        const targetJid =
          targetJidRes.rows[0]?.remote_jid ||
          `${targetUser.phone}@s.whatsapp.net`;
        await sock.sendMessage(targetJid, {
          text:
            sub.status === "active"
              ? `ℹ️ *Notice from Chulo Speednet*\n\nYour *${sub.plan_name}* plan has been removed by an admin.\n\nIf you believe this is a mistake, please contact support.`
              : `ℹ️ *Notice from Chulo Speednet*\n\nYour queued *${sub.plan_name}* plan has been cancelled by an admin.\n\nIf you believe this is a mistake, please contact support.`,
        });
      } catch (notifyErr) {
        console.error(
          "Failed to notify user after !delsub:",
          notifyErr.message,
        );
      }
    } catch (err) {
      console.error("!delsub failed:", err.message);
      await sock.sendMessage(from, {
        text: `❌ Failed to delete subscription: ${err.message}`,
      });
    }
    return true;
  }

  // ── !newuser steps ─────────────────────────────────────────────────

  if (step === "newuser_name") {
    const name = text.trim();

    if (!name || name.length < 2) {
      await sock.sendMessage(from, {
        text: `Please enter a valid name (at least 2 characters). (Or type !cancel)`,
      });
      return true;
    }

    adminSessions.set(from, { ...session, step: "newuser_device", name });

    await sock.sendMessage(from, {
      text:
        `👤 Name: *${name}*\n\n` +
        `*Select Device Limit:*\n` +
        `1️⃣ Single Device\n` +
        `2️⃣ Two Devices\n` +
        `3️⃣ Three Devices\n\n` +
        `Reply with *1*, *2*, or *3*, or type *!cancel*.`,
    });
    return true;
  }

  if (step === "newuser_device") {
    const profileMap = {
      1: { profile: "7/7_Mbps_1Users", label: "Single Device" },
      2: { profile: "7/7_Mbps_2Users", label: "Two Devices" },
      3: { profile: "7/7_Mbps_3Users", label: "Three Devices" },
    };
    const choice = profileMap[text.trim()];
    if (!choice) {
      await sock.sendMessage(from, {
        text: `Please reply with *1*, *2*, or *3*. (Or type !cancel)`,
      });
      return true;
    }

    const plansRes = await db.query(
      `SELECT * FROM plans WHERE mikrotik_profile = $1 ORDER BY duration_days ASC`,
      [choice.profile],
    );
    if (!plansRes.rows.length) {
      await sock.sendMessage(from, {
        text: `❌ No plans found for *${choice.label}*. Use !addplan to create one first.`,
      });
      adminSessions.delete(from);
      return true;
    }

    adminSessions.set(from, {
      ...session,
      step: "newuser_plan",
      ...choice,
      plans: plansRes.rows,
    });

    const lines = plansRes.rows
      .map(
        (p, i) =>
          `${i + 1}️⃣ *${p.name}* — ₦${Number(p.price).toLocaleString()}`,
      )
      .join("\n");

    await sock.sendMessage(from, {
      text: `📡 *Select Plan for ${choice.label}:*\n\n${lines}\n\nReply with a number (1-${plansRes.rows.length}).`,
    });
    return true;
  }

  if (step === "newuser_plan") {
    const position = parseInt(text.trim(), 10);
    const { plans } = session;
    if (isNaN(position) || position < 1 || position > plans.length) {
      await sock.sendMessage(from, {
        text: `Please reply with a valid number from the list. (Or type !cancel)`,
      });
      return true;
    }
    const plan = plans[position - 1];
    adminSessions.set(from, { ...session, step: "newuser_username", plan });
    await sock.sendMessage(from, {
      text:
        `📝 *Set Hotspot Username*\n\n` +
        `Choose a username for *${session.name}*'s hotspot login.\n\n` +
        `Rules:\n` +
        `• Letters and numbers only (no spaces)\n` +
        `• 3–20 characters\n` +
        `• Example: \`emeka\` or \`emeka2024\`\n\n` +
        `Reply with the username:`,
    });
    return true;
  }

  if (step === "newuser_username") {
    const username = sanitizeUsername(text);
    // MikroTik hotspot usernames must be alphanumeric and underscores only
    if (/^\d+$/.test(username)) {
      await sock.sendMessage(from, {
        text:
          `❌ Usernames cannot be numbers only.\n\n` +
          `Please include at least one letter. Example: \`john\` or \`john_2\` or \`john20\`, etc.\n\nTry again:`,
      });
      return true;
    }

    if (!isValidUsername(username)) {
      await sock.sendMessage(from, {
        text:
          `❌ Invalid username. Use only *letters, numbers, or underscores* (3–20 chars).\n\n` +
          `Example: \`john\` or \`John_2\` or \`john20\`, etc.\n\nTry again:`,
      });
      return true;
    }

    // Check if username is taken (case-sensitive — Jenny and JeNNy are different users)
    const takenRes = await db.query(
      `SELECT id FROM users WHERE hotspot_username = $1`,
      [username],
    );
    if (takenRes.rows.length) {
      await sock.sendMessage(from, {
        text: `❌ Username *${username}* is already taken. Try a different one.`,
      });
      return true;
    }
    adminSessions.set(from, { ...session, step: "newuser_password", username });
    await sock.sendMessage(from, {
      text:
        `🔐 *Set Hotspot Password*\n\n` +
        `Choose a password for *${username}*.\n\n` +
        `• At least 4 characters\n` +
        `• Example: \`pass1234\`\n\n` +
        `Reply with the password:`,
    });
    return true;
  }

  if (step === "newuser_password") {
    const password = text.trim();
    if (!isValidPassword(password)) {
      await sock.sendMessage(from, {
        text: `❌ Password must be exactly *4 digits* (e.g. 1234). Please try again:`,
      });
      return true;
    }

    // BUG FIX: Compute expiry HERE and store it in the session.
    // If we recomputed it in newuser_confirm, a delay between steps would
    // cause the expiry shown in the summary to differ from what's saved to DB.
    const newExpiry = new Date();
    newExpiry.setDate(newExpiry.getDate() + session.plan.duration_days);

    adminSessions.set(from, {
      ...session,
      step: "newuser_confirm",
      password,
      newExpiry: newExpiry.toISOString(),
    });

    await sock.sendMessage(from, {
      text:
        `✅ *Confirm New Customer*\n\n` +
        `📞 Phone: *+${session.phone}*\n` +
        `👤 Name: *${session.name}*\n` +
        `🌐 Username: *${session.username}*\n` +
        `🔑 Password: *${password}*\n` +
        `📡 Plan: *${session.plan.name}* — ₦${Number(session.plan.price).toLocaleString()}\n` +
        `📱 Devices: *${session.label}*\n` +
        `📅 Expires: *${newExpiry.toDateString()}*\n\n` +
        `Reply *YES* to create & activate, or *NO* to cancel.`,
    });
    return true;
  }

  if (step === "newuser_confirm") {
    if (text.trim().toLowerCase() !== "yes") {
      adminSessions.delete(from);
      await sock.sendMessage(from, { text: `❌ New user creation cancelled.` });
      return true;
    }

    const {
      phone,
      name,
      username,
      password,
      plan,
      newExpiry: newExpiryISO,
    } = session;
    // Reuse the exact expiry computed during newuser_password — no drift
    const newExpiry = new Date(newExpiryISO);
    adminSessions.delete(from);

    await sock.sendMessage(from, {
      text: `⏳ Creating account and provisioning *${username}* on MikroTik...`,
    });

    // BUG FIX: Wrap all DB writes in a transaction so a mid-flight error
    // (e.g. subscription insert fails) doesn't leave an orphaned user record.
    const client = await db.connect();
    let newUser;
    let txError = null;
    try {
      await client.query("BEGIN");

      // 1. Create or update user record
      if (session.existingUserId) {
        // Partial user — already in DB, just fill in missing credentials
        const userUpdate = await client.query(
          `
                    UPDATE users
                    SET name = $1, hotspot_username = $2, hotspot_password = $3, updated_at = CURRENT_TIMESTAMP
                    WHERE id = $4
                    RETURNING *
                `,
          [name, username, password, session.existingUserId],
        );
        newUser = userUpdate.rows[0];
      } else {
        // Brand-new user — full INSERT
        const userInsert = await client.query(
          `
                    INSERT INTO users (phone, name, hotspot_username, hotspot_password, status, created_at)
                    VALUES ($1, $2, $3, $4, 'active', CURRENT_TIMESTAMP)
                    RETURNING *
                `,
          [phone, name, username, password],
        );
        newUser = userInsert.rows[0];
      }

      // 2. Create whatsapp_sessions row so the bot recognises them later
      await client.query(
        `
                INSERT INTO whatsapp_sessions (phone, remote_jid, state, last_updated)
                VALUES ($1, $2, 'start', CURRENT_TIMESTAMP)
                ON CONFLICT (phone) DO NOTHING
            `,
        [phone, `${phone}@s.whatsapp.net`],
      );

      // 3. Record cash payment
      await client.query(
        `
                INSERT INTO payments (user_id, amount, status, provider, method, paid_at)
                VALUES ($1, $2, 'completed', 'admin_manual', 'cash', CURRENT_TIMESTAMP)
            `,
        [newUser.id, plan.price],
      );

      // 4. Create active subscription
      await client.query(
        `
                INSERT INTO subscriptions (user_id, plan_id, status, start_time, expiry_time, alert_sent)
                VALUES ($1, $2, 'active', CURRENT_TIMESTAMP, $3, false)
            `,
        [newUser.id, plan.id, newExpiry],
      );

      await client.query("COMMIT");
    } catch (err) {
      txError = err;
      try {
        await client.query("ROLLBACK");
      } catch (_) {
        /* connection already dead */
      }
    } finally {
      // Always release — even if ROLLBACK itself throws
      client.release();
    }
    if (txError) {
      console.error("!newuser DB transaction failed:", txError.message);
      await sock.sendMessage(from, {
        text: `❌ Failed to create user: ${txError.message}`,
      });
      return true;
    }

    try {
      // 5. Provision on MikroTik (outside transaction — MikroTik is not a DB)
      const targetJid = `${phone}@s.whatsapp.net`;
      await provisionOrQueue(
        db,
        sock,
        newUser,
        plan,
        targetJid,
        username,
        password,
        false,
        newExpiry,
        true,
      );

      // 6. Confirm to admin
      await sock.sendMessage(from, {
        text:
          `✅ *New Customer Created & Activated!*\n\n` +
          `📞 Phone: *+${phone}*\n` +
          `👤 Name: *${name}*\n` +
          `🌐 Username: *${username}*\n` +
          `📡 Plan: *${plan.name}*\n` +
          `📅 Expires: *${newExpiry.toDateString()}*\n\n` +
          `MikroTik provisioned ✅`,
      });

      // 7. Notify customer on WhatsApp
      try {
        await sock.sendMessage(targetJid, {
          text:
            `👋 *Welcome to Chulo Speednet!*\n\n` +
            `Your account has been set up by our team.\n\n` +
            `🌐 *Your Login Details*\n` +
            `Username: \`${username}\`\n` +
            `Password: \`${password}\`\n\n` +
            `📡 Plan: *${plan.name}*\n` +
            `📅 Expires: *${newExpiry.toDateString()}*\n\n` +
            `Connect at: *http://10.5.50.1*\n\n` +
            `Send *HI* anytime to manage your account. Enjoy! 🛰️`,
        });
      } catch (notifyErr) {
        console.error("Failed to notify new user:", notifyErr.message);
        await sock.sendMessage(from, {
          text: `⚠️ Account created but couldn't send WhatsApp notification to +${phone}. Share the credentials manually.`,
        });
      }
    } catch (err) {
      console.error("!newuser post-DB step failed:", err.message);
      await sock.sendMessage(from, {
        text: `⚠️ User was created in DB but an error occurred after: ${err.message}`,
      });
    }
    return true;
  }

  // ── !addplan steps ─────────────────────────────────────────────────

  if (step === "addplan_device") {
    const profileMap = {
      1: { profile: "7/7_Mbps_1Users", label: "Single Device" },
      2: { profile: "7/7_Mbps_2Users", label: "Two Devices" },
      3: { profile: "7/7_Mbps_3Users", label: "Three Devices" },
    };
    const choice = profileMap[text];
    if (!choice) {
      await sock.sendMessage(from, {
        text: `Please reply with *1*, *2*, or *3*. (Or type !cancel)`,
      });
      return true;
    }
    adminSessions.set(from, { step: "addplan_price", ...choice });
    await sock.sendMessage(from, {
      text: `💰 *Enter the plan price in ₦* (numbers only):\nExample: \`3500\``,
    });
    return true;
  }

  if (step === "addplan_price") {
    const price = parseInt(text.replace(/[^\d]/g, ""), 10);
    if (isNaN(price) || price <= 0) {
      await sock.sendMessage(from, {
        text: `Please enter a valid price (numbers only). (Or type !cancel)`,
      });
      return true;
    }
    adminSessions.set(from, { ...session, step: "addplan_duration", price });
    await sock.sendMessage(from, {
      text: `📅 *Enter the plan duration in days* (numbers only):\nExample: \`30\` for 1 month, \`7\` for 1 week`,
    });
    return true;
  }

  if (step === "addplan_duration") {
    const days = parseInt(text.replace(/[^\d]/g, ""), 10);
    if (isNaN(days) || days <= 0) {
      await sock.sendMessage(from, {
        text: `Please enter a valid number of days. (Or type !cancel)`,
      });
      return true;
    }

    // Auto-generate human-friendly duration label
    function durationLabel(d) {
      if (d === 1) return "1 Day";
      if (d < 7) return `${d} Days`;
      if (d === 7) return "1 Week";
      if (d === 14) return "2 Weeks";
      if (d === 21) return "3 Weeks";
      if (d === 30) return "1 Month";
      if (d === 60) return "2 Months";
      if (d === 90) return "3 Months";
      if (d % 30 === 0) return `${d / 30} Months`;
      if (d % 7 === 0) return `${d / 7} Weeks`;
      return `${d} Days`;
    }

    const planName = `${durationLabel(days)} - ${session.label}`;
    adminSessions.set(from, {
      ...session,
      step: "addplan_confirm",
      days,
      planName,
    });

    await sock.sendMessage(from, {
      text:
        `ℹ️ *Confirm New Plan*\n\n` +
        `📝 Name: *${planName}*\n` +
        `💰 Price: *₦${Number(session.price).toLocaleString()}*\n` +
        `📅 Duration: *${days} days*\n` +
        `📱 Devices: *${session.label}*\n` +
        `⚙️ Profile: \`${session.profile}\`\n\n` +
        `Reply *YES* to save or *NO* to cancel.`,
    });
    return true;
  }

  if (step === "addplan_confirm") {
    if (text.toLowerCase() !== "yes") {
      adminSessions.delete(from);
      await sock.sendMessage(from, { text: `❌ Plan creation cancelled.` });
      return true;
    }

    adminSessions.delete(from);

    try {
      const res = await db.query(
        `INSERT INTO plans (name, price, duration_days, mikrotik_profile)
                 VALUES ($1, $2, $3, $4)
                 RETURNING id`,
        [session.planName, session.price, session.days, session.profile],
      );
      const newId = res.rows[0].id;
      await sock.sendMessage(from, {
        text:
          `✅ *Plan Created Successfully!*\n\n` +
          `📝 *${session.planName}*\n` +
          `💰 ₦${Number(session.price).toLocaleString()} · ${session.days} days · ${session.label}\n` +
          `🔑 Plan ID: ${newId}\n\n` +
          `Users can now purchase this plan immediately.`,
      });
    } catch (err) {
      console.error("!addplan failed:", err.message);
      await sock.sendMessage(from, {
        text: `❌ Failed to save plan: ${err.message}`,
      });
    }
    return true;
  }

  return true;
}
