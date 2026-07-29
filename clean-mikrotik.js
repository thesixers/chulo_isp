import pg from "pg";
import dotenv from "dotenv";
import { RouterOSAPI } from "node-routeros";
import { removeActiveSessions } from "./src/mikrotik.js";

dotenv.config();

const db = new pg.Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
});

async function cleanMikrotik() {
  console.log("🔍 Connecting to MikroTik to find orphaned users...");

  const conn = new RouterOSAPI({
    host: process.env.MIKROTIK_TUNNEL_IP,
    user: process.env.MIKROTIK_USER,
    password: process.env.MIKROTIK_PASS,
    port: parseInt(process.env.MIKROTIK_PORT) || 8728,
    timeout: 30, // 30 seconds for fetching all users
  });

  try {
    await conn.connect();
    
    // Fetch all users in MikroTik
    const mikrotikUsers = await conn.write("/ip/hotspot/user/print");
    console.log(`📡 Found ${mikrotikUsers.length} users currently provisioned in MikroTik.`);

    let removedCount = 0;
    let skippedCount = 0;

    const ignoredUsers = [
      "default", "admin", "bambi", "chulo1", "dav", "musa", 
      "smart", "default-trial", "laptop", "success"
    ];

    for (const mkUser of mikrotikUsers) {
      const username = mkUser.name;
      
      // Ignore default admin or empty names, plus special protected users
      if (!username || ignoredUsers.includes(username.toLowerCase())) continue;

      // Check the database if this user has ANY active, future subscription
      const res = await db.query(`
        SELECT s.id 
        FROM subscriptions s
        JOIN users u ON u.id = s.user_id
        WHERE u.hotspot_username = $1 
          AND s.status = 'active' 
          AND s.expiry_time > NOW()
      `, [username]);

      if (res.rowCount === 0) {
        // This user is in MikroTik but has NO valid active subscription in the DB!
        console.log(`⚠️  User '${username}' has no active DB subscription. Removing from MikroTik...`);
        
        try {
          await removeActiveSessions(username); // Kick them off if they are browsing
          await conn.write("/ip/hotspot/user/remove", [`=.id=${mkUser[".id"]}`]);
          console.log(`   ✅ Successfully deleted '${username}' from MikroTik.`);
          removedCount++;
        } catch (err) {
          console.error(`   ❌ Failed to delete '${username}':`, err.message);
        }
      } else {
        // They have a valid subscription, leave them alone
        skippedCount++;
      }
    }

    console.log(`\n🎉 Cleanup Complete! Removed ${removedCount} orphaned users. (Skipped ${skippedCount} valid active users).`);
    process.exit(0);

  } catch (err) {
    console.error("❌ MikroTik connection failed:", err.message);
    process.exit(1);
  } finally {
    conn.close();
  }
}

cleanMikrotik();
