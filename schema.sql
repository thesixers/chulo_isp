-- ENUM Types (safe idempotent creation — won't error if types already exist)
DO $$ BEGIN
    CREATE TYPE user_status AS ENUM ('active', 'inactive', 'banned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE payment_status AS ENUM ('pending', 'completed', 'failed', 'refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE subscription_status AS ENUM ('active', 'expired', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE session_state AS ENUM ('start', 'awaiting_plan_selection', 'awaiting_payment');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(200) UNIQUE,
    name VARCHAR(225),
    status user_status DEFAULT 'active',
    flutterwave_customer_id VARCHAR(100),  -- FLW customer ID, auto-created on first contact
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS plans (
    id SERIAL PRIMARY KEY,
    name VARCHAR(225),
    price INTEGER,
    duration_days INTEGER,
    data_limit_mb INTEGER,
    speed_limit VARCHAR(100)
);

CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    amount INTEGER,
    status payment_status DEFAULT 'pending',
    provider VARCHAR(225),
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
    data_used_mb INTEGER DEFAULT 0
);

-- Session state for WhatsApp conversational flow
CREATE TABLE IF NOT EXISTS whatsapp_sessions (
    phone VARCHAR(200) PRIMARY KEY,
    state session_state DEFAULT 'start',
    plan_id INTEGER REFERENCES plans(id), -- Tracks which plan the user selected
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

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
