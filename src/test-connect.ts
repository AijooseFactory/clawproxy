import { GatewayClient } from "./lib/client";

async function main() {
    console.log("Connecting to gateway...");
    const client = new GatewayClient({
        url: "ws://127.0.0.1:19001",
        token: "720ed5796aed2fde4038dcec159aa6874469def130b7b201cea4efef057f3b2d"
    });
    try {
        const hello = await client.start();
        console.log("Connected!", hello);
        process.exit(0);
    } catch (err) {
        console.error("Failed to connect:", err);
        process.exit(1);
    }
}

main();
