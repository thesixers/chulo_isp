import { MikroNode } from 'mikronode-ng';

async function testMikroTikConnection() {
    const ip = process.env.MIKROTIK_TUNNEL_IP;
    const port = process.env.MIKROTIK_PORT || 8728;
    const user = process.env.MIKROTIK_USER;
    const pass = process.env.MIKROTIK_PASS;

    console.log(`⏳ Attempting to connect to MikroTik Router via WireGuard Tunnel at ${ip}:${port}...`);

    try {
        // Initialize the MikroNode connection
        const device = new MikroNode(ip, port);
        
        // Authenticate
        const [loginPromise, conn] = await device.connect(user, pass);
        
        console.log("✅ Successfully authenticated with MikroTik Router!");
        
        // Open a channel to send a command
        const channel = conn.openChannel("test_channel");
        
        // Listen for the response
        channel.on('done', (parsed) => {
            console.log("\n📡 Router Identity Details:");
            console.log(parsed.data);
            
            // Clean up and disconnect
            channel.close();
            conn.close();
            console.log("\n🔌 Disconnected successfully.");
            process.exit(0);
        });
        
        channel.on('error', (err) => {
            console.error("\n❌ Error running command:", err);
            conn.close();
            process.exit(1);
        });

        // Request the router's identity to prove the connection works
        console.log("▶️ Sending command: /system/identity/print");
        channel.write('/system/identity/print');

    } catch (error) {
        console.error("\n❌ Failed to connect to MikroTik. Make sure you are running this on the Oracle VM where the WireGuard tunnel is active.");
        console.error("Error details:", error.message || error);
        process.exit(1);
    }
}

testMikroTikConnection();
