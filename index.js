import vibe from "vibe-gx"
import { handleMessage }from "./handleMessage.js"
import { connectToWhatsApp } from "./whatsapp-connect.js"

const app = vibe({
    logger: {
    lifecycle: true,
    prettyPrint: process.env.NODE_ENV !== "production",
  },
})

async function startBot() {
    const sock = await connectToWhatsApp(handleMessage);
}

app.get("/", "Welcome to chulos isp")

app.listen(3000, () => {
  startBot()
})