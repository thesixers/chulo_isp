import pg from "pg";

const db = new pg.Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
});

const revenueCmd = async () => {
  try {
    const revenue = await db.query(
      `SELECT TO_CHAR(paid_at, 'Mon YYYY') AS month, 
      SUM(amount) AS total
       FROM payments
       WHERE status = 'completed'
       GROUP BY DATE_TRUNC('month', paid_at), 
       TO_CHAR(paid_at, 'Mon YYYY')
       ORDER BY DATE_TRUNC('month', paid_at);`
    );

    if (revenue.rows.length === 0) {
      console.log("No revenue data found.");
      return;
    }

    console.log("Revenue Data:");
    revenue.rows.forEach((row) => {
      console.log(`Month: ${row.month}, Total Revenue: ${row.total}`);
    });
  } catch (error) {
    console.error("Error fetching revenue data:", error);
  }finally{
    
  }
};

revenueCmd();