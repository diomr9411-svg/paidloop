// Start PaidLoop with: npm start
import "reflect-metadata";
import { createApp } from "./app";
import { stopOcr } from "./capture";

async function main(): Promise<void> {
  const { app, services } = await createApp();
  // 127.0.0.1 keeps the owner screens on this computer only.
  const port = Number(process.env.PORT ?? 8000);
  await app.listen(port, "127.0.0.1");
  console.log(`PaidLoop runs at http://localhost:${port}  (PayPal: ${services.paypal.simulated ? "simulated" : "sandbox"})`);
  const stop = async (): Promise<void> => {
    await app.close();
    await stopOcr();
    services.db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

void main();
