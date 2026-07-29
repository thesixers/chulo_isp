import pg from "pg";

const db = new pg.Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
});

async function syncPayments() {
  console.log("🔍 Scanning database for pending payments...");

  try {
    // Find all pending payments
    const res = await db.query(`
      SELECT p.id AS payment_id, p.virtual_account_reference AS tx_ref, 
             p.amount AS amount_paid, p.user_id, p.created_at, u.phone 
      FROM payments p
      JOIN users u ON u.id = p.user_id
      WHERE p.status = 'pending' 
        AND p.virtual_account_reference IS NOT NULL
    `);

    if (res.rowCount === 0) {
      console.log("✅ No pending payments found in the database.");
      process.exit(0);
    }

    console.log(`Found ${res.rowCount} pending payments. Checking with Flutterwave...`);

    let confirmedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const payment of res.rows) {
      const { payment_id, tx_ref, amount_paid, user_id, phone } = payment;
      console.log(`\n===========================================`);
      console.log(`🔄 Checking TX_REF: ${tx_ref} (User: ${phone})`);

      try {
        // 1. Verify with Flutterwave API
        const flwRes = await fetch(`https://api.flutterwave.com/v3/transactions?tx_ref=${tx_ref}`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
            "Content-Type": "application/json",
          },
        });

        const flwData = await flwRes.json();

        // 2. Check if the payment was successful on Flutterwave
        let isSuccessful = false;
        
        if (flwData.status === "success" && flwData.data && flwData.data.length > 0) {
            // Find any successful transaction matching this tx_ref
            const successfulTx = flwData.data.find(tx => tx.status === "successful");
            if (successfulTx) {
                isSuccessful = true;
            }
        }

        if (!isSuccessful) {
          console.log(`   ⏳ Transaction is still pending or failed on Flutterwave. Skipping.`);
          skippedCount++;
          continue;
        }

        console.log(`   💰 Payment CONFIRMED by Flutterwave!`);

        // 3. Check if an Admin has already activated this user manually 
        // (We check if there's any completed 'cash' payment AFTER this pending payment)
        const manualCheck = await db.query(`
            SELECT id FROM payments 
            WHERE user_id = $1 
              AND status = 'completed' 
              AND method = 'cash' 
              AND created_at > $2
            LIMIT 1
        `, [user_id, payment.created_at]);

        if (manualCheck.rowCount > 0) {
            console.log(`   ⚠️ Admin has already activated this user manually! Marking DB record as completed to prevent double-billing.`);
            // Just mark this pending payment as completed without triggering the webhook
            await db.query(`UPDATE payments SET status = 'completed' WHERE id = $1`, [payment_id]);
            confirmedCount++;
            continue;
        }

        console.log(`   🚀 User was NOT manually activated. Triggering Webhook automatically...`);
        
        // 4. Trigger the webhook manually to provision them on MikroTik & WhatsApp
        const payload = {
          "event.type": "BANK_TRANSFER_TRANSACTION",
          status: "successful",
          txRef: tx_ref,
          amount: amount_paid,
          data: {
            status: "successful",
            tx_ref: tx_ref,
            amount: amount_paid
          }
        };

        const webhookRes = await fetch('http://localhost:3003/webhook/flutterwave', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'verif-hash': process.env.FLW_SECRET_HASH
          },
          body: JSON.stringify(payload)
        });

        if (webhookRes.ok) {
            console.log(`   ✅ Successfully triggered Webhook! Bot should be messaging them now.`);
            confirmedCount++;
        } else {
            console.error(`   ❌ Failed to trigger Webhook (Status: ${webhookRes.status}). Is the bot running?`);
            failedCount++;
        }

      } catch (err) {
        console.error(`   ❌ Error verifying transaction: ${err.message}`);
        failedCount++;
      }
    }

    console.log(`\n🎉 Sync Complete! Confirmed/Processed: ${confirmedCount}, Still Pending: ${skippedCount}, Errors: ${failedCount}`);
    process.exit(0);

  } catch (error) {
    console.error("❌ Database query failed:", error.message);
    process.exit(1);
  }
}

syncPayments();
