import { RouterOSAPI } from 'node-routeros';

const TEST_USERNAME = 'test_chulo_user';
const TEST_PASSWORD = '123456';
const TEST_PROFILE  = '7/7_Mbps_1Users'; // Change if needed to match your router profile

async function getConn() {
    const conn = new RouterOSAPI({
        host:     process.env.MIKROTIK_TUNNEL_IP,
        user:     process.env.MIKROTIK_USER,
        password: process.env.MIKROTIK_PASS,
        port:     parseInt(process.env.MIKROTIK_PORT) || 8728,
        timeout:  10,
    });
    await conn.connect();
    return conn;
}

async function step1_createUser() {
    console.log(`\n1️⃣  Creating hotspot user: ${TEST_USERNAME}`);
    const conn = await getConn();
    try {
        await conn.write('/ip/hotspot/user/add', [
            `=name=${TEST_USERNAME}`,
            `=password=${TEST_PASSWORD}`,
            `=profile=${TEST_PROFILE}`,
        ]);
        console.log(`✅ User created — username: ${TEST_USERNAME}, password: ${TEST_PASSWORD}, profile: ${TEST_PROFILE}`);
    } catch (err) {
        if (err.message?.includes('already have')) {
            console.log(`⚠️  User already exists — continuing`);
        } else {
            throw err;
        }
    } finally {
        conn.close();
    }
}

async function step2_verifyUser() {
    console.log(`\n2️⃣  Verifying user exists on router...`);
    const conn = await getConn();
    const users = await conn.write('/ip/hotspot/user/print', [`?name=${TEST_USERNAME}`]);
    conn.close();

    if (!users.length) throw new Error(`User ${TEST_USERNAME} not found on router!`);

    console.log(`✅ Confirmed on router:`);
    console.log(`   Name:    ${users[0].name}`);
    console.log(`   Profile: ${users[0].profile}`);
    console.log(`   Password: ${users[0].password}`);
}

async function step3_updatePassword() {
    const newPin = '999888';
    console.log(`\n3️⃣  Simulating renewal — updating password to ${newPin}...`);
    const conn = await getConn();
    await conn.write('/ip/hotspot/user/set', [
        `=numbers=${TEST_USERNAME}`,
        `=password=${newPin}`,
    ]);
    conn.close();
    console.log(`✅ Password updated`);
}

async function step4_cleanup() {
    console.log(`\n4️⃣  Cleanup — removing test user...`);
    const conn = await getConn();
    await conn.write('/ip/hotspot/user/remove', [`=numbers=${TEST_USERNAME}`]);
    conn.close();
    console.log(`✅ Test user removed`);
}

async function run() {
    console.log('🧪 Hotspot User Provisioning Test');
    console.log(`   Router: ${process.env.MIKROTIK_TUNNEL_IP}:${process.env.MIKROTIK_PORT || 8728}`);
    console.log(`   Profile: ${TEST_PROFILE}`);

    await step1_createUser();
    await step2_verifyUser();
    await step3_updatePassword();
    // await step4_cleanup();

    console.log('\n🎉 All steps passed — hotspot provisioning is fully working!');
}

run().catch((err) => {
    console.error(`\n❌ Test failed: ${err.message}`);
    process.exit(1);
});
