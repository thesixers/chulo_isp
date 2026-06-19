-- ENUM Types (safe idempotent creation — won't error if types already exist)
DO $$ BEGIN
    CREATE TYPE user_status AS ENUM ('active', 'inactive', 'banned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE payment_status AS ENUM ('pending', 'completed', 'failed', 'refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE subscription_status AS ENUM ('active', 'expired', 'cancelled', 'queued');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE subscription_status ADD VALUE IF NOT EXISTS 'queued'; EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE session_state AS ENUM (
        'start',
        'awaiting_service_selection',
        'awaiting_plan_selection',
        'awaiting_payment',
        'awaiting_support_message',
        'awaiting_hotspot_username',
        'awaiting_hotspot_password',
        'awaiting_new_username',
        'awaiting_new_password',
        'awaiting_device_selection'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Add new session states to existing DBs (safe — IF NOT EXISTS)
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_service_selection'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_support_message'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_hotspot_username'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_hotspot_password'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_new_username'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_new_password'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_device_selection'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_purchase_target'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_gift_username'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_hotspot_username_confirm'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_hotspot_password_confirm'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_new_username_confirm'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_new_password_confirm'; EXCEPTION WHEN others THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(200) UNIQUE,
    name VARCHAR(225),
    hotspot_username VARCHAR(50),   -- User-chosen MikroTik hotspot username
    hotspot_password VARCHAR(100),  -- User-chosen MikroTik hotspot password
    status user_status DEFAULT 'active',
    flutterwave_customer_id VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add hotspot credential columns to existing users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS hotspot_username VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS hotspot_password VARCHAR(100);

-- Ensure hotspot_username is unique case-sensitively (Jenny and JeNNy are different users)
DROP INDEX IF EXISTS idx_users_unique_hotspot_username;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_unique_hotspot_username ON users (hotspot_username) WHERE hotspot_username IS NOT NULL;

CREATE TABLE IF NOT EXISTS plans (
    id SERIAL PRIMARY KEY,
    name VARCHAR(225),
    price INTEGER,
    duration_days INTEGER,
    data_limit_mb INTEGER,
    speed_limit VARCHAR(100),
    mikrotik_profile VARCHAR(100) -- MikroTik hotspot profile name (e.g. '7/7_Mbps_1Users')
);

-- Add mikrotik_profile to existing plans table
ALTER TABLE plans ADD COLUMN IF NOT EXISTS mikrotik_profile VARCHAR(100);

CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    amount INTEGER,
    status payment_status DEFAULT 'pending',
    provider VARCHAR(225),
    method VARCHAR(20) DEFAULT 'transfer',  -- 'transfer' | 'cash' (admin manual activation)
    virtual_account_reference VARCHAR(100) UNIQUE, -- UUID from FLW dynamic VA; used for webhook lookup
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    paid_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    plan_id INTEGER REFERENCES plans(id),
    status subscription_status DEFAULT 'active',
    start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expiry_time TIMESTAMP,
    data_used_mb INTEGER DEFAULT 0,
    alert_sent BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS alert_sent BOOLEAN DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Session state for WhatsApp conversational flow
CREATE TABLE IF NOT EXISTS whatsapp_sessions (
    phone VARCHAR(200) PRIMARY KEY,
    state session_state DEFAULT 'start',
    plan_id INTEGER REFERENCES plans(id),
    remote_jid VARCHAR(100),              -- Exact Baileys JID (may be @lid format, not @s.whatsapp.net)
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add remote_jid to existing sessions table
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS remote_jid VARCHAR(100);
-- Add gift target user reference (NULL when buying for self)
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS gift_target_user_id INT REFERENCES users(id);
-- Temp staging columns for username/password confirmation flow
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS pending_username VARCHAR(50);
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS pending_password VARCHAR(10);

-- MikroTik provisioning retry queue
CREATE TABLE IF NOT EXISTS provisioning_queue (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER REFERENCES users(id),
    remote_jid       VARCHAR(100) NOT NULL,      -- WhatsApp JID to notify on success/failure
    phone            VARCHAR(200) NOT NULL,       -- MikroTik username
    mikrotik_profile VARCHAR(100) NOT NULL,
    plan_name        VARCHAR(225),
    pin              VARCHAR(10) NOT NULL,        -- Pre-generated PIN (consistent across retries)
    attempts         INTEGER DEFAULT 0,
    max_attempts     INTEGER DEFAULT 10,
    status           VARCHAR(20) DEFAULT 'pending', -- pending | completed | abandoned
    next_retry_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_attempted_at TIMESTAMP,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_prov_queue_pending ON provisioning_queue (status, next_retry_at);

-- =============================================================================
-- MIGRATION SCRIPT
-- Run these statements manually if you already have an existing database.
-- =============================================================================
-- Step 1: Drop old Paystack/static-account columns from users
-- ALTER TABLE users DROP COLUMN IF EXISTS paystack_customer_code;
-- ALTER TABLE users DROP COLUMN IF EXISTS virtual_account_reference;
-- ALTER TABLE users DROP COLUMN IF EXISTS virtual_account_number;
-- ALTER TABLE users DROP COLUMN IF EXISTS virtual_account_bank;
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS flutterwave_customer_id VARCHAR(100);

-- Step 2: Add dynamic VA reference to payments
-- ALTER TABLE payments ADD COLUMN IF NOT EXISTS virtual_account_reference VARCHAR(100) UNIQUE;

-- Step 3: Drop old session columns
-- ALTER TABLE whatsapp_sessions DROP COLUMN IF EXISTS temp_name;

-- Step 4: Remove unused session_state values (Postgres doesn't support DROP VALUE on ENUMs,
--         so if you previously ran the static migration, you can leave those values in place —
--         they'll simply go unused. Or recreate the type from scratch on a clean DB.)
