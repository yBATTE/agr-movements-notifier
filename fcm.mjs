// fcm.mjs
import admin from "firebase-admin";
import fs from "fs";

let initialized = false;

function initFirebase() {
  if (initialized) return;

  const credPath = process.env.FIREBASE_CREDENTIALS;
  if (!credPath) {
    throw new Error("FIREBASE_CREDENTIALS no está definido en .env");
  }

  const raw = fs.readFileSync(credPath, "utf8");
  const serviceAccount = JSON.parse(raw);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  initialized = true;
}

export async function sendTopicPush({ topic, title, body, data = {} }) {
  initFirebase();

  // FCM exige data en string
  const safeData = {};
  for (const [k, v] of Object.entries(data)) safeData[k] = String(v);

  const message = {
    topic,
    notification: { title, body },
    data: safeData,
    android: { priority: "high" },
    apns: {
      headers: { "apns-priority": "10" },
      payload: { aps: { sound: "default" } },
    },
  };

  const id = await admin.messaging().send(message);
  return id;
}
