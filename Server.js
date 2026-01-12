const express = require('express');
const { createClient } = require('@libsql/client');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// --- 1. CONNECT TO TURSO DATABASE ---
// We use Environment Variables for security (Set these in Render Dashboard!)
const dbUrl = process.env.TURSO_DATABASE_URL;
const dbToken = process.env.TURSO_AUTH_TOKEN;

if (!dbUrl || !dbToken) {
  console.error("⚠️ WARNING: Turso variables (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN) are missing.");
}

const turso = createClient({
  url: dbUrl || 'libsql://dummy-url',
  authToken: dbToken || 'dummy-token',
});

// --- 2. INITIALIZE TABLE ---
// We make 'hardware_key' UNIQUE. This does the heavy lifting:
// It prevents duplicates automatically without complex code.
async function initDB() {
  try {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hardware_key TEXT UNIQUE,
        first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        ip_address TEXT
      )
    `);
    console.log("✅ Connected to Turso. Table 'users' is ready.");
  } catch (err) {
    console.error("❌ Database Init Failed:", err);
  }
}
initDB();

// Middleware to parse the "curl -d" data
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- 3. MAIN ROUTE ---
app.get('/', (req, res) => {
    res.send('Activation Server Running. Use POST /activate');
});

app.post('/activate', async (req, res) => {
    const key = req.body.key;
    // Capture IP for security logs
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!key) {
        return res.status(400).json({ status: "error", message: "No key provided" });
    }

    console.log(`[INCOMING] Activation request for: ${key}`);

    try {
        // STEP A: Try to insert the key (Add +1 User)
        // If key exists, this will FAIL with a constraint error.
        try {
            await turso.execute({
                sql: "INSERT INTO users (hardware_key, ip_address) VALUES (?, ?)",
                args: [key, userIp]
            });
            console.log(`🆕 NEW USER ADDED! Key: ${key}`);
        } catch (insertError) {
            // Check if it failed because it's a duplicate
            if (insertError.message && insertError.message.includes('UNIQUE constraint')) {
                console.log(`ℹ️ User already exists. Updating 'last_seen' timestamp.`);
                // Optional: Update the last_seen time so you know they are still active
                await turso.execute({
                    sql: "UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE hardware_key = ?",
                    args: [key]
                });
            } else {
                // If it's a real error (like DB down), throw it up
                throw insertError; 
            }
        }

        // STEP B: Count Total Unique Users
        // We do this every time so the response is always accurate
        const countResult = await turso.execute("SELECT COUNT(*) as total FROM users");
        const totalUsers = countResult.rows[0].total; // Turso returns rows array

        console.log(`📊 Total Unique Users: ${totalUsers}`);

        // STEP C: Return Success + Count
        res.json({ 
            status: "success", 
            message: "Activation Validated",
            total_users: totalUsers // <--- This tells you the count
        });

    } catch (err) {
        console.error("❌ Database Error:", err);
        // Even if DB errors, we try not to crash the Pascal app unless critical
        res.status(500).json({ status: "error", message: "Internal Server Error" });
    }
});

// Start Server
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});