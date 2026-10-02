// Meta llama a esta dirección cada vez que llega un mensaje de WhatsApp.
import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { procesarEntrada } from "../lib/flujo.js";
import { registrarError } from "../lib/db.js";

// Verificación inicial que hace Meta al configurar el webhook.
export function GET(request) {
  const u = new URL(request.url);
  if (u.searchParams.get("hub.mode") === "subscribe" && u.searchParams.get("hub.verify_token") === process.env.WEBHOOK_VERIFY_TOKEN) {
    return new Response(u.searchParams.get("hub.challenge"));
  }
  return new Response("No autorizado", { status: 403 });
}

function firmaValida(cuerpo, firma) {
  if (!firma) return false;
  const esperada = "sha256=" + crypto.createHmac("sha256", process.env.APP_SECRET).update(cuerpo).digest("hex");
  const a = Buffer.from(esperada), b = Buffer.from(firma);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(request) {
  const cuerpo = await request.text();
  if (process.env.APP_SECRET && !firmaValida(cuerpo, request.headers.get("x-hub-signature-256"))) {
    return new Response("Firma inválida", { status: 401 });
  }
  let body;
  try { body = JSON.parse(cuerpo); } catch { return new Response("ok"); }
  // Respondemos enseguida a Meta y procesamos el mensaje en segundo plano.
  waitUntil(procesarEntrada(body).catch(async (e) => {
    console.error("Error procesando mensaje:", e);
    await registrarError(`Error procesando mensaje: ${e.message}`);
  }));
  return new Response("ok");
}
