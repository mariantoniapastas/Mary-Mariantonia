// La llama cron-job.org cada 5 minutos: reenvía pedidos sin respuesta y avisa al backup.
// Uso: https://TU-PROYECTO.vercel.app/api/revisar?clave=CRON_SECRET
import { revisarPendientes } from "../lib/flujo.js";

export async function GET(request) {
  const clave = new URL(request.url).searchParams.get("clave");
  if (!process.env.CRON_SECRET || clave !== process.env.CRON_SECRET) {
    return new Response("No autorizado", { status: 401 });
  }
  const hechos = await revisarPendientes();
  return Response.json({ ok: true, hechos });
}
