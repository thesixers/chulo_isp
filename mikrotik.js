import pkg from 'mikronode-ng';
const { getConnection } = pkg;

// Generates a random 6-digit PIN for the Hotspot password
function generatePin() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Connects to the MikroTik router via WireGuard tunnel and creates a Hotspot user.
 * @param {string} phone The user's phone number (used as username)
 * @param {string} profileName The name of the hotspot profile (e.g., 'Daily', 'Weekly')
 * @returns {Promise<string>} The generated PIN
 */
export async function provisionHotspotUser(phone, profileName) {
    const ip = process.env.MIKROTIK_TUNNEL_IP;
    const port = process.env.MIKROTIK_PORT || 8728;
    const user = process.env.MIKROTIK_USER;
    const pass = process.env.MIKROTIK_PASS;

    const pin = generatePin();

    return new Promise(async (resolve, reject) => {
        try {
            const device = getConnection(ip, port);
            const [loginPromise, conn] = await device.connect(user, pass);
            
            const channel = conn.openChannel("hotspot_provision");
            
            channel.on('done', (parsed) => {
                channel.close();
                conn.close();
                resolve(pin); // Return the PIN so we can text it to the user
            });
            
            channel.on('error', (err) => {
                conn.close();
                console.error("MikroTik Router Error:", err);
                reject(err);
            });

            // Send the command to add the user. 
            // Note: The profileName MUST exist in the MikroTik router exactly as written.
            channel.write([
                '/ip/hotspot/user/add',
                `=name=${phone}`,
                `=password=${pin}`,
                `=profile=${profileName}`
            ]);
            
        } catch (error) {
            console.error("Failed to connect to MikroTik over WireGuard:", error);
            reject(error);
        }
    });
}
