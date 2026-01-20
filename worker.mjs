// worker.mjs
import axios from "axios";
import { sendTopicPush } from "./fcm.mjs";

// ✅ En docker, lo normal es que sea "http://api:3000/..."
// Si lo corrés fuera de docker, podés usar localhost por env.
const ENDPOINT =
  process.env.CHECK_URL || "http://api:3000/api/cron/check-movements";

const INTERVAL_MS = Number(process.env.INTERVAL_MS || 60000);
const TOPIC = process.env.PUSH_TOPIC || "canjes";

// ✅ Trigger scraper cuando hay nuevos canjes
const TRIGGER_SCRAPER_ON_NEW =
  String(process.env.TRIGGER_SCRAPER_ON_NEW || "1") === "1";

// ✅ Por defecto: run-movements (más liviano que run-all)
// Podés cambiarlo por env: SCRAPER_ENDPOINT=http://agr-scrapers:8080/run-all
const SCRAPER_ENDPOINT =
  process.env.SCRAPER_ENDPOINT || "http://agr-scrapers:8080/run-movements";

// ✅ Timeout para el scraper (default 5 min)
const SCRAPER_TIMEOUT_MS = Number(process.env.SCRAPER_TIMEOUT_MS || 300000);

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

async function triggerScraper() {
  if (!TRIGGER_SCRAPER_ON_NEW) return;

  const stamp = new Date().toLocaleString();
  console.log(`🕷️ ${stamp} | Trigger Scraper -> ${SCRAPER_ENDPOINT}`);

  try {
    const res = await axios.get(SCRAPER_ENDPOINT, {
      timeout: SCRAPER_TIMEOUT_MS,
    });

    const txt =
      typeof res.data === "string"
        ? res.data
        : JSON.stringify(res.data || {});

    console.log(`✅ ${stamp} | Scraper OK -> ${txt}`);
  } catch (e) {
    console.log(
      "💥",
      new Date().toLocaleString(),
      "| Scraper error:",
      e?.message || e
    );
  }
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

      // ✅ después del push, dispara el scraper (para que la app vea datos actualizados)
      await triggerScraper();
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
console.log("🧩 Topic ->", TOPIC);

if (TRIGGER_SCRAPER_ON_NEW) {
  console.log("🕷️ Trigger ON ->", SCRAPER_ENDPOINT);
} else {
  console.log("🕷️ Trigger OFF");
}

await tick();

// corre cada X ms (con jitter para no ser robot)
setInterval(() => {
  const jitter = Math.floor(Math.random() * 3000);
  setTimeout(tick, jitter);
}, INTERVAL_MS);
