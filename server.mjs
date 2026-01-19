// server.mjs
import express from "express";
import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;

const BASE = "https://adm.agrcloud.com.ar";
const MOVEMENTS_URL =
  "/filtered/items/movements/details/service/2" +
  "?startDate=2026-01-01&endDate=2026-01-19T23:59:59&orderBy=date-desc";

// Estado persistente
const STATE_FILE = process.env.STATE_FILE || "./data/state.json";

// Lock para que no se pise si entran 2 requests
let running = false;

// -------------------------
// Utils state.json
// -------------------------
function ensureStateDir() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadState() {
  ensureStateDir();
  if (!fs.existsSync(STATE_FILE)) {
    return { initialized: false, lastSeenIds: [], updatedAt: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { initialized: false, lastSeenIds: [], updatedAt: null };
  }
}

function saveState(state) {
  ensureStateDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// -------------------------
// Parse helpers
// -------------------------
function extractToken(html) {
  const $ = cheerio.load(html);
  return $('input[name="__RequestVerificationToken"]').attr("value") || "";
}

function looksLikeLogin(html) {
  return (
    typeof html === "string" &&
    (html.includes('name="Username"') ||
      html.toLowerCase().includes("obtenga acceso a su cuenta") ||
      html.toLowerCase().includes("iniciar sesión"))
  );
}

function normalizeText(t) {
  return (t || "").trim().replace(/\s+/g, " ");
}

function parseRows(html) {
  const $ = cheerio.load(html);
  const rows = [];

  $("table tr").each((i, el) => {
    if (i === 0) return; // header
    const tds = $(el).find("td");
    if (tds.length < 5) return;

    const fecha = normalizeText($(tds[0]).text());
    const entidad = normalizeText($(tds[1]).text());
    const movimiento = normalizeText($(tds[2]).text());
    const documento = normalizeText($(tds[3]).text());
    const recompensa = normalizeText($(tds[4]).text());

    // Solo canjes (Egreso)
    if (movimiento.toLowerCase() !== "egreso") return;

    const receiptId = documento.match(/#(\d+)/)?.[1] || "UNK";
    const rewardId = recompensa.match(/\((\d+)\)/)?.[1] || "UNK";

    const externalId = `${entidad}|${receiptId}|${rewardId}`;

    rows.push({
      externalId,
      fecha,
      entidad,
      movimiento,
      documento,
      recompensa,
      receiptId,
      rewardId
    });
  });

  return rows;
}

// -------------------------
// AGR client
// -------------------------
async function loginAndFetchMovements() {
  const AGR_USER = process.env.AGR_USER;
  const AGR_PASS = process.env.AGR_PASS;
  if (!AGR_USER || !AGR_PASS) {
    throw new Error("Faltan AGR_USER / AGR_PASS en .env");
  }

  const jar = new CookieJar();

  // Cliente login
  const clientLogin = wrapper(
    axios.create({
      baseURL: BASE,
      jar,
      withCredentials: true,
      timeout: 20000,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 400
    })
  );

  // 1) GET SignIn + token
  const loginPage = await clientLogin.get("/Account/SignIn");
  const token = extractToken(loginPage.data);
  if (!token) throw new Error("No se encontró __RequestVerificationToken");

  // 2) POST SignIn
  const form = new URLSearchParams();
  form.set("Username", AGR_USER);
  form.set("Password", AGR_PASS);
  form.set("__RequestVerificationToken", token);

  const loginRes = await clientLogin.post("/Account/SignIn", form.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: BASE + "/Account/SignIn",
      Origin: BASE
    }
  });

  if (loginRes.status !== 302) {
    throw new Error(`Login no fue 302 (status=${loginRes.status})`);
  }

  const cookieStr = await jar.getCookieString(BASE);
  if (!cookieStr.includes(".AspNetCore.Cookies")) {
    throw new Error("No quedó .AspNetCore.Cookies (login falló)");
  }

  // Cliente fetch movimientos (con redirects)
  const clientFetch = wrapper(
    axios.create({
      baseURL: BASE,
      jar,
      withCredentials: true,
      timeout: 20000,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
      maxRedirects: 5
    })
  );

  const movRes = await clientFetch.get(MOVEMENTS_URL);

  if (looksLikeLogin(movRes.data)) {
    throw new Error("Movements devolvió login (sesión inválida)");
  }

  const rows = parseRows(movRes.data);
  return rows;
}

// -------------------------
// Endpoints
// -------------------------
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/api/cron/check-movements", async (req, res) => {
  if (running) {
    return res.status(429).json({
      ok: false,
      reason: "locked",
      message: "Ya hay un chequeo corriendo"
    });
  }

  running = true;

  try {
    const rows = await loginAndFetchMovements();

    const state = loadState();
    const seen = new Set(state.lastSeenIds || []);

    // First run = baseline (no spam)
    if (!state.initialized) {
      const latestIds = rows.slice(0, 50).map((r) => r.externalId);
      saveState({
        initialized: true,
        lastSeenIds: latestIds,
        updatedAt: new Date().toISOString()
      });

      return res.json({
        ok: true,
        baseline: true,
        newCount: 0,
        newItems: [],
        lastCount: rows.length
      });
    }

    // Nuevos (no vistos)
    const newItems = rows.filter((r) => !seen.has(r.externalId));

    // Actualizar estado (últimos 50)
    const latestIds = rows.slice(0, 50).map((r) => r.externalId);
    saveState({
      initialized: true,
      lastSeenIds: latestIds,
      updatedAt: new Date().toISOString()
    });

    return res.json({
      ok: true,
      baseline: false,
      newCount: newItems.length,
      newItems,
      lastCount: rows.length
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  } finally {
    running = false;
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server ON: http://localhost:${PORT}`);
  console.log(`✅ Health: http://localhost:${PORT}/health`);
  console.log(`✅ Endpoint: http://localhost:${PORT}/api/cron/check-movements`);
  console.log(`💾 State file: ${STATE_FILE}`);
});
