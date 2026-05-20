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

        console.log("🌱 Inserting standard unlimited plans...");
        await db.query(`
            INSERT INTO plans (name, price, duration_days, data_limit_mb, speed_limit) 
            VALUES 
            ('Daily', 500, 1, 0, 'Unlimited'),
            ('Weekly', 3000, 7, 0, 'Unlimited'),
            ('Monthly', 8000, 30, 0, 'Unlimited')
        `);
        
        console.log("✅ Plans seeded successfully!");
    } catch (e) {
        console.error("❌ Error seeding database:", e);
    } finally {
        await db.end();
    }
}

seed();
