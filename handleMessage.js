export async function handleMessage(sock, from, text) {
    if (!text) return;

    const message = text.toLowerCase();

    if (message === "hi" || message === "hello") {
        await sock.sendMessage(from, {
            text: `Welcome to ISP Service\n\n1. Daily Plan - ₦500\n2. Weekly Plan - ₦3000\n3. Monthly Plan - ₦8000\n\nReply with option number`
        });
        return;
    }

    if (message === "1") {
        await sock.sendMessage(from, {
            text: "You selected DAILY plan. Proceeding to payment..."
        });
        return;
    }

    if (message === "2") {
        await sock.sendMessage(from, {
            text: "You selected WEEKLY plan. Proceeding to payment..."
        });
        return;
    }

    if (message === "3") {
        await sock.sendMessage(from, {
            text: "You selected MONTHLY plan. Proceeding to payment..."
        });
        return;
    }

    await sock.sendMessage(from, {
        text: "Invalid option. Send HI to start again."
    });
}