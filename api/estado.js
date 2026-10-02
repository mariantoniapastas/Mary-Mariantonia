// Diagnóstico: números configurados, últimos pedidos y últimos errores.
// Uso: https://TU-PROYECTO.vercel.app/api/estado?clave=CRON_SECRET
import { redis } from "../lib/db.js";
import { SUC_IDS, ESTADOS, estaAbierta } from "../lib/negocio.js";

const digitos = (s) => String(s || "").replace(/\D/g, "");
const horaAR = (iso) => new Date(new Date(iso).getTime() - 3 * 3600e3).toISOString().slice(5, 16).replace("T", " ");

export async function GET(request) {
  const clave = new URL(request.url).searchParams.get("clave");
  if (!process.env.CRON_SECRET || clave !== process.env.CRON_SECRET) {
    return new Response("No autorizado", { status: 401 });
  }

  const sucursales = {};
  for (const id of SUC_IDS) {
    const configurado = digitos(process.env["SUCURSAL_" + id.toUpperCase()]);
    sucursales[id] = {
      numero_configurado: configurado || "(vacío)",
      numero_que_informo_meta: configurado ? (await redis.get(`waid:${id}:${configurado.slice(-10)}`)) || "(todavía no escribió)" : "-",
      abierta_ahora: estaAbierta(id),
    };
  }

  const ultimo = Number(await redis.get("pedido:seq")) || 0;
  const ids = [];
  for (let n = ultimo; n > 0 && ids.length < 10; n--) ids.push(`pedido:${1000 + n}`);
  const pedidos = (ids.length ? await redis.mget(...ids) : []).filter(Boolean).map((p) => ({
    id: p.id, cliente: p.cliente, sucursal: p.sucursal, estado: ESTADOS[p.estado] || p.estado,
    respondido_por_el_local: p.ack, historial: (p.historial || []).map((h) => `${horaAR(h.t)} ${h.evento}`),
  }));

  return Response.json({
    numero_backup: digitos(process.env.NUMERO_BACKUP) || "(vacío)",
    modelo: process.env.CLAUDE_MODEL || "claude-haiku-4-5",
    sucursales,
    ultimos_pedidos: pedidos,
    ultimos_errores: (await redis.lrange("errores", 0, 9)) || [],
  });
}
