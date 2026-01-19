// worker-hit-endpoint.mjs
import axios from "axios";

const ENDPOINT =
  process.env.CHECK_URL || "http://localhost:3000/api/cron/check-movements";

let running = false;

async function tick() {
  if (running) return;
  running = true;

  try {
    const res = await axios.get(ENDPOINT, { timeout: 20000 });

    const stamp = new Date().toLocaleString();
    console.log(
      "✅",
      stamp,
      "| status:",
      res.status,
      "| newCount:",
      res.data?.newCount,
      "| baseline:",
      res.data?.baseline
    );
  } catch (e) {
    console.log("💥", new Date().toLocaleString(), "| error:", e.message);
  } finally {
    running = false;
  }
}

console.log("🚀 Worker (TEST) pegándole a:", ENDPOINT);
await tick();
setInterval(tick, 60_000);
