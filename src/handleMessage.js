import { createDynamicVirtualAccount } from "./flutterwave.js";
import { provisionOrQueue } from "./fulfillPayment.js";

import { provisionHotspotUser, buildMikrotikComment } from "./mikrotik.js";
import { handleAdminMessage } from "./adminHandler.js";

const ADMIN_PHONES = (process.env.ADMIN_PHONE || "")
  .split(",")
  .map((p) => p.trim().replace(/^\+/, ""));

function sanitizeUsername(input) {
  // Strip emojis and special chars — keep only alphanumeric and underscore (preserve case)
  return input.replace(/[^\w]/g, "").trim();
}

function isValidUsername(s) {
  // Must be 3–20 chars, letters/numbers/underscores, and contain at least one letter
  // (prevents purely numeric usernames which would clash with page numbers in admin commands)
  return /^[a-zA-Z0-9_]{3,20}$/.test(s) && /[a-zA-Z]/.test(s);
}

function isValidPassword(s) {
  return /^\d{4}$/.test(s); // exactly 4 digits
}

// ---------------------------------------------------------
// DATABASE HELPERS
// ---------------------------------------------------------

async function upsertUser(db, phone, pushName = null) {
  let res = await db.query("SELECT * FROM users WHERE phone = $1", [phone]);
  if (res.rows.length === 0) {
    res = await db.query(
      `INSERT INTO users (phone, name) VALUES ($1, $2) RETURNING *`,
      [phone, pushName],
    );
  } else {
    // Update name if we now have it and didn't before
    res = await db.query(
      `UPDATE users SET updated_at = CURRENT_TIMESTAMP, name = COALESCE($2, name) WHERE phone = $1 RETURNING *`,
      [phone, pushName],
    );
  }
  return res.rows[0];
}

async function getSession(db, phone) {
  const res = await db.query(
    "SELECT state, plan_id, remote_jid, gift_target_user_id, pending_username, pending_password FROM whatsapp_sessions WHERE phone = $1",
    [phone],
  );
  return res.rows.length > 0
    ? res.rows[0]
    : { state: "start", plan_id: null, remote_jid: null, gift_target_user_id: null, pending_username: null, pending_password: null };
}

async function updateSession(
  db,
  phone,
  state,
  planId = null,
  remoteJid = null,
  giftTargetUserId = null,
  pendingUsername = undefined,
  pendingPassword = undefined,
) {
  await db.query(
    `
        INSERT INTO whatsapp_sessions (phone, state, plan_id, remote_jid, gift_target_user_id, pending_username, pending_password)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (phone) DO UPDATE
        SET state               = EXCLUDED.state,
            plan_id             = COALESCE(EXCLUDED.plan_id, whatsapp_sessions.plan_id),
            remote_jid          = COALESCE(EXCLUDED.remote_jid, whatsapp_sessions.remote_jid),
            gift_target_user_id = EXCLUDED.gift_target_user_id,
            pending_username    = COALESCE(EXCLUDED.pending_username, whatsapp_sessions.pending_username),
            pending_password    = COALESCE(EXCLUDED.pending_password, whatsapp_sessions.pending_password),
            last_updated        = CURRENT_TIMESTAMP
    `,
    [phone, state, planId, remoteJid, giftTargetUserId, pendingUsername ?? null, pendingPassword ?? null],
  );
}

async function getPlan(db, id) {
  const res = await db.query(
    "SELECT id, name, price, duration_days, mikrotik_profile FROM plans WHERE id = $1",
    [id],
  );
  return res.rows.length > 0 ? res.rows[0] : null;
}

async function getAllPlans(db) {
  const res = await db.query(
    "SELECT id, name, price, duration_days, mikrotik_profile FROM plans ORDER BY mikrotik_profile, duration_days DESC",
  );
  return res.rows;
}

async function getActiveSubscription(db, userId) {
  const res = await db.query(
    `
        SELECT s.*, p.name AS plan_name, p.mikrotik_profile, p.duration_days
        FROM subscriptions s
        JOIN plans p ON p.id = s.plan_id
        WHERE s.user_id = $1 AND s.status = 'active' AND s.expiry_time > CURRENT_TIMESTAMP
        ORDER BY s.expiry_time DESC LIMIT 1
    `,
    [userId],
  );
  return res.rows.length > 0 ? res.rows[0] : null;
}

async function getSubscriptionHistory(db, userId) {
  const res = await db.query(
    `
        SELECT s.status, s.start_time, s.expiry_time, p.name AS plan_name
        FROM subscriptions s
        JOIN plans p ON p.id = s.plan_id
        WHERE s.user_id = $1
        ORDER BY s.start_time DESC LIMIT 6
    `,
    [userId],
  );
  return res.rows;
}

async function getPaymentHistory(db, userId) {
  const res = await db.query(
    `
        SELECT p.amount, p.status, p.paid_at, p.created_at, pl.name AS plan_name
        FROM payments p
        LEFT JOIN whatsapp_sessions ws ON ws.phone = (
            SELECT phone FROM users WHERE id = $1
        )
        LEFT JOIN plans pl ON pl.id = ws.plan_id
        WHERE p.user_id = $1
        ORDER BY p.created_at DESC LIMIT 6
    `,
    [userId],
  );
  return res.rows;
}

// ---------------------------------------------------------
// MESSAGE BUILDERS
// ---------------------------------------------------------

function buildWelcomeMessage(name = "there") {
  return (
    `👋 *Hi ${name}, welcome to Chulo Speednet!*\n` +
    `Your trusted Starlink internet provider.\n\n` +
    `How can we help you today?\n\n` +
    `1️⃣  📡 Buy a Data Plan\n` +
    `2️⃣  🔑 Change Password\n` +
    `3️⃣  👤 Change Username\n` +
    `4️⃣  📋 Check Sub Duration Left\n` +
    `5️⃣  🕓 Subscription History\n` +
    `6️⃣  💳 Payment History\n` +
    `7️⃣  📞 Contact Support\n\n` +
    `Reply with a number (1–7).`
  );
}

function buildAdminWelcomeMessage(name = "Admin") {
  return (
    `👋 *Hi ${name}!* 🛡️ *Chulo Speednet Admin*\n\n` +
    `*📱 User Options:*\n` +
    `1️⃣  📡 Buy a Data Plan\n` +
    `2️⃣  🔑 Change Password\n` +
    `3️⃣  👤 Change Username\n` +
    `4️⃣  📋 Check Sub Duration Left\n` +
    `5️⃣  🕓 Subscription History\n` +
    `6️⃣  💳 Payment History\n` +
    `7️⃣  📞 Contact Support\n\n` +
    `*🛠️ Admin Commands:*\n` +
    `Type *!help* to see all admin commands.\n\n` +
    `Reply with a number (1–7) or an admin command.`
  );
}

const NUM_WORDS = {
  1: "One",
  2: "Two",
  3: "Three",
  4: "Four",
  5: "Five",
  6: "Six",
  7: "Seven",
  8: "Eight",
  9: "Nine",
};

// Strips device-count suffix and spells out leading number
// e.g. "1 Month - Single Device" → "One Month"
function spellPlanName(name) {
  const stripped = name
    .replace(/\s*[-–]\s*(Single Device|Two Devices|Three Devices)$/i, "")
    .trim();
  return stripped.replace(/^(\d+)/, (_, n) => NUM_WORDS[n] || n);
}

function buildDeviceMenu() {
  return (
    `📱 *How many devices will connect?*\n\n` +
    `1️⃣  Single Device\n` +
    `2️⃣  Two Devices\n` +
    `3️⃣  Three Devices\n\n` +
    `Reply *1*, *2*, or *3*, or *0* to go back.`
  );
}

const EMOJI_NUMS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];

function buildFilteredPlanMenu(plans, label) {
  let text = `📡 *${label} Plans*\n\n`;
  text += plans
    .map(
      (p, i) =>
        `${EMOJI_NUMS[i]}  ${spellPlanName(p.name)} — ₦${Number(p.price).toLocaleString()}`,
    )
    .join("\n");
  text += `\n\nReply with the plan number (1–${plans.length}), or *0* to go back.`;
  return text;
}

function fmt(date) {
  return new Date(date).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

// ---------------------------------------------------------
// MAIN HANDLER
// ---------------------------------------------------------

export async function handleMessage(
  sock,
  from,
  pnJid,
  text,
  pushName = null,
  db,
) {
  if (!text) return;

  // Only handle PN (@s.whatsapp.net) and LID (@lid) — everything else was filtered upstream
  if (!from.endsWith("@s.whatsapp.net") && !from.endsWith("@lid")) return;

  const message = text.trim();
  const msgLower = message.toLowerCase();

  // Always extract the phone from the PN JID so it's a real phone number,
  // not a LID number — pnJid is @s.whatsapp.net if available, @lid as fallback
  const phone = pnJid.split("@")[0];
  const pnPhone = phone; // alias for clarity in admin check

  const user = await upsertUser(db, phone, pushName);
  const session = await getSession(db, phone);
  const firstName = (user.name || pushName || "there").split(" ")[0];

  // Admin gate — match against PN phone number, works regardless of LID/PN JID type
  if (ADMIN_PHONES.includes(pnPhone)) {
    const handled = await handleAdminMessage(sock, from, text, db);
    if (handled) return; // admin command consumed — skip normal user flow
  }

  // Universal reset — hi / hello / menu
  if (["hi", "hello", "menu"].includes(msgLower)) {
    await updateSession(db, phone, "awaiting_service_selection", null, from);
    const welcomeText = ADMIN_PHONES.includes(pnPhone)
      ? buildAdminWelcomeMessage(firstName)
      : buildWelcomeMessage(firstName);
    await sock.sendMessage(from, { text: welcomeText });
    return;
  }

  // Context-aware back: '0' goes to the previous logical step
  if (msgLower === "0") {
    if (session.state === "awaiting_plan_selection") {
      // Plan list → device selection (preserve gift target)
      await updateSession(db, phone, "awaiting_device_selection", null, from, session.gift_target_user_id);
      await sock.sendMessage(from, { text: buildDeviceMenu() });
    } else if (session.state === "awaiting_device_selection" && session.gift_target_user_id) {
      // Device selection (gift mode) → enter username screen
      await updateSession(db, phone, "awaiting_gift_username", null, from, null);
      await sock.sendMessage(from, {
        text:
          `👤 *Enter the hotspot username* of the person you're buying for:\n\n` +
          `Reply *0* to go back.`,
      });
    } else if (session.state === "awaiting_device_selection" && !session.gift_target_user_id) {
      // Device selection (self mode) → "Myself or Someone else?"
      await updateSession(db, phone, "awaiting_purchase_target", null, from, null);
      await sock.sendMessage(from, {
        text:
          `📡 *Who are you buying for?*\n\n` +
          `1️⃣  Myself\n` +
          `2️⃣  Someone else\n\n` +
          `Reply *1* or *2*, or *0* to go back.`,
      });
    } else if (session.state === "awaiting_gift_username") {
      // Enter username → "Myself or Someone else?"
      await updateSession(db, phone, "awaiting_purchase_target", null, from, null);
      await sock.sendMessage(from, {
        text:
          `📡 *Who are you buying for?*\n\n` +
          `1️⃣  Myself\n` +
          `2️⃣  Someone else\n\n` +
          `Reply *1* or *2*, or *0* to go back.`,
      });
    } else {
      // Everywhere else (including awaiting_purchase_target) → main menu
      await updateSession(db, phone, "awaiting_service_selection", null, from, null);
      await sock.sendMessage(from, { text: buildWelcomeMessage(firstName) });
    }
    return;
  }

  switch (session.state) {
    // ──────────────────────────────────────────────────────────────────
    // MAIN MENU
    // ──────────────────────────────────────────────────────────────────
    case "awaiting_service_selection": {
      switch (message) {
        // ── 1. Buy a Data Plan ──────────────────────────────────
        case "1": {
          // Clear any previous gift target before starting a new purchase flow
          await updateSession(db, phone, "awaiting_purchase_target", null, from, null);
          await sock.sendMessage(from, {
            text:
              `📡 *Who are you buying for?*\n\n` +
              `1️⃣  Myself\n` +
              `2️⃣  Someone else\n\n` +
              `Reply *1* or *2*, or *0* to go back.`,
          });
          break;
        }

        // ── 2. Change Password ──────────────────────────────────
        case "2": {
          const sub = await getActiveSubscription(db, user.id);
          if (!sub) {
            await sock.sendMessage(from, {
              text:
                `❌ *No Active Subscription*\n\n` +
                `You need an active plan to change your password.\n\n` +
                `Reply *1* to buy a plan or *HI* for the main menu.`,
            });
            break;
          }
          await updateSession(db, phone, "awaiting_new_password", null, from);
          await sock.sendMessage(from, {
            text:
              `🔑 *Change Password*\n\n` +
              `Current username: \`${user.hotspot_username || phone}\`\n\n` +
              `Enter your new *4-digit PIN* (numbers only):\n` +
              `Reply *0* to cancel.`,
          });
          break;
        }

        // ── 3. Change Username ──────────────────────────────────
        case "3": {
          const sub = await getActiveSubscription(db, user.id);
          if (!sub) {
            await sock.sendMessage(from, {
              text:
                `❌ *No Active Subscription*\n\n` +
                `You need an active plan to change your username.\n\n` +
                `Reply *1* to buy a plan or *HI* for the main menu.`,
            });
            break;
          }
          await updateSession(db, phone, "awaiting_new_username", null, from);
          await sock.sendMessage(from, {
            text:
              `👤 *Change Username*\n\n` +
              `Current username: \`${user.hotspot_username || phone}\`\n\n` +
              `Choose a new username (letters/numbers/underscore, 3–20 chars):\n` +
              `Reply *0* to cancel.`,
          });
          break;
        }

        // ── 4. Check Sub Duration Left ──────────────────────────
        case "4": {
          const sub = await getActiveSubscription(db, user.id);

          // Also fetch any queued (pending activation) plans
          const queuedRes = await db.query(
            `SELECT s.start_time, s.expiry_time, p.name AS plan_name
             FROM subscriptions s
             JOIN plans p ON p.id = s.plan_id
             WHERE s.user_id = $1 AND s.status = 'queued'
             ORDER BY s.start_time ASC`,
            [user.id],
          );
          const queuedPlans = queuedRes.rows;

          if (!sub && !queuedPlans.length) {
            await sock.sendMessage(from, {
              text:
                `📋 *No Active Subscription*\n\n` +
                `You currently have no active data plan.\n\n` +
                `Reply *1* to buy a plan or *HI* for the main menu.`,
            });
          } else {
            let text = `📋 *Your Subscription*\n\n`;

            if (sub) {
              const expiry = new Date(sub.expiry_time);
              const daysLeft = Math.ceil(
                (expiry - new Date()) / (1000 * 60 * 60 * 24),
              );
              const hoursLeft = Math.ceil(
                (expiry - new Date()) / (1000 * 60 * 60),
              );
              const timeLeft =
                daysLeft > 1
                  ? `${daysLeft} days`
                  : `${hoursLeft} hour${hoursLeft !== 1 ? "s" : ""}`;
              const statusIcon = daysLeft <= 2 ? "⚠️" : "🟢";

              text +=
                `${statusIcon} *${sub.plan_name}*\n` +
                `⏱ ${timeLeft} left · Expires ${fmt(sub.expiry_time)}`;

              if (daysLeft <= 2) {
                text += `\n⚠️ Expiring soon! Reply *1* to renew.`;
              }
            }

            if (queuedPlans.length) {
              text += `\n\n🔒 *Pending Activation*\n`;
              for (const q of queuedPlans) {
                text +=
                  `\n⏳ ${q.plan_name}\n` +
                  `🕐 Starts ${fmt(q.start_time)} · Expires ${fmt(q.expiry_time)}`;
              }
            }

            text += `\n\nReply *HI* for the main menu.`;

            await sock.sendMessage(from, { text });
          }
          await updateSession(db, phone, "start");
          break;
        }


        // ── 5. Subscription History ─────────────────────────────
        case "5": {
          const history = await getSubscriptionHistory(db, user.id);
          if (!history.length) {
            await sock.sendMessage(from, {
              text:
                `🕓 *Subscription History*\n\n` +
                `You have no subscription history yet.\n\n` +
                `Reply *1* to buy your first plan or *HI* for the main menu.`,
            });
          } else {
            const lines = history
              .map((s, i) => {
                const statusEmoji = s.status === "active" ? "🟢" : "🔴";
                return (
                  `${i + 1}. ${statusEmoji} *${s.plan_name}*\n` +
                  `   📅 ${fmt(s.start_time)} → ${fmt(s.expiry_time)}`
                );
              })
              .join("\n\n");

            await sock.sendMessage(from, {
              text:
                `🕓 *Subscription History* (last 6)\n\n` +
                `${lines}\n\n` +
                `Reply *HI* for the main menu.`,
            });
          }
          await updateSession(db, phone, "start");
          break;
        }

        // ── 6. Payment History ──────────────────────────────────
        case "6": {
          const payments = await db.query(
            `
                        SELECT amount, status, paid_at, created_at
                        FROM payments
                        WHERE user_id = $1
                        ORDER BY created_at DESC LIMIT 6
                    `,
            [user.id],
          );

          if (!payments.rows.length) {
            await sock.sendMessage(from, {
              text:
                `💳 *Payment History*\n\n` +
                `No payments found on your account yet.\n\n` +
                `Reply *1* to buy a plan or *HI* for the main menu.`,
            });
          } else {
            const lines = payments.rows
              .map((p, i) => {
                const statusEmoji =
                  p.status === "completed"
                    ? "✅"
                    : p.status === "pending"
                      ? "⏳"
                      : "❌";
                const date = p.paid_at || p.created_at;
                return (
                  `${i + 1}. ${statusEmoji} *₦${Number(p.amount).toLocaleString()}*\n` +
                  `   📅 ${fmt(date)} — ${p.status}`
                );
              })
              .join("\n\n");

            await sock.sendMessage(from, {
              text:
                `💳 *Payment History* (last 6)\n\n` +
                `${lines}\n\n` +
                `Reply *HI* for the main menu.`,
            });
          }
          await updateSession(db, phone, "start");
          break;
        }

        // ── 7. Contact Support ──────────────────────────────────
        case "7": {
          await sock.sendMessage(from, {
            text:
              `📞 *Chulo Speednet Support*\n\n` +
              `We're here to help! Reach us via:\n\n` +
              `💬 WhatsApp: This chat\n` +
              `📞 Phone Number: +2348112677404\n` +
              `⏰ Hours: *Mon–Sun, 8am–9pm*\n\n` +
              `Describe your issue and our team will respond shortly.\n\n` +
              `Reply *HI* to return to the main menu.`,
          });
          await updateSession(db, phone, "awaiting_support_message");
          break;
        }

        default:
          await sock.sendMessage(from, {
            text: `Please reply with a number between *1 and 7*, or send *HI* to see the menu again.`,
          });
      }
      break;
    }

    // ──────────────────────────────────────────────────────────────────
    // BUY PLAN — Step -1: self or someone else?
    // ──────────────────────────────────────────────────────────────────
    case "awaiting_purchase_target": {
      if (message === "1") {
        // Buying for self — clear any gift target and proceed normally
        await updateSession(db, phone, "awaiting_device_selection", null, from, null);
        await sock.sendMessage(from, { text: buildDeviceMenu() });
      } else if (message === "2") {
        // Buying for someone else — ask for their username
        await updateSession(db, phone, "awaiting_gift_username", null, from, null);
        await sock.sendMessage(from, {
          text:
            `👤 *Enter the hotspot username* of the person you're buying for:\n\n` +
            `Reply *0* to go back.`,
        });
      } else {
        await sock.sendMessage(from, {
          text: `Please reply *1* for Myself or *2* for Someone else, or *0* to go back.`,
        });
      }
      break;
    }

    // ──────────────────────────────────────────────────────────────────
    // BUY PLAN — Step -0.5: look up gift recipient by username
    // ──────────────────────────────────────────────────────────────────
    case "awaiting_gift_username": {
      const targetUsername = message.trim();

      // Look up User B by their hotspot username (case-insensitive)
      const targetRes = await db.query(
        `SELECT * FROM users WHERE LOWER(hotspot_username) = LOWER($1)`,
        [targetUsername],
      );

      if (!targetRes.rows.length) {
        await sock.sendMessage(from, {
          text:
            `❌ No account found with username *${targetUsername}*.\n\n` +
            `Please check the username and try again, or reply *0* to go back.`,
        });
        break;
      }

      const targetUser = targetRes.rows[0];

      // Confirm and proceed to device selection, storing the target user's ID
      await updateSession(db, phone, "awaiting_device_selection", null, from, targetUser.id);
      await sock.sendMessage(from, {
        text:
          `✅ Buying for *${targetUser.hotspot_username}*!\n\n` +
          buildDeviceMenu(),
      });
      break;
    }

    // ──────────────────────────────────────────────────────────────────
    // BUY PLAN — Step 0: pick number of devices
    // ──────────────────────────────────────────────────────────────────
    case "awaiting_device_selection": {

      const profileMap = {
        1: { profile: "7/7_Mbps_1Users", label: "Single Device" },
        2: { profile: "7/7_Mbps_2Users", label: "Two Devices" },
        3: { profile: "7/7_Mbps_3Users", label: "Three Devices" },
      };
      const choice = profileMap[message];
      if (choice) {
        const res = await db.query(
          `SELECT * FROM plans WHERE mikrotik_profile = $1 ORDER BY duration_days DESC`,
          [choice.profile],
        );
        // Store baseId in plan_id so positional selection works, and preserve gift target
        const baseId = res.rows[0]?.id;
        await updateSession(db, phone, "awaiting_plan_selection", baseId, from, session.gift_target_user_id);
        await sock.sendMessage(from, {
          text: buildFilteredPlanMenu(res.rows, choice.label),
        });
      } else {
        await sock.sendMessage(from, {
          text: `Please reply *1* for Single, *2* for Two, or *3* for Three Devices, or *0* to go back.`,
        });
      }
      break;
    }

    // ──────────────────────────────────────────────────────────────────
    // SUPPORT MESSAGE — just acknowledge, no auto-routing
    // ──────────────────────────────────────────────────────────────────
    case "awaiting_support_message": {
      await sock.sendMessage(from, {
        text:
          `✅ *Message received!*\n\n` +
          `Our support team will get back to you shortly.\n\n` +
          `Reply *HI* to return to the main menu.`,
      });
      await updateSession(db, phone, "start");
      break;
    }

    // ──────────────────────────────────────────────────────────────────
    // BUY PLAN — Step 1: pick a plan
    // ──────────────────────────────────────────────────────────────────
    case "awaiting_plan_selection": {
      const position = parseInt(message, 10);
      if (isNaN(position) || position < 1 || position > 9) {
        await sock.sendMessage(from, {
          text: `Please reply with a plan number (1–5), or *0* to go back.`,
        });
        return;
      }

      // session.plan_id holds the base DB id for the chosen device tier
      const actualId = (session.plan_id || 1) + position - 1;
      const selectedPlan = await getPlan(db, actualId);
      if (!selectedPlan) {
        await sock.sendMessage(from, {
          text: `Invalid selection. Please reply with a number from the list, or *0* to go back.`,
        });
        return;
      }

      // For queue check: use the TARGET user's active sub (not User A's)
      const subCheckUserId = session.gift_target_user_id || user.id;
      const activeSub = await getActiveSubscription(db, subCheckUserId);
      // ANY active sub means the new plan gets queued (same or different device tier)
      const willBeQueued = !!activeSub;

      const isGift = !!session.gift_target_user_id;
      const giftTarget = isGift
        ? (await db.query(`SELECT hotspot_username FROM users WHERE id = $1`, [session.gift_target_user_id])).rows[0]
        : null;

      await sock.sendMessage(from, {
        text: isGift
          ? `⏳ Generating payment account for *${giftTarget?.hotspot_username}*'s plan...`
          : `⏳ Generating your payment account for *${selectedPlan.name}*...`,
      });

      try {
        const { txRef, accountNumber, accountName, bankName } =
          await createDynamicVirtualAccount(
            phone,
            selectedPlan.price,
            selectedPlan.name,
          );

        await db.query(
          `
                    INSERT INTO payments (user_id, amount, provider, status, virtual_account_reference)
                    VALUES ($1, $2, 'flutterwave', 'pending', $3)
                `,
          [user.id, selectedPlan.price, txRef],
        );

        // Preserve gift_target_user_id through awaiting_payment state
        await updateSession(
          db,
          phone,
          "awaiting_payment",
          selectedPlan.id,
          from,
          session.gift_target_user_id,
        );

        let noticeText = isGift
          ? `This plan will be gifted to *${giftTarget?.hotspot_username}* and activates automatically once payment is received! 🎁`
          : `Your plan activates automatically once payment is received! 🎉`;

        if (willBeQueued) {
          const expiryStr = fmt(activeSub.expiry_time);
          noticeText = isGift
            ? `⚠️ *Important Notice*\n*${giftTarget?.hotspot_username}* already has an active plan. The new *${selectedPlan.name}* plan will be queued and activates AFTER their current plan expires on *${expiryStr}*.`
            : `⚠️ *Important Notice*\nYou currently have an active plan. Your new *${selectedPlan.name}* plan will be queued and will automatically activate AFTER your current plan expires on *${expiryStr}*.⏳`;
        }

        await sock.sendMessage(from, {
          text:
            `✅ *Payment Details*\n\n` +
            (isGift ? `🎁 Gifting to: *${giftTarget?.hotspot_username}*\n` : "") +
            `📡 Plan: *${selectedPlan.name}*\n` +
            `💰 Amount: *₦${Number(selectedPlan.price).toLocaleString()}*\n\n` +
            `🏦 Bank: *${bankName}*\n` +
            `👤 Account Name: *${accountName}*\n` +
            `💳 Account Number: *${accountNumber}*\n\n` +
            `⏱ This account expires in *1 hour*.\n` +
            `${noticeText}\n\n` +
            `Reply *HI* to cancel and start over.`,
        });
      } catch (err) {
        console.error("Dynamic VA creation error:", err);
        await sock.sendMessage(from, {
          text: `❌ Couldn't generate a payment account right now. Please send *HI* to try again.`,
        });
      }
      break;
    }

    // ──────────────────────────────────────────────────────────────────
    // BUY PLAN — Step 2: waiting for Flutterwave webhook
    // ──────────────────────────────────────────────────────────────────
    case "awaiting_payment": {
      if (msgLower === "hi") {
        // Let HI fall through to the catch-all which resets to the main menu
        break;
      }

      // Any message while waiting for payment → reassure the user.
      // We do NOT check Flutterwave manually here anymore — the webhook fires
      // automatically the moment the transfer clears, and it handles everything.
      await sock.sendMessage(from, {
        text:
          `⏳ *We're waiting for your bank to confirm the transfer.*\n\n` +
          `As soon as it clears, your plan will be activated automatically and you'll get a confirmation message.\n\n` +
          `You don't need to do anything else — just sit tight! 🙏`,
      });
      break;
    }



    // ──────────────────────────────────────────────────────────────────
    // MANAGE ACCOUNT sub-menu
    // ──────────────────────────────────────────────────────────────────
    case "awaiting_manage_account": {
      const sub = await getActiveSubscription(db, user.id);
      if (!sub) {
        await updateSession(
          db,
          phone,
          "awaiting_service_selection",
          null,
          from,
        );
        await sock.sendMessage(from, { text: buildWelcomeMessage(firstName) });
        break;
      }

      if (msgLower === "a") {
        // Change password
        await updateSession(db, phone, "awaiting_new_password", null, from);
        await sock.sendMessage(from, {
          text:
            `🔑 *Change Password*\n\n` +
            `Current username: \`${user.hotspot_username || phone}\`\n\n` +
            `Please enter your new *4-digit PIN* (numbers only):\n` +
            `Reply *0* to cancel.`,
        });
      } else if (msgLower === "b") {
        // Change username
        await updateSession(db, phone, "awaiting_new_username", null, from);
        await sock.sendMessage(from, {
          text:
            `👤 *Change Username*\n\n` +
            `Current username: \`${user.hotspot_username || phone}\`\n\n` +
            `Choose a new username (letters/numbers/underscore, 3–20 chars):\n` +
            `Reply *0* to cancel.`,
        });
      } else {
        await sock.sendMessage(from, {
          text: `Please reply *A* to change password, *B* to change username, or *0* to go back.`,
        });
      }
      break;
    }

    // ──────────────────────────────────────────────────────────────────
    // FIRST-TIME SETUP: choose hotspot username (after payment)
    // ──────────────────────────────────────────────────────────────────
    case "awaiting_hotspot_username": {
      const raw = sanitizeUsername(message);
      if (/^\d+$/.test(raw)) {
        await sock.sendMessage(from, {
          text:
            `❌ Usernames cannot be numbers only.\n\n` +
            `Please include at least one letter. Example: \`john\` or \`john_2\` or \`john20\`, etc.\n\nTry again:`,
        });
        break;
      }
      if (!isValidUsername(raw)) {
        await sock.sendMessage(from, {
          text:
            `❌ Invalid username. Use only *letters, numbers, or underscores* (3–20 chars).\n\n` +
            `Example: \`john\` or \`john_2\` or \`john20\`, etc.\n\nTry again:`,
        });
        break;
      }

      // Check if username is already taken (case-insensitively)
      const checkRes = await db.query(
        `SELECT id FROM users WHERE LOWER(hotspot_username) = LOWER($1) AND id != $2`,
        [raw, user.id],
      );
      if (checkRes.rowCount > 0) {
        await sock.sendMessage(from, {
          text: `❌ The username *${raw}* is already taken. Please choose a different username:`,
        });
        break;
      }

      // Stage username and ask for confirmation before saving
      await updateSession(db, phone, "awaiting_hotspot_username_confirm", session.plan_id, from, null, raw);
      await sock.sendMessage(from, {
        text:
          `👤 Are you sure you want *${raw}* as your username?\n\n` +
          `Reply *YES* to confirm or *NO* to choose a different one.`,
      });
      break;
    }

    // ──────────────────────────────────────────────────────────────────
    // FIRST-TIME SETUP: choose hotspot password → provision
    // ──────────────────────────────────────────────────────────────────
    case "awaiting_hotspot_password": {
      if (!isValidPassword(message)) {
        await sock.sendMessage(from, {
          text: `❌ PIN must be exactly *4 digits* (e.g. 1234). Please try again:`,
        });
        break;
      }

      // Stage PIN and ask for confirmation
      await updateSession(db, phone, "awaiting_hotspot_password_confirm", session.plan_id, from, null, undefined, message);
      await sock.sendMessage(from, {
        text:
          `🔑 Are you sure you want *${message}* as your PIN?\n\n` +
          `Make sure it's something you'll remember — you'll need it to connect to the internet.\n\n` +
          `Reply *YES* to confirm or *NO* to choose a different PIN.`,
      });
      break;
    }

    // ──────────────────────────────────────────────────────────────────
    // FIRST-TIME SETUP: confirm hotspot username
    // ──────────────────────────────────────────────────────────────────
    case "awaiting_hotspot_username_confirm": {
      if (msgLower === "yes") {
        const pendingUser = session.pending_username;
        if (!pendingUser) {
          await updateSession(db, phone, "awaiting_hotspot_username", session.plan_id, from);
          await sock.sendMessage(from, { text: `Something went wrong. Please enter your username again:` });
          break;
        }
        // Save confirmed username and proceed to password
        await db.query(`UPDATE users SET hotspot_username = $1 WHERE id = $2`, [pendingUser, user.id]);
        await updateSession(db, phone, "awaiting_hotspot_password", session.plan_id, from);
        await sock.sendMessage(from, {
          text:
            `✅ Username *${pendingUser}* confirmed!\n\n` +
            `Now choose a *4-digit PIN* (numbers only):\n` +
            `Example: \`1234\`\n\nReply with your PIN:`,
        });
      } else if (msgLower === "no") {
        await updateSession(db, phone, "awaiting_hotspot_username", session.plan_id, from);
        await sock.sendMessage(from, {
          text:
            `No problem! Choose a different username\n\n` +
            `(Letters, numbers, or underscores · 3–20 chars)\n` +
            `Example: \`john\` or \`john_2\` or \`john20\`, etc.`,
        });
      } else {
        await sock.sendMessage(from, { text: `Please reply *YES* to confirm or *NO* to choose again.` });
      }
      break;
    }

    // ──────────────────────────────────────────────────────────────────
    // FIRST-TIME SETUP: confirm hotspot password → provision
    // ──────────────────────────────────────────────────────────────────
    case "awaiting_hotspot_password_confirm": {
      if (msgLower === "yes") {
        const pass = session.pending_password;
        const username = user.hotspot_username;
        if (!pass) {
          await updateSession(db, phone, "awaiting_hotspot_password", session.plan_id, from);
          await sock.sendMessage(from, { text: `Something went wrong. Please enter your PIN again:` });
          break;
        }
        await db.query(`UPDATE users SET hotspot_password = $1 WHERE id = $2`, [pass, user.id]);
        const planRes = await db.query(`SELECT * FROM plans WHERE id = $1`, [session.plan_id]);
        const plan = planRes.rows[0];
        await updateSession(db, phone, "start", null, from);
        await sock.sendMessage(from, { text: `⏳ Setting up your account as *${username}*...` });
        const subRes = await db.query(
          `SELECT expiry_time FROM subscriptions WHERE user_id = $1 AND status = 'active' ORDER BY id DESC LIMIT 1`,
          [user.id],
        );
        const expiryTime = subRes.rows[0]?.expiry_time || null;
        await provisionOrQueue(db, sock, user, plan, from, username, pass, false, expiryTime);
      } else if (msgLower === "no") {
        await updateSession(db, phone, "awaiting_hotspot_password", session.plan_id, from);
        await sock.sendMessage(from, {
          text: `No problem! Choose a different *4-digit PIN* (numbers only):\nReply with your new PIN:`,
        });
      } else {
        await sock.sendMessage(from, { text: `Please reply *YES* to confirm or *NO* to choose a different PIN.` });
      }
      break;
    }

    // ──────────────────────────────────────────────────────────────────
    // CHANGE USERNAME
    // ──────────────────────────────────────────────────────────────────
    case "awaiting_new_username": {
      if (msgLower === "0") {
        await updateSession(db, phone, "start");
        await sock.sendMessage(from, {
          text: `Cancelled. Reply *HI* for the main menu.`,
        });
        break;
      }

      const raw = sanitizeUsername(message);
      if (/^\d+$/.test(raw)) {
        await sock.sendMessage(from, {
          text:
            `❌ Usernames cannot be numbers only.\n\n` +
            `Please include at least one letter. Example: \`john\` or \`john_2\` or \`john20\`, etc.\n\nTry again or reply *0* to cancel:`,
        });
        break;
      }
      if (!isValidUsername(raw)) {
        await sock.sendMessage(from, {
          text: `❌ Invalid username. Letters/numbers/underscore only, 3–20 chars.\n\nTry again or reply *0* to cancel:`,
        });
        break;
      }

      // Check if username is already taken (case-insensitively)
      const checkRes = await db.query(
        `SELECT id FROM users WHERE LOWER(hotspot_username) = LOWER($1) AND id != $2`,
        [raw, user.id],
      );
      if (checkRes.rowCount > 0) {
        await sock.sendMessage(from, {
          text: `❌ The username *${raw}* is already taken. Please choose a different username or reply *0* to cancel:`,
        });
        break;
      }

      const sub = await getActiveSubscription(db, user.id);
      if (!sub) {
        await sock.sendMessage(from, {
          text: `❌ Your subscription has expired or is inactive. Please buy a new plan to change your username.`,
        });
        await updateSession(db, phone, "start");
        break;
      }
      // Stage username and confirm before applying
      await updateSession(db, phone, "awaiting_new_username_confirm", null, from, null, raw);
      await sock.sendMessage(from, {
        text:
          `👤 Are you sure you want to change your username to *${raw}*?\n\n` +
          `You'll need to use this new name every time you connect to the hotspot.\n\n` +
          `Reply *YES* to confirm or *NO* to choose a different one.`,
      });
      break;
    }

    // ──────────────────────────────────────────────────────────────────
    // CHANGE USERNAME: confirmation
    // ──────────────────────────────────────────────────────────────────
    case "awaiting_new_username_confirm": {
      if (msgLower === "0") {
        await updateSession(db, phone, "start");
        await sock.sendMessage(from, { text: `Cancelled. Reply *HI* for the main menu.` });
        break;
      }
      if (msgLower !== "yes" && msgLower !== "no") {
        await sock.sendMessage(from, { text: `Please reply *YES* to confirm, *NO* to choose again, or *0* to cancel.` });
        break;
      }
      if (msgLower === "no") {
        await updateSession(db, phone, "awaiting_new_username", null, from);
        await sock.sendMessage(from, {
          text:
            `No problem! Choose a different username\n\n` +
            `(Letters, numbers, or underscores · 3–20 chars)\n` +
            `Reply *0* to cancel.`,
        });
        break;
      }

      // YES — apply the change
      const raw = session.pending_username;
      if (!raw) {
        await updateSession(db, phone, "awaiting_new_username", null, from);
        await sock.sendMessage(from, { text: `Something went wrong. Please enter your username again:` });
        break;
      }
      const sub = await getActiveSubscription(db, user.id);
      if (!sub) {
        await sock.sendMessage(from, { text: `❌ Your subscription has expired or is inactive. Please buy a new plan to change your username.` });
        await updateSession(db, phone, "start");
        break;
      }
      // If no password yet, save username and move to password setup
      if (!user.hotspot_password) {
        await db.query(`UPDATE users SET hotspot_username = $1 WHERE id = $2`, [raw, user.id]);
        await updateSession(db, phone, "awaiting_new_password", null, from);
        await sock.sendMessage(from, {
          text:
            `✅ Username *${raw}* confirmed!\n\n` +
            `You don't have a PIN set yet. Please choose a *4-digit PIN* (numbers only):\n\n` +
            `Reply *0* to cancel.`,
        });
        break;
      }
      const oldUser = user.hotspot_username || phone;
      await sock.sendMessage(from, { text: `⏳ Updating your username to *${raw}*...` });
      try {
        const comment = buildMikrotikComment(user.phone, sub.duration_days, sub.expiry_time);
        await provisionHotspotUser(raw, sub.mikrotik_profile, user.hotspot_password, comment);
        const { RouterOSAPI } = await import("node-routeros");
        const apiConn = new RouterOSAPI({
          host: process.env.MIKROTIK_TUNNEL_IP,
          user: process.env.MIKROTIK_USER,
          password: process.env.MIKROTIK_PASS,
          port: parseInt(process.env.MIKROTIK_PORT) || 8728,
          timeout: 10,
        });
        await apiConn.connect();
        try { await apiConn.write("/ip/hotspot/user/remove", [`=numbers=${oldUser}`]); } catch (_) { /* ignore */ }
        apiConn.close();
        await db.query(`UPDATE users SET hotspot_username = $1 WHERE id = $2`, [raw, user.id]);
        await updateSession(db, phone, "start");
        await sock.sendMessage(from, {
          text:
            `✅ *Username Updated!*\n\n` +
            `🌐 *Your New Login Details*\n` +
            `Username: \`${raw}\`\n` +
            `Password: \`${user.hotspot_password}\`\n\n` +
            `Connect at: *http://10.5.50.1/login*\n\n` +
            `Reply *HI* for the main menu.`,
        });
      } catch (err) {
        console.error("Username change failed:", err.message);
        await updateSession(db, phone, "start");
        await sock.sendMessage(from, { text: `❌ Couldn't update your username right now. Please try again later or contact support (reply *6*).` });
      }
      break;
    }

    // ──────────────────────────────────────────────────────────────────
    // CHANGE PASSWORD
    // ──────────────────────────────────────────────────────────────────
    case "awaiting_new_password": {
      if (msgLower === "0") {
        await updateSession(db, phone, "start");
        await sock.sendMessage(from, {
          text: `Cancelled. Reply *HI* for the main menu.`,
        });
        break;
      }

      if (!isValidPassword(message)) {
        await sock.sendMessage(from, {
          text: `❌ PIN must be exactly *4 digits* (e.g. 5678). Try again or reply *0* to cancel:`,
        });
        break;
      }

      // Stage PIN and confirm
      await updateSession(db, phone, "awaiting_new_password_confirm", null, from, null, undefined, message);
      await sock.sendMessage(from, {
        text:
          `🔑 Are you sure you want to change your PIN to *${message}*?\n\n` +
          `Make sure it's something easy for you to remember.\n\n` +
          `Reply *YES* to confirm or *NO* to choose a different PIN.`,
      });
      break;
    }

    // ──────────────────────────────────────────────────────────────────
    // CHANGE PASSWORD: confirmation
    // ──────────────────────────────────────────────────────────────────
    case "awaiting_new_password_confirm": {
      if (msgLower === "0") {
        await updateSession(db, phone, "start");
        await sock.sendMessage(from, { text: `Cancelled. Reply *HI* for the main menu.` });
        break;
      }
      if (msgLower !== "yes" && msgLower !== "no") {
        await sock.sendMessage(from, { text: `Please reply *YES* to confirm, *NO* to choose again, or *0* to cancel.` });
        break;
      }
      if (msgLower === "no") {
        await updateSession(db, phone, "awaiting_new_password", null, from);
        await sock.sendMessage(from, {
          text: `No problem! Enter a different *4-digit PIN* (numbers only):\nReply *0* to cancel.`,
        });
        break;
      }

      // YES — apply the change
      const newPass = session.pending_password;
      if (!newPass) {
        await updateSession(db, phone, "awaiting_new_password", null, from);
        await sock.sendMessage(from, { text: `Something went wrong. Please enter your PIN again:` });
        break;
      }
      const username = user.hotspot_username || phone;
      const sub = await getActiveSubscription(db, user.id);
      if (!sub) {
        await sock.sendMessage(from, { text: `❌ Your subscription has expired or is inactive. Please buy a new plan to change your password.` });
        await updateSession(db, phone, "start");
        break;
      }
      await sock.sendMessage(from, { text: `⏳ Updating your password...` });
      try {
        const comment = buildMikrotikComment(user.phone, sub.duration_days, sub.expiry_time);
        await provisionHotspotUser(username, sub.mikrotik_profile, newPass, comment);
        await db.query(`UPDATE users SET hotspot_password = $1 WHERE id = $2`, [newPass, user.id]);
        await updateSession(db, phone, "start");
        await sock.sendMessage(from, {
          text:
            `✅ *Password Updated!*\n\n` +
            `🌐 *Your Login Details*\n` +
            `Username: \`${username}\`\n` +
            `Password: \`${newPass}\`\n\n` +
            `Connect at: *http://10.5.50.1*\n\n` +
            `Reply *HI* for the main menu.`,
        });
      } catch (err) {
        console.error("Password change failed:", err.message);
        await updateSession(db, phone, "start");
        await sock.sendMessage(from, { text: `❌ Couldn't update your password right now. Please try again later or contact support (reply *6*).` });
      }
      break;
    }

    // Catch-all — always safe to return to menu
    default:
      await updateSession(db, phone, "awaiting_service_selection", null, from);
      await sock.sendMessage(from, { text: buildWelcomeMessage(firstName) });
      break;
  }
}
