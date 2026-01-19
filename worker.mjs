// worker.mjs
import axios from "axios";
import { sendTopicPush } from "./fcm.mjs";

const ENDPOINT =
  process.env.CHECK_URL || "http://localhost:3000/api/cron/check-movements";

const INTERVAL_MS = Number(process.env.INTERVAL_MS || 60000);
const TOPIC = process.env.PUSH_TOPIC || "canjes";

let running = false;

function digestMessage(newItems) {
  if (!newItems?.length) return "";
  const last = newItems[0];
  return `${newItems.length} canjes nuevos. Último: ${last.documento} - ${last.recompensa}`;
}

async function tick() {
  if (running) return;
  running = true;

  try {
    const res = await axios.get(ENDPOINT, { timeout: 20000 });
    const data = res.data || {};
    const { baseline, newCount, newItems } = data;

    const stamp = new Date().toLocaleString();

    if (baseline) {
      console.log(`🟡 ${stamp} | Baseline (guardó estado)`);
      return;
    }

    if (newCount > 0) {
      console.log(`🚀 ${stamp} | NUEVOS: ${newCount}`);

      const msg = digestMessage(newItems);
      console.log("📣 DIGEST:", msg);

      // 🔥 PUSH REAL
      const title = "Grupo GEN Premios";
      const body = msg;

      // Data útil para deep-link luego
      const last = newItems?.[0] ?? null;

      const pushId = await sendTopicPush({
        topic: TOPIC,
        title,
        body,
        data: {
          type: "NEW_REDEEMS",
          newCount: newCount,
          lastReceipt: last?.receiptId ?? "",
          lastReward: last?.rewardId ?? "",
          lastEntity: last?.entidad ?? "",
        },
      });

      console.log("✅ PUSH enviado:", pushId);
    } else {
      console.log(`✅ ${stamp} | Sin nuevos`);
    }
  } catch (e) {
    console.log("💥", new Date().toLocaleString(), "| error:", e.message);
  } finally {
    running = false;
  }
}

console.log("🚀 Worker ON ->", ENDPOINT);
await tick();

// corre cada X ms (con jitter para no ser robot)
setInterval(() => {
  const jitter = Math.floor(Math.random() * 3000);
  setTimeout(tick, jitter);
}, INTERVAL_MS);
