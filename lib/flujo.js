// Lo que pasa con cada mensaje: clientes, sucursales, pedidos, reintentos y avisos al backup.
import * as wa from "./whatsapp.js";
import { redis, turnos, agregarTurno, ultimoTurno, tomarTurno, soltarTurno, esNuevo, nuevoIdPedido, leerPedido, guardarPedido, pedidosAbiertos } from "./db.js";
import {
  SUC, SUC_IDS, ESTADOS, CERRADOS, estaAbierta, retiroTexto, plata, cantidadTexto, totalPedido, buscarProducto,
  reglasClienteFijas, reglasClienteVariables, reglasSucursal, burbujas, hoyISO,
} from "./negocio.js";
import { pensar } from "./mary.js";

const MIN_RECORDATORIO = Number(process.env.MINUTOS_RECORDATORIO || 15);
const soloDigitos = (s) => String(s || "").replace(/\D/g, "");
const ult10 = (s) => soloDigitos(s).slice(-10);
const hist = (p, evento) => { (p.historial ||= []).push({ t: new Date().toISOString(), evento }); };
const nombreDe = (p) => p.cliente.split(" ")[0];

/* ---------- quién escribe ---------- */
export function sucursalDe(waid) {
  return SUC_IDS.find((id) => {
    const n = process.env["SUCURSAL_" + id.toUpperCase()];
    return n && ult10(n) === ult10(waid);
  }) || null;
}
async function numeroSucursal(suc) {
  const guardado = await redis.get(`waid:${suc}`);
  return guardado ? String(guardado) : soloDigitos(process.env["SUCURSAL_" + suc.toUpperCase()]);
}
export async function avisarBackup(texto) {
  const n = soloDigitos(process.env.NUMERO_BACKUP);
  if (!n) return console.warn("Falta NUMERO_BACKUP. Aviso:", texto);
  try { await wa.enviarTexto(n, texto); } catch (e) { console.error("No pude avisar al backup:", e.message); }
}

/* ---------- agotados del día ---------- */
const claveAgotados = (suc) => `agotados:${suc}:${hoyISO()}`;
async function agotados() {
  const out = {};
  for (const id of SUC_IDS) out[id] = (await redis.smembers(claveAgotados(id))) || [];
  return out;
}

/* =========================================================
   Entrada: lo que manda Meta al webhook
   ========================================================= */
function leerMensaje(m) {
  switch (m.type) {
    case "text": return { texto: m.text.body };
    case "interactive": {
      const r = m.interactive.button_reply || m.interactive.list_reply;
      return { boton: r?.id, titulo: r?.title, texto: r?.title || "" };
    }
    case "button": return { texto: m.button.text };
    case "audio": return { audio: true };
    case "image": return { texto: "[Mandó una foto]" + (m.image.caption ? ` ${m.image.caption}` : "") };
    case "sticker": return { texto: "[Mandó un sticker]" };
    case "location": return { texto: "[Compartió una ubicación]" };
    default: return { texto: `[Mandó un mensaje de tipo ${m.type}]` };
  }
}

export async function procesarEntrada(body) {
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      for (const s of v.statuses || []) {
        if (s.status === "failed") console.error("Mensaje no entregado a", s.recipient_id, JSON.stringify(s.errors));
      }
      for (const m of v.messages || []) {
        if (!(await esNuevo(m.id))) continue;
        await wa.marcarLeido(m.id);
        const msg = { ...leerMensaje(m), contexto: m.context?.id };
        const suc = sucursalDe(m.from);
        if (suc) await mensajeDeSucursal(suc, m.from, msg);
        else await mensajeDeCliente(m.from, msg);
      }
    }
  }
}

/* =========================================================
   Clientes
   ========================================================= */
const chatCli = (waid) => `chat:${waid}`;

async function mensajeDeCliente(waid, msg) {
  if (msg.audio) {
    const r = "Ay tesoro, todavía no puedo escuchar audios 🙈 ¿Me lo escribís? Así no se me pasa nada 💛";
    await agregarTurno(chatCli(waid), { role: "user", content: "[Mandó un audio]" });
    await agregarTurno(chatCli(waid), { role: "assistant", content: r });
    return wa.enviarTexto(waid, r);
  }
  if (msg.texto.trim().toLowerCase() === "#reiniciar") {
    await redis.del(chatCli(waid));
    return wa.enviarTexto(waid, "🔄 Conversación reiniciada (modo prueba).");
  }
  await agregarTurno(chatCli(waid), { role: "user", content: msg.texto });
  await atenderCliente(waid);
}

async function atenderCliente(waid, vuelta = 0) {
  const clave = chatCli(waid);
  if (!(await tomarTurno(clave))) return; // ya hay otro proceso respondiendo: va a ver este mensaje
  try {
    for (let i = 0; i < 3; i++) {
      const ts = await turnos(clave);
      if (!ts.length || ts[ts.length - 1].role !== "user") break;
      const respuesta = await pensar({ fijo: reglasClienteFijas(), variable: reglasClienteVariables(await agotados()), turnos: ts });
      await agregarTurno(clave, { role: "assistant", content: respuesta });
      for (const b of burbujas(respuesta)) await wa.enviarTexto(waid, b);
      await etiquetasCliente(respuesta, waid);
    }
  } finally {
    await soltarTurno(clave);
  }
  const ult = await ultimoTurno(clave);
  if (ult?.role === "user" && vuelta < 2) await atenderCliente(waid, vuelta + 1);
}

async function decirleAlCliente(waid, texto) {
  await agregarTurno(chatCli(waid), { role: "assistant", content: texto });
  try { await wa.enviarTexto(waid, texto); } catch (e) { await avisarBackup(`⚠️ No le pude escribir al cliente +${waid}: ${e.message}`); }
}
async function avisoInterno(waid, texto) {
  await agregarTurno(chatCli(waid), { role: "user", content: "[AVISO INTERNO] " + texto });
  await atenderCliente(waid);
}
async function pedidosDelChat(waid) {
  return (await pedidosAbiertos()).filter((p) => p.waid === waid);
}

async function etiquetasCliente(texto, waid) {
  for (const m of texto.matchAll(/<pedido>([\s\S]*?)<\/pedido>/g)) {
    let data;
    try { data = JSON.parse(m[1]); } catch {
      await avisarBackup(`⚠️ Mary intentó registrar un pedido de +${waid} pero el formato vino mal. Revisá esa charla.`);
      continue;
    }
    await crearPedido(data, waid);
  }
  const sub = texto.match(/<suscripcion>\s*(si|sí|no)\s*<\/suscripcion>/i);
  if (sub) {
    const v = /no/i.test(sub[1]) ? "no" : "si";
    await redis.set(`novedades:${waid}`, { respuesta: v, fecha: new Date().toISOString() });
    if (v === "si") await redis.sadd("novedades:suscriptos", waid);
    else await redis.srem("novedades:suscriptos", waid);
  }
  const can = texto.match(/<cancelar>([\s\S]*?)<\/cancelar>/);
  if (can) {
    for (const p of await pedidosDelChat(waid)) {
      p.estado = "rechazado"; p.rechazo = p.sinStock ? "sin_stock" : "otro"; p.motivo = can[1].trim() || "Cancelado por el cliente";
      hist(p, "cancelado por el cliente");
      await guardarPedido(p);
      await enviarASucursal(p.sucursal, `❌ El pedido #${p.id} de ${p.cliente} quedó *cancelado*${p.sinStock ? " por falta de stock" : ""}. No hace falta prepararlo.`);
    }
  }
  const der = texto.match(/<derivar>([\s\S]*?)<\/derivar>/);
  if (der) await avisarBackup(`🙋 *Un cliente necesita atención*\nNúmero: +${waid}\nMotivo: ${der[1].trim()}`);
}

/* =========================================================
   Pedidos
   ========================================================= */
async function crearPedido(data, waid) {
  const suc = SUC[data.sucursal] ? data.sucursal
    : (SUC_IDS.find((id) => SUC[id].nombre.toLowerCase() === String(data.sucursal || "").toLowerCase()) || "bernal");
  const items = (Array.isArray(data.items) ? data.items : []).map((i) => ({
    producto: String(i.producto || "?"), cantidad: Number(i.cantidad) || 1, unidad: String(i.unidad || ""),
    precio: Number(i.precio_unitario) || 0, consultar: !!i.consultar_stock,
  }));
  const id = await nuevoIdPedido();
  let modificado = false, motivoMod = "";
  for (const p of await pedidosDelChat(waid)) {
    if (!["consultar", "recibido", "pausado"].includes(p.estado)) continue;
    modificado = true; motivoMod = p.sinStock ? "por falta de stock" : "a pedido del cliente";
    p.estado = "reemplazado"; p.motivo = `Lo reemplaza el #${id}`;
    hist(p, `modificado ${motivoMod}, reemplazado por #${id}`);
    await guardarPedido(p);
    await enviarASucursal(p.sucursal, `✏️ El pedido #${p.id} de ${p.cliente} se *modificó* ${motivoMod}: queda sin efecto y lo reemplaza el #${id}.`);
  }
  const p = {
    id, waid, cliente: String(data.cliente || "Cliente"), sucursal: suc, retiro: data.retiro, items, notas: String(data.notas || ""),
    estado: items.some((i) => i.consultar) ? "consultar" : "recibido", ack: false, intentos: 0,
    creado: new Date().toISOString(), cerradoAlEnviar: !estaAbierta(suc), modificado, motivoMod, historial: [],
  };
  hist(p, "pedido tomado por Mary");
  await enviarPedido(p);
}

function textoPedido(p, intro) {
  return (intro ? intro + "\n\n" : "")
    + `🍝 *Pedido #${p.id}* · ${SUC[p.sucursal].nombre}\n*${p.cliente}* — retira ${retiroTexto(p.retiro)}\n`
    + p.items.map((i) => `• ${cantidadTexto(i)} ${i.producto}${i.consultar ? " ⚠️ _confirmar stock_" : ""}`).join("\n")
    + `\nTotal: ${plata(totalPedido(p))} · paga al retirar`
    + (p.notas ? `\nNota: ${p.notas}` : "")
    + (p.estado === "consultar" ? "\n\n¿Hay todo?" : "");
}
function botonesPara(p) {
  const b = (a) => `p:${p.id}:${a}`;
  if (p.estado === "consultar") return [[b("hay"), "Hay todo ✅"], [b("falta"), "Falta algo ❌"]];
  if (p.estado === "recibido") {
    return p.ack ? [[b("preparacion"), "En preparación"], [b("listo"), "Listo para retirar"]]
      : [[b("ok"), "Recibido 👍"], [b("preparacion"), "En preparación"], [b("listo"), "Listo para retirar"]];
  }
  if (p.estado === "preparacion") return [[b("listo"), "Listo para retirar"]];
  if (p.estado === "listo") return [[b("entregado"), "Entregado"]];
  return [];
}

async function enviarASucursal(suc, texto, botones = [], pedidoId = null) {
  const to = await numeroSucursal(suc);
  if (!to) { await avisarBackup(`⚠️ Falta configurar el número de ${SUC[suc].nombre}.`); return false; }
  try {
    let mid;
    if (botones.length && texto.length > 1000) {
      await wa.enviarTexto(to, texto);
      mid = await wa.enviarBotones(to, "¿Qué hacemos con este pedido?", botones);
    } else if (botones.length) mid = await wa.enviarBotones(to, texto, botones);
    else mid = await wa.enviarTexto(to, texto);
    if (mid && pedidoId) await redis.set(`wamid:${mid}`, pedidoId, { ex: 7 * 86400 });
    await agregarTurno(`suc:${suc}`, { role: "assistant", content: texto });
    return true;
  } catch (e) {
    console.error("No pude escribirle a la sucursal", suc, e.message);
    await avisarBackup(`⚠️ No pude escribirle a ${SUC[suc].nombre}${pedidoId ? ` (pedido #${pedidoId})` : ""}: ${e.message}\nSi es por la ventana de 24 hs, alguien del local tiene que escribirle "hola" a Mary.`);
    return false;
  }
}
async function enviarPedido(p, intro) {
  p.ultimoEnvio = Date.now();
  await guardarPedido(p);
  return enviarASucursal(p.sucursal, textoPedido(p, intro), botonesPara(p), p.id);
}

async function accionPedido(p, tipo, extra = {}) {
  if (CERRADOS.includes(p.estado)) return;
  p.ack = true;
  const suc = SUC[p.sucursal].nombre;
  switch (tipo) {
    case "confirmar":
      if (p.estado !== "consultar") break;
      p.estado = "recibido"; hist(p, "stock confirmado");
      await guardarPedido(p);
      return decirleAlCliente(p.waid, `¡Buenas noticias, ${nombreDe(p)}! 🥰 Ya me confirmaron del local: tengo todo para tu pedido #${p.id}. Quedó confirmado ✅ Te espero en ${suc} el ${retiroTexto(p.retiro)} 👵`);
    case "sin_stock": {
      const faltan = (extra.productos?.length ? extra.productos : p.items.filter((i) => i.consultar).map((i) => i.producto)).join(", ") || "parte del pedido";
      p.estado = "pausado"; p.sinStock = true; p.motivo = "Sin stock: " + faltan; hist(p, `sin stock: ${faltan}`);
      await guardarPedido(p);
      return avisoInterno(p.waid, `El local ${suc} avisa que NO hay ${faltan} para el pedido #${p.id}, que queda en pausa.${extra.cuando_hay ? ` Vuelve a haber: ${extra.cuando_hay}.` : ""} Avisale al cliente con cariño y seguí la regla de "Cuando una variedad no está disponible" (si dijeron cuándo vuelve a haber, ofrecé esa opción). Si arma un pedido nuevo, registralo con una etiqueta <pedido> nueva y completa. Si prefiere cancelar, agregá <cancelar>motivo</cancelar>.`);
    }
    case "preparacion":
      if (p.estado === "recibido") { p.estado = "preparacion"; hist(p, "en preparación"); }
      break;
    case "listo":
      if (!["recibido", "preparacion"].includes(p.estado)) break;
      p.estado = "listo"; hist(p, "listo para retirar");
      await guardarPedido(p);
      return decirleAlCliente(p.waid, `¡${nombreDe(p)}, tu pedido #${p.id} ya está listo para retirar en ${suc}! 🍝 Te lo dejé separadito con mucho amor. ¡Te espero! 💛`);
    case "entregado":
      if (["recibido", "preparacion", "listo"].includes(p.estado)) { p.estado = "entregado"; hist(p, "entregado"); }
      break;
    case "aviso_cliente":
      if (!extra.texto) break;
      await guardarPedido(p);
      return avisoInterno(p.waid, `Mensaje del local ${suc} sobre el pedido #${p.id}: "${extra.texto}". Contáselo al cliente con tu tono.`);
  }
  await guardarPedido(p);
}

/* =========================================================
   Sucursales
   ========================================================= */
const chatSuc = (suc) => `suc:${suc}`;

async function mensajeDeSucursal(suc, waid, msg) {
  await redis.set(`waid:${suc}`, waid); // guardamos el número exacto como lo informa Meta
  if (msg.boton?.startsWith("p:")) {
    const [, id, accion] = msg.boton.split(":");
    return apretarBoton(suc, Number(id), accion, msg.titulo);
  }
  if (msg.audio) return enviarASucursal(suc, "No puedo escuchar audios 🙈 ¿Me lo escribís? 🙏");
  let texto = msg.texto;
  if (msg.contexto) {
    const pid = await redis.get(`wamid:${msg.contexto}`);
    if (pid) texto = `[Responde al pedido #${pid}] ${texto}`;
  }
  await agregarTurno(chatSuc(suc), { role: "user", content: texto });
  for (const p of await pedidosAbiertos()) {
    if (p.sucursal === suc && !p.ack) { p.ack = true; hist(p, "el local respondió"); await guardarPedido(p); }
  }
  await atenderSucursal(suc);
}

async function atenderSucursal(suc, vuelta = 0) {
  const clave = chatSuc(suc);
  if (!(await tomarTurno(clave))) return;
  try {
    for (let i = 0; i < 3; i++) {
      const ts = await turnos(clave);
      if (!ts.length || ts[ts.length - 1].role !== "user") break;
      const abiertos = (await pedidosAbiertos()).filter((p) => p.sucursal === suc);
      const ag = await agotados();
      const respuesta = await pensar({ fijo: reglasSucursal(suc, abiertos, ag[suc]), turnos: ts.slice(-24), cache: false });
      await agregarTurno(clave, { role: "assistant", content: respuesta });
      const to = await numeroSucursal(suc);
      for (const b of burbujas(respuesta)) await wa.enviarTexto(to, b);
      await accionesSucursal(respuesta, suc);
    }
  } finally {
    await soltarTurno(clave);
  }
  const ult = await ultimoTurno(clave);
  if (ult?.role === "user" && vuelta < 2) await atenderSucursal(suc, vuelta + 1);
}

async function accionesSucursal(texto, suc) {
  for (const m of texto.matchAll(/<accion>([\s\S]*?)<\/accion>/g)) {
    let a;
    try { a = JSON.parse(m[1]); } catch { continue; }
    if (a.tipo === "agotado" || a.tipo === "repuesto") {
      const k = buscarProducto(a.producto);
      if (!k) continue;
      if (a.tipo === "agotado") { await redis.sadd(claveAgotados(suc), k); await redis.expire(claveAgotados(suc), 2 * 86400); }
      else await redis.srem(claveAgotados(suc), k);
      continue;
    }
    const p = await leerPedido(a.pedido);
    if (p && p.sucursal === suc) await accionPedido(p, a.tipo, a);
  }
}

async function apretarBoton(suc, id, accion, titulo) {
  await agregarTurno(chatSuc(suc), { role: "user", content: titulo || accion });
  const p = await leerPedido(id);
  const responder = (t, botones = []) => enviarASucursal(suc, t, botones, botones.length ? id : null);
  if (!p || p.sucursal !== suc) return responder("No encuentro ese pedido 🤔");
  if (CERRADOS.includes(p.estado)) return responder(`El pedido #${p.id} ya figura como ${ESTADOS[p.estado].toLowerCase()} 👌`);
  switch (accion) {
    case "hay":
      await accionPedido(p, "confirmar");
      return responder(`✅ ¡Gracias! Ya le confirmé a ${p.cliente}.`, botonesPara(p));
    case "falta":
      p.ack = true; hist(p, "el local avisa que falta algo"); await guardarPedido(p);
      return responder(`Uh 😕 ¿Qué falta y sabés cuándo vuelve a haber? Contame y yo le aviso a ${nombreDe(p)} 💛`);
    case "ok":
      p.ack = true; hist(p, "recibido por el local"); await guardarPedido(p);
      return responder("👍 Anotado. Avisame cuando esté listo.", botonesPara(p));
    case "preparacion":
      await accionPedido(p, "preparacion");
      return responder(`👌 #${p.id} en preparación.`, botonesPara(p));
    case "listo":
      await accionPedido(p, "listo");
      return responder(`🎉 Le avisé a ${p.cliente} que ya puede pasar a retirar.`, botonesPara(p));
    case "entregado":
      await accionPedido(p, "entregado");
      return responder(`¡Gracias! Pedido #${p.id} cerrado ✅`);
  }
}

/* =========================================================
   Revisión periódica: recordatorios y aviso al backup
   ========================================================= */
export async function revisarPendientes() {
  const hechos = [];
  for (const p of await pedidosAbiertos()) {
    if (p.ack || !["consultar", "recibido"].includes(p.estado)) continue;
    if (!estaAbierta(p.sucursal)) continue; // con el local cerrado esperamos a que abra
    const minutos = (Date.now() - (p.ultimoEnvio || 0)) / 60000;
    if (p.intentos === 0 && (p.cerradoAlEnviar || minutos >= MIN_RECORDATORIO)) {
      const alAbrir = p.cerradoAlEnviar;
      p.intentos = 1; p.cerradoAlEnviar = false;
      hist(p, alAbrir ? "reenviado al abrir el local" : "recordatorio por falta de respuesta");
      await enviarPedido(p, alAbrir ? "☀️ ¡Buen día! Les reenvío este pedido que entró con el local cerrado:" : "⏰ Les recuerdo este pedido, todavía nadie lo tomó 🙏");
      hechos.push(`#${p.id}: ${alAbrir ? "reenviado al abrir" : "recordatorio"}`);
    } else if (p.intentos === 1 && minutos >= MIN_RECORDATORIO) {
      p.intentos = 2; p.escalado = true; hist(p, "aviso al número de backup");
      await guardarPedido(p);
      await avisarBackup(`⚠️ *${SUC[p.sucursal].nombre} no responde*\nPedido #${p.id} de ${p.cliente} (+${p.waid}), retira ${retiroTexto(p.retiro)}.\nSe envió y se insistió una vez, sin respuesta. ¿Pueden intervenir?`);
      hechos.push(`#${p.id}: aviso al backup`);
    }
  }
  return hechos;
}
