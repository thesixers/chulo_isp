import pg from 'pg';

const db = new pg.Pool({
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
    port: process.env.PGPORT,
});

async function seed() {
    try {
        console.log("🌱 Upserting Chulo Speednet plans...");
        await db.query(`
            INSERT INTO plans (id, name, price, duration_days, mikrotik_profile) VALUES
            -- Single device (7/7_Mbps_1Users)
            (1, '1 Month - Single Device',  9000, 30, '7/7_Mbps_1Users'),
            (2, '2 Weeks - Single Device',  4800, 14, '7/7_Mbps_1Users'),
            (3, '1 Week - Single Device',   2400,  7, '7/7_Mbps_1Users'),
            (4, '3 Days - Single Device',   1400,  3, '7/7_Mbps_1Users'),
            (5, '1 Day - Single Device',     800,  1, '7/7_Mbps_1Users'),

            -- Two devices (7/7_Mbps_2Users)
            (6, '1 Month - Two Devices',   17000, 30, '7/7_Mbps_2Users'),
            (7, '2 Weeks - Two Devices',    9400, 14, '7/7_Mbps_2Users'),
            (8, '1 Week - Two Devices',     4700,  7, '7/7_Mbps_2Users'),
            (9, '3 Days - Two Devices',     2700,  3, '7/7_Mbps_2Users'),
            (10, '1 Day - Two Devices',      1500,  1, '7/7_Mbps_2Users'),

            -- Three devices (7/7_Mbps_3Users)
            (11, '1 Month - Three Devices', 25500, 30, '7/7_Mbps_3Users'),
            (12, '2 Weeks - Three Devices', 14000, 14, '7/7_Mbps_3Users'),
            (13, '1 Week - Three Devices',   7000,  7, '7/7_Mbps_3Users'),
            (14, '3 Days - Three Devices',   4000,  3, '7/7_Mbps_3Users'),
            (15, '1 Day - Three Devices',    2200,  1, '7/7_Mbps_3Users')
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                price = EXCLUDED.price,
                duration_days = EXCLUDED.duration_days,
                mikrotik_profile = EXCLUDED.mikrotik_profile
        `);

        // Reset the primary key sequence so next auto-incremental ID starts at 16
        await db.query("SELECT setval('plans_id_seq', (SELECT COALESCE(MAX(id), 1) FROM plans))");

        console.log("✅ Plans seeded/updated successfully!");
    } catch (e) {
        console.error("❌ Error seeding database:", e);
    } finally {
        await db.end();
    }
}

seed();
