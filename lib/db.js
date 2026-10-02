// Base de datos: Upstash Redis (se conecta desde Vercel → Storage, plan gratuito).
import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const SIETE_DIAS = 7 * 24 * 3600;

// Conversaciones: una lista por chat, así dos mensajes seguidos no se pisan.
export async function turnos(clave) {
  return (await redis.lrange(clave, 0, -1)) || [];
}
export async function agregarTurno(clave, turno) {
  await redis.rpush(clave, { ...turno, t: Date.now() });
  await redis.ltrim(clave, -40, -1);
  await redis.expire(clave, SIETE_DIAS);
}
export async function ultimoTurno(clave) {
  return redis.lindex(clave, -1);
}

// Evita que dos procesos respondan el mismo chat a la vez.
export async function tomarTurno(clave) {
  return (await redis.set(`lock:${clave}`, "1", { nx: true, ex: 120 })) === "OK";
}
export async function soltarTurno(clave) {
  await redis.del(`lock:${clave}`);
}

// Meta a veces reenvía el mismo mensaje: lo procesamos una sola vez.
export async function esNuevo(messageId) {
  return (await redis.set(`msg:${messageId}`, "1", { nx: true, ex: 86400 })) === "OK";
}

// Últimos errores, para la página de diagnóstico.
export async function registrarError(texto) {
  try {
    await redis.lpush("errores", { t: new Date().toISOString(), texto: String(texto).slice(0, 500) });
    await redis.ltrim("errores", 0, 29);
  } catch {
    // si falla la base, no hay dónde anotarlo
  }
}

// Pedidos
export async function nuevoIdPedido() {
  return 1000 + (await redis.incr("pedido:seq"));
}
export async function leerPedido(id) {
  return redis.get(`pedido:${id}`);
}
export async function guardarPedido(p) {
  await redis.set(`pedido:${p.id}`, p);
  if (["entregado", "reemplazado", "rechazado"].includes(p.estado)) await redis.srem("pedidos:abiertos", p.id);
  else await redis.sadd("pedidos:abiertos", p.id);
}
export async function pedidosAbiertos() {
  const ids = (await redis.smembers("pedidos:abiertos")) || [];
  if (!ids.length) return [];
  const lista = await redis.mget(...ids.map((id) => `pedido:${id}`));
  return lista.filter(Boolean).sort((a, b) => a.id - b.id);
}
