import { createDynamicVirtualAccount } from './flutterwave.js';
import { fulfillPayment, provisionOrQueue } from './fulfillPayment.js';
import { provisionHotspotUser } from './mikrotik.js';

function sanitizeUsername(input) {
    // Strip emojis and special chars — keep only alphanumeric and underscore
    return input.replace(/[^\w]/g, '').toLowerCase().trim();
}

function isValidUsername(s) {
    return /^[a-z0-9_]{3,20}$/.test(s);
}

function isValidPassword(s) {
    return s.length >= 6 && s.length <= 50;
}

// ---------------------------------------------------------
// DATABASE HELPERS
// ---------------------------------------------------------

async function upsertUser(db, phone, pushName = null) {
    let res = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (res.rows.length === 0) {
        res = await db.query(
            `INSERT INTO users (phone, name) VALUES ($1, $2) RETURNING *`,
            [phone, pushName]
        );
    } else {
        // Update name if we now have it and didn't before
        res = await db.query(
            `UPDATE users SET updated_at = CURRENT_TIMESTAMP, name = COALESCE($2, name) WHERE phone = $1 RETURNING *`,
            [phone, pushName]
        );
    }
    return res.rows[0];
}

async function getSession(db, phone) {
    const res = await db.query(
        'SELECT state, plan_id, remote_jid FROM whatsapp_sessions WHERE phone = $1',
        [phone]
    );
    return res.rows.length > 0 ? res.rows[0] : { state: 'start', plan_id: null, remote_jid: null };
}

async function updateSession(db, phone, state, planId = null, remoteJid = null) {
    await db.query(`
        INSERT INTO whatsapp_sessions (phone, state, plan_id, remote_jid)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (phone) DO UPDATE
        SET state        = EXCLUDED.state,
            plan_id      = COALESCE(EXCLUDED.plan_id, whatsapp_sessions.plan_id),
            remote_jid   = COALESCE(EXCLUDED.remote_jid, whatsapp_sessions.remote_jid),
            last_updated = CURRENT_TIMESTAMP
    `, [phone, state, planId, remoteJid]);
}

async function getPlan(db, id) {
    const res = await db.query(
        'SELECT id, name, price, duration_days, mikrotik_profile FROM plans WHERE id = $1',
        [id]
    );
    return res.rows.length > 0 ? res.rows[0] : null;
}

async function getAllPlans(db) {
    const res = await db.query(
        'SELECT id, name, price, duration_days, mikrotik_profile FROM plans ORDER BY mikrotik_profile, duration_days DESC'
    );
    return res.rows;
}

async function getActiveSubscription(db, userId) {
    const res = await db.query(`
        SELECT s.*, p.name AS plan_name, p.mikrotik_profile
        FROM subscriptions s
        JOIN plans p ON p.id = s.plan_id
        WHERE s.user_id = $1 AND s.status = 'active' AND s.expiry_time > CURRENT_TIMESTAMP
        ORDER BY s.expiry_time DESC LIMIT 1
    `, [userId]);
    return res.rows.length > 0 ? res.rows[0] : null;
}

async function getSubscriptionHistory(db, userId) {
    const res = await db.query(`
        SELECT s.status, s.start_time, s.expiry_time, p.name AS plan_name
        FROM subscriptions s
        JOIN plans p ON p.id = s.plan_id
        WHERE s.user_id = $1
        ORDER BY s.start_time DESC LIMIT 6
    `, [userId]);
    return res.rows;
}

async function getPaymentHistory(db, userId) {
    const res = await db.query(`
        SELECT p.amount, p.status, p.paid_at, p.created_at, pl.name AS plan_name
        FROM payments p
        LEFT JOIN whatsapp_sessions ws ON ws.phone = (
            SELECT phone FROM users WHERE id = $1
        )
        LEFT JOIN plans pl ON pl.id = ws.plan_id
        WHERE p.user_id = $1
        ORDER BY p.created_at DESC LIMIT 6
    `, [userId]);
    return res.rows;
}

// ---------------------------------------------------------
// MESSAGE BUILDERS
// ---------------------------------------------------------

function buildWelcomeMessage(name = 'there') {
    return (
        `👋 *Hi ${name}, welcome to Chulo ISP!*\n` +
        `Your trusted Starlink internet provider.\n\n` +
        `How can we help you today?\n\n` +
        `1️⃣  📡 Buy a Data Plan\n` +
        `2️⃣  🔑 Manage Account\n` +
        `3️⃣  📋 Check My Subscription\n` +
        `4️⃣  🕓 Subscription History\n` +
        `5️⃣  💳 Payment History\n` +
        `6️⃣  📞 Contact Support\n\n` +
        `Reply with a number (1–6).`
    );
}

function buildPlanMenu(plans) {
    const tiers = [
        { label: '📱 *Single Device*',     profile: '7/7_Mbps_1Users' },
        { label: '📱📱 *Two Devices*',     profile: '7/7_Mbps_2Users' },
        { label: '📱📱📱 *Three Devices*', profile: 'for three users'  },
    ];

    let text = `📡 *Choose a Data Plan*\n`;
    for (const tier of tiers) {
        const tierPlans = plans.filter(p => p.mikrotik_profile === tier.profile);
        if (!tierPlans.length) continue;
        text += `\n${tier.label}\n`;
        text += tierPlans.map(p =>
            `  ${p.id}. ${p.name.split(' - ')[0]} — ₦${Number(p.price).toLocaleString()}`
        ).join('\n');
        text += '\n';
    }
    text += `\nReply with the plan number, or *0* to go back.`;
    return text;
}

function fmt(date) {
    return new Date(date).toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
    });
}

// ---------------------------------------------------------
// MAIN HANDLER
// ---------------------------------------------------------

export async function handleMessage(sock, from, text, pushName = null, db) {
    if (!text) return;

    const message  = text.trim();
    const msgLower = message.toLowerCase();
    const phone    = from.split('@')[0];

    const user    = await upsertUser(db, phone, pushName);
    const session = await getSession(db, phone);
    const firstName = (user.name || pushName || 'there').split(' ')[0];

    // Universal reset — hi / hello / menu / 0
    if (['hi', 'hello', 'menu', '0'].includes(msgLower)) {
        await updateSession(db, phone, 'awaiting_service_selection', null, from);
        await sock.sendMessage(from, {
            text: buildWelcomeMessage(firstName),
        });
        return;
    }

    switch (session.state) {

        // ──────────────────────────────────────────────────────────────────
        // MAIN MENU
        // ──────────────────────────────────────────────────────────────────
        case 'awaiting_service_selection': {
            switch (message) {

                // ── 1. Buy a Data Plan ──────────────────────────────────
                case '1': {
                    await updateSession(db, phone, 'awaiting_plan_selection', null, from);
                    const plans = await getAllPlans(db);
                    await sock.sendMessage(from, { text: buildPlanMenu(plans) });
                    break;
                }

                // ── 2. Manage Hotspot Account ───────────────────────────
                case '2': {
                    const sub = await getActiveSubscription(db, user.id);
                    if (!sub) {
                        await sock.sendMessage(from, {
                            text:
                                `❌ *No Active Subscription*\n\n` +
                                `You need an active plan to manage your hotspot account.\n\n` +
                                `Reply *1* to buy a plan or *HI* for the main menu.`,
                        });
                        break;
                    }

                    await updateSession(db, phone, 'awaiting_manage_account', null, from);
                    await sock.sendMessage(from, {
                        text:
                            `🔧 *Manage Hotspot Account*\n\n` +
                            `What would you like to do?\n\n` +
                            `A. 🔑 Change Password\n` +
                            `B. 👤 Change Username\n\n` +
                            `Reply *A* or *B*, or *0* to go back.`,
                    });
                    break;
                }

                // ── 3. Check My Subscription ────────────────────────────
                case '3': {
                    const sub = await getActiveSubscription(db, user.id);
                    if (!sub) {
                        await sock.sendMessage(from, {
                            text:
                                `📋 *No Active Subscription*\n\n` +
                                `You currently have no active data plan.\n\n` +
                                `Reply *1* to buy a plan or *HI* for the main menu.`,
                        });
                    } else {
                        const expiry    = new Date(sub.expiry_time);
                        const daysLeft  = Math.ceil((expiry - new Date()) / (1000 * 60 * 60 * 24));
                        const hoursLeft = Math.ceil((expiry - new Date()) / (1000 * 60 * 60));
                        const timeLeft  = daysLeft > 1
                            ? `${daysLeft} days`
                            : `${hoursLeft} hour${hoursLeft !== 1 ? 's' : ''}`;

                        const statusIcon = daysLeft <= 2 ? '⚠️' : '✅';

                        await sock.sendMessage(from, {
                            text:
                                `📋 *Your Active Subscription*\n\n` +
                                `📡 Plan: *${sub.plan_name}*\n` +
                                `📅 Started: *${fmt(sub.start_time)}*\n` +
                                `🔚 Expires: *${fmt(sub.expiry_time)}*\n` +
                                `${statusIcon} Time left: *${timeLeft}*\n\n` +
                                (daysLeft <= 2
                                    ? `⚠️ Your plan is expiring soon! Reply *1* to renew.\n\n`
                                    : '') +
                                `Reply *HI* for the main menu.`,
                        });
                    }
                    await updateSession(db, phone, 'start');
                    break;
                }

                // ── 4. Subscription History ─────────────────────────────
                case '4': {
                    const history = await getSubscriptionHistory(db, user.id);
                    if (!history.length) {
                        await sock.sendMessage(from, {
                            text:
                                `🕓 *Subscription History*\n\n` +
                                `You have no subscription history yet.\n\n` +
                                `Reply *1* to buy your first plan or *HI* for the main menu.`,
                        });
                    } else {
                        const lines = history.map((s, i) => {
                            const statusEmoji = s.status === 'active' ? '🟢' : '🔴';
                            return (
                                `${i + 1}. ${statusEmoji} *${s.plan_name}*\n` +
                                `   📅 ${fmt(s.start_time)} → ${fmt(s.expiry_time)}`
                            );
                        }).join('\n\n');

                        await sock.sendMessage(from, {
                            text:
                                `🕓 *Subscription History* (last 6)\n\n` +
                                `${lines}\n\n` +
                                `Reply *HI* for the main menu.`,
                        });
                    }
                    await updateSession(db, phone, 'start');
                    break;
                }

                // ── 5. Payment History ──────────────────────────────────
                case '5': {
                    const payments = await db.query(`
                        SELECT amount, status, paid_at, created_at
                        FROM payments
                        WHERE user_id = $1
                        ORDER BY created_at DESC LIMIT 6
                    `, [user.id]);

                    if (!payments.rows.length) {
                        await sock.sendMessage(from, {
                            text:
                                `💳 *Payment History*\n\n` +
                                `No payments found on your account yet.\n\n` +
                                `Reply *1* to buy a plan or *HI* for the main menu.`,
                        });
                    } else {
                        const lines = payments.rows.map((p, i) => {
                            const statusEmoji = p.status === 'completed' ? '✅' : p.status === 'pending' ? '⏳' : '❌';
                            const date = p.paid_at || p.created_at;
                            return (
                                `${i + 1}. ${statusEmoji} *₦${Number(p.amount).toLocaleString()}*\n` +
                                `   📅 ${fmt(date)} — ${p.status}`
                            );
                        }).join('\n\n');

                        await sock.sendMessage(from, {
                            text:
                                `💳 *Payment History* (last 6)\n\n` +
                                `${lines}\n\n` +
                                `Reply *HI* for the main menu.`,
                        });
                    }
                    await updateSession(db, phone, 'start');
                    break;
                }

                // ── 6. Contact Support ──────────────────────────────────
                case '6': {
                    await sock.sendMessage(from, {
                        text:
                            `📞 *Chulo ISP Support*\n\n` +
                            `We're here to help! Reach us via:\n\n` +
                            `💬 WhatsApp: This chat\n` +
                            `📧 Email: support@chuloisp.com\n` +
                            `⏰ Hours: *Mon–Sat, 8am–8pm*\n\n` +
                            `Describe your issue and our team will respond shortly.\n\n` +
                            `Reply *HI* to return to the main menu.`,
                    });
                    await updateSession(db, phone, 'awaiting_support_message');
                    break;
                }

                default:
                    await sock.sendMessage(from, {
                        text: `Please reply with a number between *1 and 6*, or send *HI* to see the menu again.`,
                    });
            }
            break;
        }

        // ──────────────────────────────────────────────────────────────────
        // SUPPORT MESSAGE — just acknowledge, no auto-routing
        // ──────────────────────────────────────────────────────────────────
        case 'awaiting_support_message': {
            await sock.sendMessage(from, {
                text:
                    `✅ *Message received!*\n\n` +
                    `Our support team will get back to you shortly.\n\n` +
                    `Reply *HI* to return to the main menu.`,
            });
            await updateSession(db, phone, 'start');
            break;
        }

        // ──────────────────────────────────────────────────────────────────
        // BUY PLAN — Step 1: pick a plan
        // ──────────────────────────────────────────────────────────────────
        case 'awaiting_plan_selection': {
            const planId = parseInt(message, 10);
            if (isNaN(planId)) {
                await sock.sendMessage(from, {
                    text: `Please reply with a plan number, or *0* to go back.`,
                });
                return;
            }

            const selectedPlan = await getPlan(db, planId);
            if (!selectedPlan) {
                await sock.sendMessage(from, {
                    text: `Invalid plan. Please reply with a valid plan number, or *0* to go back.`,
                });
                return;
            }

            await sock.sendMessage(from, {
                text: `⏳ Generating your payment account for *${selectedPlan.name}*...`,
            });

            try {
                const { txRef, accountNumber, bankName } = await createDynamicVirtualAccount(
                    phone,
                    selectedPlan.price,
                    selectedPlan.name
                );

                await db.query(`
                    INSERT INTO payments (user_id, amount, provider, status, virtual_account_reference)
                    VALUES ($1, $2, 'flutterwave', 'pending', $3)
                `, [user.id, selectedPlan.price, txRef]);

                await updateSession(db, phone, 'awaiting_payment', selectedPlan.id, from);

                await sock.sendMessage(from, {
                    text:
                        `✅ *Payment Details*\n\n` +
                        `📡 Plan: *${selectedPlan.name}*\n` +
                        `💰 Amount: *₦${Number(selectedPlan.price).toLocaleString()}*\n\n` +
                        `🏦 Bank: *${bankName}*\n` +
                        `💳 Account Number: *${accountNumber}*\n\n` +
                        `⏱ This account expires in *1 hour*.\n` +
                        `Your plan activates automatically once payment is received! 🎉\n\n` +
                        `Reply *HI* to cancel and start over.`,
                });

            } catch (err) {
                console.error('Dynamic VA creation error:', err);
                await sock.sendMessage(from, {
                    text: `❌ Couldn't generate a payment account right now. Please send *HI* to try again.`,
                });
            }
            break;
        }

        // ──────────────────────────────────────────────────────────────────
        // BUY PLAN — Step 2: waiting for Flutterwave webhook
        // ──────────────────────────────────────────────────────────────────
        case 'awaiting_payment': {
            if (msgLower === 'paid') {
                await sock.sendMessage(from, {
                    text: `⏳ Verifying your payment... please wait a moment.`,
                });
                try {
                    const freshUser = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);
                    await fulfillPayment(db, sock, freshUser.rows[0]);
                } catch (err) {
                    console.error('Manual payment check error:', err);
                    await sock.sendMessage(from, {
                        text: `❌ Couldn't verify payment. Please contact support (reply *6*) or send *HI* to try again.`,
                    });
                }
            } else {
                await sock.sendMessage(from, {
                    text:
                        `⏳ *Awaiting Payment*\n\n` +
                        `Your plan activates automatically once the bank transfer is confirmed.\n\n` +
                        `Reply *PAID* if you've transferred and it hasn't activated yet.\n` +
                        `Reply *HI* to cancel and start over.`,
                });
            }
            break;
        }

        // ──────────────────────────────────────────────────────────────────
        // MANAGE ACCOUNT sub-menu
        // ──────────────────────────────────────────────────────────────────
        case 'awaiting_manage_account': {
            const sub = await getActiveSubscription(db, user.id);
            if (!sub) {
                await updateSession(db, phone, 'awaiting_service_selection', null, from);
                await sock.sendMessage(from, { text: buildWelcomeMessage(firstName) });
                break;
            }

            if (msgLower === 'a') {
                // Change password
                await updateSession(db, phone, 'awaiting_new_password', null, from);
                await sock.sendMessage(from, {
                    text:
                        `🔑 *Change Password*\n\n` +
                        `Current username: \`${user.hotspot_username || phone}\`\n\n` +
                        `Please enter your new password (min 6 characters):\n` +
                        `Reply *0* to cancel.`,
                });
            } else if (msgLower === 'b') {
                // Change username
                await updateSession(db, phone, 'awaiting_new_username', null, from);
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
        case 'awaiting_hotspot_username': {
            const raw       = sanitizeUsername(message);
            if (!isValidUsername(raw)) {
                await sock.sendMessage(from, {
                    text:
                        `❌ Invalid username. Please use only *letters, numbers, or underscores* (3–20 chars).\n\n` +
                        `Example: \`john2024\`\n\nTry again:`,
                });
                break;
            }

            // Save temp username in DB and ask for password
            await db.query(`UPDATE users SET hotspot_username = $1 WHERE id = $2`, [raw, user.id]);
            await updateSession(db, phone, 'awaiting_hotspot_password', session.plan_id, from);
            await sock.sendMessage(from, {
                text:
                    `✅ Username *${raw}* saved!\n\n` +
                    `Now choose a *password* (minimum 6 characters):\n` +
                    `Example: \`mysecret99\`\n\nReply with your password:`,
            });
            break;
        }

        // ──────────────────────────────────────────────────────────────────
        // FIRST-TIME SETUP: choose hotspot password → provision
        // ──────────────────────────────────────────────────────────────────
        case 'awaiting_hotspot_password': {
            if (!isValidPassword(message)) {
                await sock.sendMessage(from, {
                    text: `❌ Password must be *6–50 characters*. Please try again:`,
                });
                break;
            }

            const pass     = message;
            const username = user.hotspot_username;

            await db.query(`UPDATE users SET hotspot_password = $1 WHERE id = $2`, [pass, user.id]);

            // Fetch the plan stored in session
            const planRes = await db.query(`SELECT * FROM plans WHERE id = $1`, [session.plan_id]);
            const plan    = planRes.rows[0];

            await updateSession(db, phone, 'start', null, from);
            await sock.sendMessage(from, { text: `⏳ Setting up your account as *${username}*...` });

            await provisionOrQueue(db, sock, user, plan, from, username, pass, false);
            break;
        }

        // ──────────────────────────────────────────────────────────────────
        // CHANGE USERNAME
        // ──────────────────────────────────────────────────────────────────
        case 'awaiting_new_username': {
            if (msgLower === '0') {
                await updateSession(db, phone, 'start');
                await sock.sendMessage(from, { text: `Cancelled. Reply *HI* for the main menu.` });
                break;
            }

            const raw = sanitizeUsername(message);
            if (!isValidUsername(raw)) {
                await sock.sendMessage(from, {
                    text: `❌ Invalid username. Letters/numbers/underscore only, 3–20 chars.\n\nTry again or reply *0* to cancel:`,
                });
                break;
            }

            const sub     = await getActiveSubscription(db, user.id);
            const oldUser = user.hotspot_username || phone;

            // If no password is set yet, save username and ask for password first
            if (!user.hotspot_password) {
                await db.query(`UPDATE users SET hotspot_username = $1 WHERE id = $2`, [raw, user.id]);
                await updateSession(db, phone, 'awaiting_new_password', null, from);
                await sock.sendMessage(from, {
                    text:
                        `✅ Username *${raw}* saved!\n\n` +
                        `You don't have a password set yet. Please choose one now (6–50 characters):\n\n` +
                        `Reply *0* to cancel.`,
                });
                break;
            }

            await sock.sendMessage(from, { text: `⏳ Updating your username to *${raw}*...` });

            try {
                // 1. Create the new username on MikroTik with the stored password
                await provisionHotspotUser(raw, sub.mikrotik_profile, user.hotspot_password);

                // 2. Remove the old username from MikroTik
                const { RouterOSAPI } = await import('node-routeros');
                const apiConn = new RouterOSAPI({
                    host:     process.env.MIKROTIK_TUNNEL_IP,
                    user:     process.env.MIKROTIK_USER,
                    password: process.env.MIKROTIK_PASS,
                    port:     parseInt(process.env.MIKROTIK_PORT) || 8728,
                    timeout:  10,
                });
                await apiConn.connect();
                try {
                    await apiConn.write('/ip/hotspot/user/remove', [`=numbers=${oldUser}`]);
                } catch (_) { /* old user may not exist — ignore */ }
                apiConn.close();

                await db.query(`UPDATE users SET hotspot_username = $1 WHERE id = $2`, [raw, user.id]);
                await updateSession(db, phone, 'start');

                await sock.sendMessage(from, {
                    text:
                        `✅ *Username Updated!*\n\n` +
                        `🌐 *Your New Login Details*\n` +
                        `Username: \`${raw}\`\n` +
                        `Password: \`${user.hotspot_password}\`\n\n` +
                        `Connect at: *http://10.5.50.1*\n\n` +
                        `Reply *HI* for the main menu.`,
                });
            } catch (err) {
                console.error('Username change failed:', err.message);
                await updateSession(db, phone, 'start');
                await sock.sendMessage(from, {
                    text: `❌ Couldn't update your username right now. Please try again later or contact support (reply *6*).`,
                });
            }
            break;
        }

        // ──────────────────────────────────────────────────────────────────
        // CHANGE PASSWORD
        // ──────────────────────────────────────────────────────────────────
        case 'awaiting_new_password': {
            if (msgLower === '0') {
                await updateSession(db, phone, 'start');
                await sock.sendMessage(from, { text: `Cancelled. Reply *HI* for the main menu.` });
                break;
            }

            if (!isValidPassword(message)) {
                await sock.sendMessage(from, {
                    text: `❌ Password must be 6–50 characters. Try again or reply *0* to cancel:`,
                });
                break;
            }

            const newPass  = message;
            const username = user.hotspot_username || phone;
            const sub      = await getActiveSubscription(db, user.id);

            await sock.sendMessage(from, { text: `⏳ Updating your password...` });

            try {
                await provisionHotspotUser(username, sub.mikrotik_profile, newPass);
                await db.query(`UPDATE users SET hotspot_password = $1 WHERE id = $2`, [newPass, user.id]);
                await updateSession(db, phone, 'start');

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
                console.error('Password change failed:', err.message);
                await updateSession(db, phone, 'start');
                await sock.sendMessage(from, {
                    text: `❌ Couldn't update your password right now. Please try again later or contact support (reply *6*).`,
                });
            }
            break;
        }

        // Catch-all — always safe to return to menu
        default:
            await updateSession(db, phone, 'awaiting_service_selection', null, from);
            await sock.sendMessage(from, { text: buildWelcomeMessage(firstName) });
            break;
    }
}
