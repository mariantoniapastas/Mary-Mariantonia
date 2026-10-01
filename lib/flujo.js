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
// El número exacto que informa Meta se guarda atado al número configurado:
// si mañana cambiás SUCURSAL_BERNAL (de la fábrica al local real), el viejo deja de usarse.
const numeroConfigurado = (suc) => soloDigitos(process.env["SUCURSAL_" + suc.toUpperCase()]);
const claveWaid = (suc) => `waid:${suc}:${ult10(numeroConfigurado(suc))}`;
async function numeroSucursal(suc) {
  const guardado = await redis.get(claveWaid(suc));
  return guardado ? String(guardado) : numeroConfigurado(suc);
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
      const { texto, notas } = await pensar({
        fijo: reglasClienteFijas(), variable: reglasClienteVariables(await agotados()), turnos: ts, herramientas: herramientasCliente(waid),
      });
      await agregarTurno(clave, { role: "assistant", content: turnoMary(texto, notas) });
      for (const b of burbujas(texto)) await wa.enviarTexto(waid, b);
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

// Lo que se guarda del turno de Mary: su texto + qué herramientas usó (nunca vacío: la API no acepta mensajes vacíos).
const notaInterna = (notas) => (notas.length ? `\n<nota_interna>${notas.join(" | ")}</nota_interna>` : "");
const turnoMary = (texto, notas) => (texto || "…") + notaInterna(notas);
const texto_ = (descripcion) => ({ type: "string", description: descripcion });

// Lo que Mary puede hacer mientras habla con un cliente.
function herramientasCliente(waid) {
  return [
    {
      name: "registrar_pedido",
      description: "Registra el pedido que el cliente confirmó y lo envía en ese momento al WhatsApp del local. Usala recién cuando el cliente confirmó el resumen (productos, cantidades, sucursal, día y hora de retiro y nombre). Si el cliente cambia un pedido ya registrado, usala de nuevo con el pedido completo: el anterior queda reemplazado. Devuelve el número de pedido.",
      input_schema: {
        type: "object",
        properties: {
          cliente: texto_("Nombre del cliente"),
          sucursal: { type: "string", enum: SUC_IDS },
          retiro: texto_("Fecha y hora de retiro, formato AAAA-MM-DDTHH:MM"),
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                producto: texto_("Categoría y nombre, ej. 'Ravioles caseros Provolone'"),
                cantidad: { type: "number", description: "Cajas, unidades o kilos (0.5 = medio kilo)" },
                unidad: { type: "string", enum: ["caja", "u", "kg"] },
                precio_unitario: { type: "number" },
                consultar_stock: { type: "boolean", description: "true si el producto tiene disponibilidad 'consultar'" },
              },
              required: ["producto", "cantidad", "unidad", "precio_unitario", "consultar_stock"],
            },
          },
          notas: texto_("Aclaraciones del cliente para el local (opcional)"),
        },
        required: ["cliente", "sucursal", "retiro", "items"],
      },
      ejecutar: async (d) => {
        const p = await crearPedido(d, waid);
        if (!p.enviado) return `Pedido #${p.id} registrado, pero todavía no le llegó al local (ya avisé al equipo). Decile al cliente que quedó anotado y que el local se lo confirma.`;
        return `Pedido #${p.id} registrado y enviado al local ${SUC[p.sucursal].nombre}.`
          + (p.estado === "consultar" ? " Tiene productos a confirmar: avisale al cliente que le confirmás apenas responda el local." : "");
      },
    },
    {
      name: "cancelar_pedido",
      description: "Cancela los pedidos abiertos de este cliente y avisa al local.",
      input_schema: { type: "object", properties: { motivo: texto_("Motivo breve") }, required: ["motivo"] },
      ejecutar: async ({ motivo }) => {
        const n = await cancelarPedidos(waid, motivo);
        return n ? `Cancelado(s) ${n} pedido(s). El local ya fue avisado.` : "No había pedidos abiertos para cancelar.";
      },
    },
    {
      name: "registrar_novedades",
      description: "Guarda si el cliente quiere (true) o no (false) recibir novedades y eventos. Usala cuando responde a la pregunta de novedades o cuando escribe BAJA.",
      input_schema: { type: "object", properties: { acepta: { type: "boolean" } }, required: ["acepta"] },
      ejecutar: async ({ acepta }) => {
        await redis.set(`novedades:${waid}`, { respuesta: acepta ? "si" : "no", fecha: new Date().toISOString() });
        if (acepta) await redis.sadd("novedades:suscriptos", waid);
        else await redis.srem("novedades:suscriptos", waid);
        return acepta ? "Anotado en la lista de novedades." : "No va a recibir novedades.";
      },
    },
    {
      name: "derivar_a_persona",
      description: "Avisa al equipo de Mariantonia que este cliente necesita una persona: queja, problema, pedido de borrar sus datos o algo que no podés resolver.",
      input_schema: { type: "object", properties: { motivo: texto_("Motivo breve") }, required: ["motivo"] },
      ejecutar: async ({ motivo }) => {
        await avisarBackup(`🙋 *Un cliente necesita atención*\nNúmero: +${waid}\nMotivo: ${motivo}`);
        return "El equipo ya fue avisado.";
      },
    },
  ];
}

async function cancelarPedidos(waid, motivo) {
  let n = 0;
  for (const p of await pedidosDelChat(waid)) {
    p.estado = "rechazado"; p.rechazo = p.sinStock ? "sin_stock" : "otro"; p.motivo = motivo || "Cancelado por el cliente";
    hist(p, "cancelado por el cliente");
    await guardarPedido(p);
    await enviarASucursal(p.sucursal, `❌ El pedido #${p.id} de ${p.cliente} quedó *cancelado*${p.sinStock ? " por falta de stock" : ""}. No hace falta prepararlo.`);
    n++;
  }
  return n;
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
  p.enviado = await enviarPedido(p);
  return p;
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
    const causa = e.code === 131030 ? "Ese número no está en la lista de destinatarios de prueba de Meta."
      : e.code === 131047 ? `Pasaron más de 24 hs desde el último mensaje del local: alguien de ${SUC[suc].nombre} tiene que escribirle "hola" a Mary.`
      : "";
    await avisarBackup(`⚠️ No pude escribirle a ${SUC[suc].nombre}${pedidoId ? ` (pedido #${pedidoId})` : ""}: ${e.message}${causa ? "\n" + causa : ""}`);
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
      return avisoInterno(p.waid, `El local ${suc} avisa que NO hay ${faltan} para el pedido #${p.id}, que queda en pausa.${extra.cuando_hay ? ` Vuelve a haber: ${extra.cuando_hay}.` : ""} Avisale al cliente con cariño y seguí la regla de "Cuando una variedad no está disponible" (si dijeron cuándo vuelve a haber, ofrecé esa opción). Si arma un pedido nuevo, usá registrar_pedido con el pedido completo. Si prefiere cancelar, usá cancelar_pedido.`);
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
  await redis.set(claveWaid(suc), waid); // guardamos el número exacto como lo informa Meta
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
      const { texto, notas } = await pensar({
        fijo: reglasSucursal(suc, abiertos, ag[suc]), turnos: ts.slice(-24), cache: false, herramientas: herramientasSucursal(suc),
      });
      await agregarTurno(clave, { role: "assistant", content: turnoMary(texto, notas) });
      const to = await numeroSucursal(suc);
      for (const b of burbujas(texto)) await wa.enviarTexto(to, b);
    }
  } finally {
    await soltarTurno(clave);
  }
  const ult = await ultimoTurno(clave);
  if (ult?.role === "user" && vuelta < 2) await atenderSucursal(suc, vuelta + 1);
}

// Lo que Mary puede hacer mientras habla con el personal de una sucursal.
function herramientasSucursal(suc) {
  return [
    {
      name: "actualizar_pedido",
      description: "Cambia el estado de un pedido de esta sucursal o le pasa información al cliente. confirmar = hay stock de lo que había que confirmar; sin_stock = falta algo; preparacion; listo = listo para retirar (le avisa al cliente); entregado; aviso_cliente = otra información para el cliente.",
      input_schema: {
        type: "object",
        properties: {
          pedido: { type: "integer", description: "Número de pedido, ej. 1024" },
          accion: { type: "string", enum: ["confirmar", "sin_stock", "preparacion", "listo", "entregado", "aviso_cliente"] },
          productos: { type: "array", items: { type: "string" }, description: "Solo para sin_stock: qué productos faltan" },
          cuando_hay: texto_("Solo para sin_stock: cuándo vuelve a haber, si lo dijeron"),
          texto: texto_("Solo para aviso_cliente: qué hay que contarle al cliente"),
        },
        required: ["pedido", "accion"],
      },
      ejecutar: async (a) => {
        const p = await leerPedido(a.pedido);
        if (!p || p.sucursal !== suc) return `No existe el pedido #${a.pedido} en ${SUC[suc].nombre}.`;
        if (CERRADOS.includes(p.estado)) return `El pedido #${p.id} ya figura como ${ESTADOS[p.estado].toLowerCase()}; no se cambió.`;
        await accionPedido(p, a.accion, a);
        return `Pedido #${p.id}: ${ESTADOS[p.estado]}.`;
      },
    },
    {
      name: "marcar_producto",
      description: "Marca un producto como agotado hoy en esta sucursal, o como disponible de nuevo. Mary deja de ofrecerlo ahí y propone alternativas u otra sucursal.",
      input_schema: {
        type: "object",
        properties: {
          producto: texto_("Nombre exacto en formato 'Categoría::Nombre', ej. 'Ravioles caseros::Provolone'"),
          estado: { type: "string", enum: ["agotado", "disponible"] },
        },
        required: ["producto", "estado"],
      },
      ejecutar: async ({ producto, estado }) => {
        const k = buscarProducto(producto);
        if (!k) return `No encontré "${producto}". Usá el nombre exacto de la lista de productos.`;
        if (estado === "agotado") { await redis.sadd(claveAgotados(suc), k); await redis.expire(claveAgotados(suc), 2 * 86400); }
        else await redis.srem(claveAgotados(suc), k);
        return `${k.replace("::", " ")}: ${estado === "agotado" ? "agotado hoy" : "disponible"} en ${SUC[suc].nombre}.`;
      },
    },
  ];
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
