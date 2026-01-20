// worker.mjs
import axios from "axios";
import { sendTopicPush } from "./fcm.mjs";

// ✅ En docker, lo normal es que sea "http://api:3000/..."
// Si lo corrés fuera de docker, podés usar localhost por env.
const ENDPOINT =
  process.env.CHECK_URL || "http://api:3000/api/cron/check-movements";

const INTERVAL_MS = Number(process.env.INTERVAL_MS || 60000);
const TOPIC = process.env.PUSH_TOPIC || "canjes";

let running = false;

function cleanRewardName(rewardName, recompensaRaw) {
  const base = String(rewardName || recompensaRaw || "").trim();
  return base.replace(/^\(\d+\)\s*/, "").replace(/\s+/g, " ").trim();
}

function buildBody(newItems = []) {
  if (!newItems.length) return "";

  const lines = newItems.slice(0, 3).map((it) => {
    const entidad = it.entidad || "Entidad";
    const cant = Number(it.cantidad || 1);
    const reward = cleanRewardName(it.rewardName, it.recompensa);

    return `• ${entidad}: ${cant}x ${reward}`;
  });

  const extra = newItems.length - lines.length;
  if (extra > 0) lines.push(`+${extra} más`);

  return lines.join("\n");
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

    if (Number(newCount) > 0) {
      console.log(`🚀 ${stamp} | NUEVOS: ${newCount}`);

      const body = buildBody(newItems);
      const title =
        Number(newCount) === 1 ? "Nuevo canje" : `${newCount} canjes nuevos`;

      console.log("📣 PUSH BODY:\n" + body);

      const last = newItems?.[0] ?? null;

      const pushId = await sendTopicPush({
        topic: TOPIC,
        title: "Grupo GEN Premios",
        body: body || "Hay nuevos canjes.",
        data: {
          type: "NEW_REDEEMS",
          newCount: String(newCount),
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
