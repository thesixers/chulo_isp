import { createDynamicVirtualAccount } from './flutterwave.js';
import { fulfillPayment } from './fulfillPayment.js';

// ---------------------------------------------------------
// DATABASE HELPER FUNCTIONS
// ---------------------------------------------------------

/**
 * Ensures the user row exists in the DB.
 * Does NOT call Flutterwave — FLW customer creation is deferred to the 'hi' handler.
 */
async function upsertUser(db, phone) {
    let res = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);

    if (res.rows.length === 0) {
        res = await db.query(
            `INSERT INTO users (phone) VALUES ($1) RETURNING *`,
            [phone]
        );
    } else {
        res = await db.query(
            `UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE phone = $1 RETURNING *`,
            [phone]
        );
    }

    return res.rows[0];
}

async function getSession(db, phone) {
    const res = await db.query(
        'SELECT state, plan_id FROM whatsapp_sessions WHERE phone = $1',
        [phone]
    );
    return res.rows.length > 0 ? res.rows[0] : { state: 'start', plan_id: null };
}

async function updateSession(db, phone, state, planId = null) {
    await db.query(`
        INSERT INTO whatsapp_sessions (phone, state, plan_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (phone) DO UPDATE
        SET state        = EXCLUDED.state,
            plan_id      = COALESCE(EXCLUDED.plan_id, whatsapp_sessions.plan_id),
            last_updated = CURRENT_TIMESTAMP
    `, [phone, state, planId]);
}

async function getPlan(db, id) {
    const res = await db.query('SELECT id, name, price FROM plans WHERE id = $1', [id]);
    return res.rows.length > 0 ? res.rows[0] : null;
}

async function getAllPlans(db) {
    const res = await db.query('SELECT id, name, price FROM plans ORDER BY id ASC');
    return res.rows;
}
// ---------------------------------------------------------

export async function handleMessage(sock, from, text, db) {
    if (!text) return;

    const message = text.trim();
    const messageLower = message.toLowerCase();
    const phone = from.split('@')[0];

    const user = await upsertUser(db, phone);
    const session = await getSession(db, phone);

    // Global reset — "hi" or "hello" always brings up the plan menu
    if (messageLower === 'hi' || messageLower === 'hello') {
        await updateSession(db, phone, 'awaiting_plan_selection');

        const plans = await getAllPlans(db);
        let planText = plans.map(p => `${p.id}. ${p.name} Plan - ₦${p.price}`).join('\n');
        if (!planText) planText = 'No active plans available at the moment.';

        await sock.sendMessage(from, {
            text: `Welcome to Chulo ISP! 🚀\n\nPlease select a data plan:\n${planText}\n\nReply with the option number.`,
        });
        return;
    }

    switch (session.state) {

        // ------------------------------------------------------------------
        // STEP 1: User picks a plan → generate a dynamic virtual account
        // ------------------------------------------------------------------
        case 'awaiting_plan_selection': {
            const planId = parseInt(message, 10);
            if (isNaN(planId)) {
                await sock.sendMessage(from, {
                    text: `Invalid option. Please reply with a plan number, or send *HI* to see the list again.`,
                });
                return;
            }

            const selectedPlan = await getPlan(db, planId);
            if (!selectedPlan) {
                await sock.sendMessage(from, {
                    text: `Invalid option. Please reply with a valid plan number, or send *HI* to see the list again.`,
                });
                return;
            }

            await sock.sendMessage(from, {
                text: `⏳ Generating your payment account for the *${selectedPlan.name}* plan...`,
            });

            try {
                // Create a dynamic virtual account for this exact transaction (v3 API)
                const { txRef, accountNumber, bankName } = await createDynamicVirtualAccount(
                    phone,
                    selectedPlan.price,
                    selectedPlan.name
                );

                // Record the pending payment — txRef links this payment to the webhook
                await db.query(`
                    INSERT INTO payments (user_id, amount, provider, status, virtual_account_reference)
                    VALUES ($1, $2, 'flutterwave', 'pending', $3)
                `, [user.id, selectedPlan.price, txRef]);

                // Advance session state and store chosen plan
                await updateSession(db, phone, 'awaiting_payment', selectedPlan.id);

                await sock.sendMessage(from, {
                    text: `You selected the *${selectedPlan.name}* plan.\n\nPlease transfer exactly *₦${selectedPlan.price}* to:\n\n🏦 Bank: *${bankName}*\n💳 Account Number: *${accountNumber}*\n\n⏱ This account expires in *1 hour*. Your plan activates automatically once payment is received!`,
                });

            } catch (err) {
                console.error('Dynamic VA creation error:', err);
                await sock.sendMessage(from, {
                    text: `❌ We couldn’t generate a payment account right now. Please send *HI* to try again.`,
                });
            }
            break;
        }

        // ------------------------------------------------------------------
        // STEP 2: Awaiting payment (webhook handles this automatically;
        //         "paid" is a manual fallback in case the webhook is delayed)
        // ------------------------------------------------------------------
        case 'awaiting_payment': {
            if (messageLower === 'paid') {
                await sock.sendMessage(from, {
                    text: `⏳ Verifying your payment... Please wait a moment.`,
                });

                try {
                    const freshUserRes = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);
                    await fulfillPayment(db, sock, freshUserRes.rows[0]);
                } catch (err) {
                    console.error('Manual payment fulfillment error:', err);
                    await sock.sendMessage(from, {
                        text: `❌ Something went wrong while activating your plan. Please contact support or send *HI* to try again.`,
                    });
                }
            } else {
                await sock.sendMessage(from, {
                    text: `⏳ Waiting for your payment. Once the transfer is complete it activates automatically.\n\nReply *PAID* if you've transferred and it hasn't activated, or send *HI* to cancel and start over.`,
                });
            }
            break;
        }

        default:
            await sock.sendMessage(from, { text: `Type *HI* to see available plans.` });
            break;
    }
}
