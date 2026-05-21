import pkg from 'mikronode-ng';
const { getConnection } = pkg;

// Generates a random 6-digit PIN for the Hotspot password
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
    const ip   = process.env.MIKROTIK_TUNNEL_IP;
    const port = parseInt(process.env.MIKROTIK_PORT) || 8728;
    const user = process.env.MIKROTIK_USER;
    const pass = process.env.MIKROTIK_PASS;

    const pin = existingPin || generatePin();

    return new Promise((resolve, reject) => {
        let conn;
        try {
            conn = getConnection(ip, port, user, pass);
        } catch (e) {
            return reject(e);
        }

        conn.on('error', (err) => {
            console.error('MikroTik connection error:', err);
            reject(err);
        });

        conn.on('connected', (connection) => {
            const channel = connection.openChannel('hotspot_provision');

            channel.on('done', () => {
                channel.close();
                connection.close();
                resolve(pin);
            });

            channel.on('error', (err) => {
                console.error('MikroTik channel error:', err);
                connection.close();
                reject(err);
            });

            // Try to add the user; if they already exist, update their password
            channel.write([
                '/ip/hotspot/user/add',
                `=name=${phone}`,
                `=password=${pin}`,
                `=profile=${profileName}`,
            ]);
        });
    });
}
