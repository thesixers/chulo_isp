import { RouterOSAPI } from 'node-routeros';

async function testMikroTikConnection() {
    const ip   = process.env.MIKROTIK_TUNNEL_IP;
    const port = parseInt(process.env.MIKROTIK_PORT) || 8728;
    const user = process.env.MIKROTIK_USER;
    const pass = process.env.MIKROTIK_PASS;

    console.log(`⏳ Connecting to MikroTik at ${ip}:${port} as '${user}'...`);

    const conn = new RouterOSAPI({
        host:     ip,
        user:     user,
        password: pass,
        port:     port,
        timeout:  8,
    });

    await conn.connect();
    console.log('✅ Connected and authenticated!');

    const identity = await conn.write('/system/identity/print');
    console.log('\n📡 Router Identity:', identity);

    const resources = await conn.write('/system/resource/print');
    console.log('💻 System Resources:', {
        uptime:   resources[0]?.uptime,
        version:  resources[0]?.version,
        platform: resources[0]?.platform,
    });

    conn.close();
}

testMikroTikConnection()
    .then(() => {
        console.log('\n🎉 MikroTik test passed — WireGuard tunnel is working!');
        process.exit(0);
    })
    .catch((err) => {
        console.error(`\n❌ MikroTik test failed: ${err.message}`);
        process.exit(1);
    });
