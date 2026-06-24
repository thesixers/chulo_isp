import { RouterOSAPI } from "node-routeros";

const testRemoval = async (username) => {
  const conn = new RouterOSAPI({
    host: process.env.MIKROTIK_TUNNEL_IP,
    user: process.env.MIKROTIK_USER,
    password: process.env.MIKROTIK_PASS,
    port: parseInt(process.env.MIKROTIK_PORT) || 8728,
    timeout: 10, // seconds
  });

  await conn.connect();

  try {
    // NOTE: Don't use ?user= filter — MikroTik returns !empty when no match,
    // which node-routeros throws inside an event emitter (bypasses try/catch).
    // Fetch all sessions and filter client-side instead.
    const allSessions = await conn.write("/ip/hotspot/active/print");
    const sessions = (allSessions || []).filter((s) => s.user === username);
    console.log(sessions);

    for (const session of sessions) {
      await conn.write("/ip/hotspot/active/remove", [`=.id=${session[".id"]}`]);
    }

    console.log("Sessions removed successfully");
  } catch (err) {
    console.log("error occured", err.message, err.errno, err);
  } finally {
    conn.close();
  }
};

testRemoval("Az_0");
