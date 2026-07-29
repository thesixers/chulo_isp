import pg from "pg";
import dotenv from "dotenv";
import { provisionHotspotUser, buildMikrotikComment, removeActiveSessions } from "./src/mikrotik.js";

// Load environment variables from .env
dotenv.config();

const db = new pg.Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
});

async function runRecovery() {
  console.log("🔍 Scanning database for wrongfully deactivated users...");
  
  try {
    // Find subscriptions that have an expiry time in the future but are marked as 'expired'
    // (This catches users who were incorrectly cleaned up)
    const res = await db.query(`
      SELECT s.id AS sub_id, s.expiry_time, u.hotspot_username, u.hotspot_password, u.phone,
             p.mikrotik_profile, p.duration_days, p.name AS plan_name
      FROM subscriptions s
      JOIN users u ON u.id = s.user_id
      JOIN plans p ON p.id = s.plan_id
      WHERE s.status = 'expired' 
        AND s.expiry_time > NOW()
    `);

    if (res.rowCount === 0) {
      console.log("✅ Good news! No wrongfully deactivated users were found.");
      process.exit(0);
    }

    console.log(`⚠️ Found ${res.rowCount} users who were wrongfully deactivated. Recovering...`);

    let success = 0;
    let failed = 0;

    for (const row of res.rows) {
      if (!row.hotspot_username || !row.hotspot_password) continue;

      try {
        console.log(`🔄 Reactivating ${row.hotspot_username}...`);
        
        // 1. Kick them if they are stuck in a dead session
        try {
            await removeActiveSessions(row.hotspot_username);
        } catch(e) {} // ignore if they have no active session

        // 2. Re-provision them in the MikroTik router
        const comment = buildMikrotikComment(row.phone, row.duration_days, row.expiry_time);
        await provisionHotspotUser(
          row.hotspot_username,
          row.mikrotik_profile,
          row.hotspot_password,
          comment
        );

        // 3. Mark them as 'active' again in the database
        await db.query(
          `UPDATE subscriptions SET status = 'active' WHERE id = $1`,
          [row.sub_id]
        );
        
        console.log(`  ✅ Successfully restored ${row.hotspot_username} to ${row.plan_name}`);
        success++;
      } catch (err) {
        console.error(`  ❌ Failed to restore ${row.hotspot_username}:`, err.message);
        failed++;
      }
    }

    console.log(`\n🎉 Recovery Complete! Successfully reactivated ${success} users. (${failed} failed)`);
    process.exit(0);
  } catch (error) {
    console.error("❌ Database query failed:", error.message);
    process.exit(1);
  }
}

runRecovery();
