import pg from "pg";

const db = new pg.Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
});

async function runMigration() {
  console.log("🚀 Starting database migration...");

  try {
    // 1. Rename whatsapp_sessions to chat_sessions if it exists under the old name
    const tableCheck = await db.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'whatsapp_sessions'
      );
    `);

    if (tableCheck.rows[0].exists) {
      console.log("📦 Renaming table whatsapp_sessions to chat_sessions...");
      await db.query("ALTER TABLE whatsapp_sessions RENAME TO chat_sessions;");
    } else {
      console.log("✅ Table whatsapp_sessions already renamed or does not exist.");
    }

    // 2. Add columns to chat_sessions safely
    console.log("⚙️  Adding columns to chat_sessions if they don't exist...");
    await db.query(`
      ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS telegram_chat_id VARCHAR(100);
      ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS preferred_platform VARCHAR(20) DEFAULT 'whatsapp';
      ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS gift_target_user_id INT REFERENCES users(id);
      ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pending_username VARCHAR(50);
      ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pending_password VARCHAR(10);
    `);

    // 3. Drop remote_jid column from provisioning_queue if it exists
    console.log("⚙️  Dropping unused columns from provisioning_queue...");
    await db.query("ALTER TABLE provisioning_queue DROP COLUMN IF EXISTS remote_jid;");

    // 4. Create the new offline message_queue table
    console.log("⚙️  Creating message_queue table if it doesn't exist...");
    await db.query(`
      CREATE TABLE IF NOT EXISTS message_queue (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(200) NOT NULL,
        message_text TEXT NOT NULL,
        send_to_both BOOLEAN DEFAULT false,
        attempts INTEGER DEFAULT 0,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_attempted_at TIMESTAMP
      );
    `);

    // Create index on message_queue status if it doesn't exist
    await db.query("CREATE INDEX IF NOT EXISTS idx_msg_queue_pending ON message_queue (status, created_at);");

    // 5. Ensure all new values are added to the session_state enum
    console.log("⚙️  Ensuring all new states exist in session_state enum...");
    const states = [
      "awaiting_service_selection",
      "awaiting_support_message",
      "awaiting_hotspot_username",
      "awaiting_hotspot_password",
      "awaiting_new_username",
      "awaiting_new_password",
      "awaiting_device_selection",
      "awaiting_purchase_target",
      "awaiting_gift_username",
      "awaiting_hotspot_username_confirm",
      "awaiting_hotspot_password_confirm",
      "awaiting_new_username_confirm",
      "awaiting_new_password_confirm"
    ];

    for (const state of states) {
      try {
        await db.query(`ALTER TYPE session_state ADD VALUE IF NOT EXISTS '${state}'`);
      } catch (err) {
        // Postgres sometimes throws if the value already exists depending on the version, ignore
      }
    }

    console.log("🎉 Database schema migration completed successfully!");

  } catch (err) {
    console.error("❌ Database migration failed:", err.message);
  } finally {
    await db.end();
  }
}

runMigration();
