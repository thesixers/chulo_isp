import { RouterOSAPI } from 'node-routeros';

function generatePin() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Connects to the MikroTik router via WireGuard tunnel and creates/updates a Hotspot user.
 * @param {string} phone          The user's phone number (used as username)
 * @param {string} profileName    The hotspot profile name (e.g. '7/7_Mbps_1Users')
 * @param {string} [existingPin]  Optional: reuse a specific PIN (for queue retries)
 * @returns {Promise<string>}     The PIN used
 */
export async function provisionHotspotUser(phone, profileName, existingPin = null) {
    const pin = existingPin || generatePin();

    const conn = new RouterOSAPI({
        host:     process.env.MIKROTIK_TUNNEL_IP,
        user:     process.env.MIKROTIK_USER,
        password: process.env.MIKROTIK_PASS,
        port:     parseInt(process.env.MIKROTIK_PORT) || 8728,
        timeout:  10, // seconds
    });

    await conn.connect();

    try {
        // Try to add the user; if they already exist, update their password instead
        try {
            await conn.write('/ip/hotspot/user/add', [
                `=name=${phone}`,
                `=password=${pin}`,
                `=profile=${profileName}`,
            ]);
        } catch (addErr) {
            // User already exists — update their password and profile
            if (addErr.message?.includes('already have')) {
                await conn.write('/ip/hotspot/user/set', [
                    `=numbers=${phone}`,
                    `=password=${pin}`,
                    `=profile=${profileName}`,
                ]);
            } else {
                throw addErr;
            }
        }
    } finally {
        conn.close();
    }

    return pin;
}
