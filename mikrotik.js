import { RouterOSAPI } from 'node-routeros';

/**
 * Builds the MikroTik comment string from plan duration and expiry date.
 * Format: "1M 25 May 10pm"  |  "1W 3 Jun 8am"  |  "3D 24 May 2pm"  |  "1D 23 May 6pm"
 * @param {number} durationDays  - Plan duration in days
 * @param {Date|string} expiry   - Expiry timestamp
 * @returns {string}
 */
export function buildMikrotikComment(durationDays, expiry) {
    let code;
    if      (durationDays >= 28) code = '1M';
    else if (durationDays >= 14) code = '2W';
    else if (durationDays >= 7)  code = '1W';
    else if (durationDays >= 3)  code = '3D';
    else                         code = '1D';

    const d     = new Date(expiry);
    const day   = d.getDate();
    const month = d.toLocaleString('en-GB', { month: 'short' });
    const h24   = d.getHours();
    const h12   = h24 % 12 || 12;
    const ampm  = h24 >= 12 ? 'pm' : 'am';

    return `${code} ${day} ${month} ${h12}${ampm}`; // e.g. "1M 25 May 10pm"
}

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
export async function provisionHotspotUser(phone, profileName, existingPin = null, comment = null) {
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
            const addParams = [
                `=name=${phone}`,
                `=password=${pin}`,
                `=profile=${profileName}`,
            ];
            if (comment) addParams.push(`=comment=${comment}`);
            await conn.write('/ip/hotspot/user/add', addParams);
        } catch (addErr) {
            // User already exists — update their password, profile, and comment
            if (addErr.message?.includes('already have')) {
                const setParams = [
                    `=numbers=${phone}`,
                    `=password=${pin}`,
                    `=profile=${profileName}`,
                ];
                if (comment) setParams.push(`=comment=${comment}`);
                await conn.write('/ip/hotspot/user/set', setParams);
            } else {
                throw addErr;
            }
        }
    } finally {
        conn.close();
    }

    return pin;
}

/**
 * Removes a hotspot user from MikroTik (used when their subscription expires).
 * Silently ignores 'no such item' errors — user may already be gone.
 * @param {string} username - The hotspot username to remove
 */
export async function removeHotspotUser(username) {
    const conn = new RouterOSAPI({
        host:     process.env.MIKROTIK_TUNNEL_IP,
        user:     process.env.MIKROTIK_USER,
        password: process.env.MIKROTIK_PASS,
        port:     parseInt(process.env.MIKROTIK_PORT) || 8728,
        timeout:  10,
    });

    await conn.connect();
    try {
        await conn.write('/ip/hotspot/user/remove', [`=numbers=${username}`]);
        console.log(`🗑️  MikroTik: removed expired user '${username}'`);
    } catch (err) {
        // Ignore if user doesn't exist on MikroTik
        if (!err.message?.toLowerCase().includes('no such item')) {
            throw err;
        }
        console.warn(`⚠️  MikroTik: user '${username}' not found — already removed`);
    } finally {
        conn.close();
    }
}
