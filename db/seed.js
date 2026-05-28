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
        console.log("🌱 Truncating old plans...");
        await db.query('TRUNCATE TABLE plans RESTART IDENTITY CASCADE;');

        console.log("🌱 Inserting Chulo Speednet plans...");
        await db.query(`
            INSERT INTO plans (name, price, duration_days, mikrotik_profile) VALUES
            -- Single device (7/7_Mbps_1Users)
            ('1 Month - Single Device',  8000, 30, '7/7_Mbps_1Users'),
            ('2 Weeks - Single Device',  4400, 14, '7/7_Mbps_1Users'),
            ('1 Week - Single Device',   2200,  7, '7/7_Mbps_1Users'),
            ('3 Days - Single Device',   1200,  3, '7/7_Mbps_1Users'),
            ('1 Day - Single Device',     700,  1, '7/7_Mbps_1Users'),

            -- Two devices (7/7_Mbps_2Users)
            ('1 Month - Two Devices',   14000, 30, '7/7_Mbps_2Users'),
            ('2 Weeks - Two Devices',    8000, 14, '7/7_Mbps_2Users'),
            ('1 Week - Two Devices',     4000,  7, '7/7_Mbps_2Users'),
            ('3 Days - Two Devices',     2200,  3, '7/7_Mbps_2Users'),
            ('1 Day - Two Devices',      1300,  1, '7/7_Mbps_2Users'),

            -- Three devices (7/7_Mbps_3Users)
            ('1 Month - Three Devices', 21000, 30, '7/7_Mbps_3Users'),
            ('2 Weeks - Three Devices', 12000, 14, '7/7_Mbps_3Users'),
            ('1 Week - Three Devices',   6000,  7, '7/7_Mbps_3Users'),
            ('3 Days - Three Devices',   3300,  3, '7/7_Mbps_3Users'),
            ('1 Day - Three Devices',    2000,  1, '7/7_Mbps_3Users')
        `);

        console.log("✅ Plans seeded successfully!");
    } catch (e) {
        console.error("❌ Error seeding database:", e);
    } finally {
        await db.end();
    }
}

seed();
