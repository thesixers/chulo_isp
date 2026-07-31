import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new pg.Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
});

async function wipeAndSeed() {
  try {
    console.log("🧹 Dropping all tables...");
    await db.query(`
      DROP TABLE IF EXISTS message_queue CASCADE;
      DROP TABLE IF EXISTS provisioning_queue CASCADE;
      DROP TABLE IF EXISTS chat_sessions CASCADE;
      DROP TABLE IF EXISTS subscriptions CASCADE;
      DROP TABLE IF EXISTS payments CASCADE;
      DROP TABLE IF EXISTS plans CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
    `);

    console.log("🧹 Dropping custom types...");
    await db.query(`
      DROP TYPE IF EXISTS session_state CASCADE;
      DROP TYPE IF EXISTS subscription_status CASCADE;
      DROP TYPE IF EXISTS payment_status CASCADE;
      DROP TYPE IF EXISTS user_status CASCADE;
    `);

    console.log("🏗️ Recreating schema from schema.sql...");
    const schemaPath = path.join(__dirname, "schema.sql");
    const schemaSql = fs.readFileSync(schemaPath, "utf8");
    await db.query(schemaSql);
    console.log("✅ Schema created successfully!");

    console.log("🌱 Seeding plans...");
    await db.query(`
      INSERT INTO plans (id, name, price, duration_days, mikrotik_profile) VALUES
      (1, '1 Month - Single Device',  8000, 30, '7/7_Mbps_1Users'),
      (2, '2 Weeks - Single Device',  4400, 14, '7/7_Mbps_1Users'),
      (3, '1 Week - Single Device',   2200,  7, '7/7_Mbps_1Users'),
      (4, '3 Days - Single Device',   1200,  3, '7/7_Mbps_1Users'),
      (5, '1 Day - Single Device',     700,  1, '7/7_Mbps_1Users'),

      (6, '1 Month - Two Devices',   14000, 30, '7/7_Mbps_2Users'),
      (7, '2 Weeks - Two Devices',    8000, 14, '7/7_Mbps_2Users'),
      (8, '1 Week - Two Devices',     4000,  7, '7/7_Mbps_2Users'),
      (9, '3 Days - Two Devices',     2200,  3, '7/7_Mbps_2Users'),
      (10, '1 Day - Two Devices',      1300,  1, '7/7_Mbps_2Users'),

      (11, '1 Month - Three Devices', 21000, 30, '7/7_Mbps_3Users'),
      (12, '2 Weeks - Three Devices', 12000, 14, '7/7_Mbps_3Users'),
      (13, '1 Week - Three Devices',   6000,  7, '7/7_Mbps_3Users'),
      (14, '3 Days - Three Devices',   3300,  3, '7/7_Mbps_3Users'),
      (15, '1 Day - Three Devices',    2000,  1, '7/7_Mbps_3Users')
      ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          price = EXCLUDED.price,
          duration_days = EXCLUDED.duration_days,
          mikrotik_profile = EXCLUDED.mikrotik_profile
    `);
    await db.query("SELECT setval('plans_id_seq', (SELECT COALESCE(MAX(id), 1) FROM plans))");
    console.log("✅ Plans seeded successfully!");

    console.log("🎉 Database wipe and seed complete!");
  } catch (err) {
    console.error("❌ Wipe and seed failed:", err);
  } finally {
    await db.end();
  }
}

wipeAndSeed();
