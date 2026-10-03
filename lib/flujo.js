// Lo que pasa con cada mensaje: clientes, sucursales, pedidos, reintentos y avisos al backup.
import * as wa from "./whatsapp.js";
import {
  redis, turnos, agregarTurno, ultimoTurno, tomarTurno, soltarTurno, esNuevo, nuevoIdPedido, leerPedido, guardarPedido,
  pedidosAbiertos, registrarError, recordarProductos, productosPedidos,
  nuevaTarea, guardarTarea, leerTarea, tareasAbiertas,
} from "./db.js";
import {
  SUC, SUC_IDS, ESTADOS, CERRADOS, estaAbierta, retiroTexto, plata, cantidadTexto, totalPedido, buscarProducto,
  cierreActual, minutosDelDia, horaTexto, proximaApertura, minutosDesdeApertura,
  reglasClienteFijas, reglasClienteVariables, reglasSucursal, burbujas, hoyISO,
} from "./negocio.js";
import { pensar } from "./mary.js";

// Tiempos de respuesta que se le piden al local (en minutos).
const MIN_RECORDATORIO = Number(process.env.MINUTOS_RECORDATORIO || 5); // para tomar el pedido (Recibido / Hay todo)
const MIN_LISTO_ANTES = 30;        // desde 30 min antes del retiro, si no está "Listo", se avisa…
const MIN_REPETIR_LISTO = 5;       // …y se repite cada 5 min hasta que lo marquen (solo con el local abierto)
const MIN_GRACIA_APERTURA = 15;    // al abrir, 15 min para acomodarse antes de reenviar lo que entró con el local cerrado
const MIN_ENTREGADO_DESPUES = 15;  // pregunta si lo retiraron 15 min después del horario
const MIN_GRACIA = 15;             // si no vino, 15 min más antes de avisarle al cliente (salvo que el local cierre antes)
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
  if (!n) return registrarError("Falta NUMERO_BACKUP. Aviso que no se pudo mandar: " + texto);
  try { await wa.enviarTexto(n, texto); } catch (e) {
    console.error("No pude avisar al backup:", e.message);
    await registrarError(`No pude avisar al backup (${n}), código ${e.code}: ${e.message}. Aviso: ${texto}`);
  }
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
        if (s.status === "failed") {
          console.error("Mensaje no entregado a", s.recipient_id, JSON.stringify(s.errors));
          await registrarError(`Meta no pudo entregar un mensaje a ${s.recipient_id}: ${JSON.stringify(s.errors)}`);
        }
        if (s.status === "read") await marcarLeidoPorElLocal(s.id);
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
      const opciones = {
        fijo: reglasClienteFijas(),
        variable: reglasClienteVariables(await agotados(), await productosPedidos(waid)),
        herramientas: herramientasCliente(waid),
      };
      let { texto, notas } = await pensar({ ...opciones, turnos: ts });
      // Red de seguridad: si Mary dice que el pedido quedó confirmado pero no lo registró, no se lo mandamos
      // al cliente; le avisamos del error para que lo registre y recién ahí confirme.
      if (confirmaSinRegistrar(texto, notas, ts)) {
        await registrarError(`Mary dio por confirmado (o prometió consultar) un pedido de +${waid} sin registrarlo. Se le pidió corregir.`);
        ({ texto, notas } = await pensar({
          ...opciones,
          turnos: [...ts, { role: "assistant", content: texto }, {
            role: "user",
            content: "[AVISO INTERNO] Ibas a decirle al cliente que el pedido está confirmado o que le consultás al local, pero NO usaste registrar_pedido: el pedido no existe y al local no le llegó nada. Si el cliente ya confirmó el pedido completo, usá registrar_pedido ahora (con consultar_stock=true en lo que haya que confirmar) y recién después escribile con el número de pedido. Si todavía faltan datos o su confirmación, pedíselos sin prometer que vas a consultar.",
          }],
        }));
      }
      await agregarTurno(clave, { role: "assistant", content: turnoMary(texto, notas) });
      for (const b of burbujas(texto)) await wa.enviarTexto(waid, b);
    }
  } finally {
    await soltarTurno(clave);
  }
  const ult = await ultimoTurno(clave);
  if (ult?.role === "user" && vuelta < 2) await atenderCliente(waid, vuelta + 1);
}

// ¿El texto da el pedido por confirmado sin que se haya usado registrar_pedido en esta conversación?
// (si ya se registró antes en la charla, puede estar hablando de ese pedido)
function confirmaSinRegistrar(texto, notas, turnosChat) {
  if (notas.some((n) => n.startsWith("registrar_pedido"))) return false;
  const confirma = /pedido/i.test(texto) && /(confirmad|registrad|anotad|enviad[oa] al local|qued[oó] listo)/i.test(texto);
  const prometeConsultar = /(me fijo|le pregunto|les pregunto|consulto con|pregunto en el local|consultar con el local)/i.test(texto);
  if (!confirma && !prometeConsultar) return false;
  return !turnosChat.some((t) => t.role === "assistant" && t.content.includes("registrar_pedido →"));
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
      description: "Registra el pedido que el cliente confirmó y lo envía en ese momento al WhatsApp del local. Usala recién cuando el cliente confirmó el resumen (productos, cantidades, sucursal, día y hora de retiro y nombre). Si el cliente cambia un pedido ya registrado, usala de nuevo con el pedido completo y poné en 'reemplaza' el número del pedido anterior. Devuelve el número de pedido.",
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
          reemplaza: { type: "integer", description: "Solo si el cliente está cambiando un pedido ya registrado: el número de ese pedido. Si es un pedido nuevo, no lo pongas." },
          traslado_desde: { type: "string", enum: SUC_IDS, description: "Solo si el cliente eligió retirarlo en su sucursal con mercadería que se lleva desde otra (te lo indica un AVISO INTERNO). En ese caso, los productos trasladados van con consultar_stock=false." },
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
      description: "Cancela un pedido abierto de este cliente y avisa al local.",
      input_schema: {
        type: "object",
        properties: {
          pedido: { type: "integer", description: "Número del pedido a cancelar. Si no lo sabés y el cliente tiene un solo pedido abierto, omitilo." },
          motivo: texto_("Motivo breve"),
        },
        required: ["motivo"],
      },
      ejecutar: async ({ pedido, motivo }) => {
        const abiertos = await pedidosDelChat(waid);
        if (!pedido && abiertos.length > 1) return `El cliente tiene ${abiertos.length} pedidos abiertos (${abiertos.map((p) => "#" + p.id).join(", ")}). Preguntale cuál quiere cancelar.`;
        const n = await cancelarPedidos(waid, motivo, pedido);
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

async function cancelarPedidos(waid, motivo, soloId) {
  let n = 0;
  for (const p of await pedidosDelChat(waid)) {
    if (soloId && p.id !== Number(soloId)) continue;
    p.estado = "rechazado"; p.rechazo = p.sinStock ? "sin_stock" : "otro"; p.motivo = motivo || "Cancelado por el cliente";
    hist(p, "cancelado por el cliente");
    await guardarPedido(p);
    await cerrarTareasDe(p.id);
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
  let modificado = false, motivoMod = "", anterior = null;
  for (const p of await pedidosDelChat(waid)) {
    if (p.id !== Number(data.reemplaza)) continue;
    if (!["consultar", "recibido", "pausado"].includes(p.estado)) continue;
    anterior = p;
    modificado = true; motivoMod = p.sinStock ? "por falta de stock" : "a pedido del cliente";
    p.estado = "reemplazado"; p.motivo = `Lo reemplaza el #${id}`;
    hist(p, `modificado ${motivoMod}, reemplazado por #${id}`);
    await guardarPedido(p);
    await cerrarTareasDe(p.id);
    await enviarASucursal(p.sucursal, `✏️ El pedido #${p.id} de ${p.cliente} se *modificó* ${motivoMod}: queda sin efecto y lo reemplaza el #${id}.`);
  }
  const p = {
    id, waid, cliente: String(data.cliente || "Cliente"), sucursal: suc, retiro: data.retiro, items, notas: String(data.notas || ""),
    estado: items.some((i) => i.consultar) ? "consultar" : "recibido", ack: false, intentos: 0,
    creado: new Date().toISOString(), cerradoAlEnviar: !estaAbierta(suc), modificado, motivoMod, historial: [],
    // sucursales que ya dijeron que no tienen (para no volver a consultarlas)
    descartadas: anterior?.sinStock ? [anterior.sucursal, ...(anterior.descartadas || [])] : [],
    traslado: SUC[data.traslado_desde] && data.traslado_desde !== suc ? data.traslado_desde : null,
    faltantes: anterior?.faltantes || [],
  };
  // Si hay que confirmar stock con el local abierto, empieza a correr la espera del cliente (aviso a los 15 y a los 30 min).
  if (p.estado === "consultar" && estaAbierta(suc)) p.esperaDesde = Date.now();
  hist(p, "pedido tomado por Mary" + (p.traslado ? ` (con traslado desde ${SUC[p.traslado].nombre})` : ""));
  p.enviado = await enviarPedido(p);
  if (p.traslado) {
    const t = await nuevaTarea({
      tipo: "traslado", pedido: p.id, suc: p.traslado,
      texto: `🚚 *Traslado a ${SUC[suc].nombre}*\nSeparen ${detalleFaltantes(p)} para el pedido #${p.id} de ${p.cliente}, que lo retira el ${retiroTexto(p.retiro)} en ${SUC[suc].nombre}.`,
      botones: [["ok", "Separado ✅"]],
    });
    await enviarTarea(t);
  }
  await recordarProductos(waid, items.map((i) => i.producto));
  return p;
}

function textoPedido(p, intro) {
  return (intro ? intro + "\n\n" : "")
    + `🍝 *Pedido #${p.id}* · ${SUC[p.sucursal].nombre}\n*${p.cliente}* — retira ${retiroTexto(p.retiro)}\n`
    + (p.traslado ? `🚚 _Parte del pedido llega por traslado desde ${SUC[p.traslado].nombre}_\n` : "")
    + p.items.map((i) => `• ${cantidadTexto(i)} ${i.producto}${i.consultar ? " ⚠️ _confirmar stock_" : ""}`).join("\n")
    + `\nTotal: ${plata(totalPedido(p))} · paga al retirar`
    + (p.notas ? `\nNota: ${p.notas}` : "")
    + (p.estado === "consultar" ? "\n\n¿Hay todo?" : "");
}
function botonesPara(p) {
  const b = (a) => `p:${p.id}:${a}`;
  if (p.estado === "consultar") return [[b("hay"), "Hay todo ✅"], [b("falta"), "Falta algo ❌"]];
  // "En preparación" es opcional (para que el local se organice); "Hay un problema" siempre a mano.
  if (p.estado === "recibido") {
    return p.ack ? [[b("listo"), "Listo para retirar"], [b("preparacion"), "En preparación"], [b("problema"), "Hay un problema ⚠️"]]
      : [[b("ok"), "Recibido 👍"], [b("listo"), "Listo para retirar"], [b("problema"), "Hay un problema ⚠️"]];
  }
  if (p.estado === "preparacion") return [[b("listo"), "Listo para retirar"], [b("problema"), "Hay un problema ⚠️"]];
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
    await registrarError(`No pude escribirle a ${SUC[suc].nombre} (${to}), código ${e.code}: ${e.message}`);
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
  if (!p.ack) hist(p, "el local tomó el pedido");
  p.ack = true;
  const suc = SUC[p.sucursal].nombre;
  switch (tipo) {
    case "recibido":
      break; // solo marca que el local lo tomó
    case "confirmar":
      if (p.estado !== "consultar") break;
      p.estado = "recibido"; p.esperaDesde = null; hist(p, "stock confirmado");
      await guardarPedido(p);
      return decirleAlCliente(p.waid, `¡Buenas noticias, ${nombreDe(p)}! 🥰 Ya me confirmaron del local: tengo todo para tu pedido #${p.id}. Quedó confirmado ✅ Te espero en ${suc} el ${retiroTexto(p.retiro)} 👵`);
    case "sin_stock": {
      if (p.estado === "pausado") break; // ya se está resolviendo
      const productos = extra.productos?.length ? extra.productos : p.items.filter((i) => i.consultar).map((i) => i.producto);
      const faltan = productos.join(", ") || "parte del pedido";
      p.estado = "pausado"; p.sinStock = true; p.motivo = "Sin stock: " + faltan; p.faltantes = productos;
      if (extra.cuando_hay) p.cuandoHay = extra.cuando_hay;
      hist(p, `sin stock en ${suc}: ${faltan}`);
      await guardarPedido(p);
      // Antes de avisarle al cliente, buscamos en las otras sucursales.
      return buscarEnOtrasSucursales(p);
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
    case "no_retiro":
      if (!["recibido", "preparacion", "listo"].includes(p.estado)) break;
      return noVino(p);
    case "aviso_cliente":
      if (!extra.texto) break;
      await guardarPedido(p);
      return avisoInterno(p.waid, `Mensaje del local ${suc} sobre el pedido #${p.id}: "${extra.texto}". Contáselo al cliente con tu tono.`);
  }
  await guardarPedido(p);
}

/* =========================================================
   Búsqueda en otras sucursales y traslados
   ========================================================= */
// Los ítems del pedido que faltan, con cantidades ("2 cajas Ravioles caseros Salmón").
function detalleFaltantes(p) {
  const f = p.faltantes || [];
  const items = p.items.filter((i) => f.some((x) => x.toLowerCase() === i.producto.toLowerCase()));
  return items.length ? items.map((i) => `${cantidadTexto(i)} ${i.producto}`).join(", ") : (f.join(", ") || "parte del pedido");
}

// El pedido se canceló o se reemplazó: las consultas que quedaban abiertas ya no hacen falta.
async function cerrarTareasDe(pedidoId) {
  for (const t of await tareasAbiertas()) {
    if (t.pedido === pedidoId) { t.estado = "hecha"; t.respuesta = "ya no hace falta"; await guardarTarea(t); }
  }
}

async function enviarTarea(t, intro) {
  t.ultimoEnvio = Date.now();
  await guardarTarea(t);
  return enviarASucursal(t.suc, (intro ? intro + "\n\n" : "") + t.texto, t.botones.map(([k, l]) => [`t:${t.id}:${k}`, l]));
}

// La sucursal del pedido no tiene: antes de decirle nada al cliente, consultamos a las otras sucursales abiertas.
async function buscarEnOtrasSucursales(p) {
  const descartadas = [p.sucursal, ...(p.descartadas || [])];
  const otras = SUC_IDS.filter((id) => !descartadas.includes(id) && numeroConfigurado(id) && estaAbierta(id));
  if (!otras.length) return sinDisponibilidad(p);
  p.busqueda = { inicio: Date.now(), sucursales: otras };
  if (!p.esperaDesde) p.esperaDesde = Date.now();
  hist(p, `busca en otras sucursales: ${otras.map((id) => SUC[id].nombre).join(", ")}`);
  await guardarPedido(p);
  for (const s of otras) {
    const t = await nuevaTarea({
      tipo: "consulta", pedido: p.id, suc: s,
      texto: `🔎 *Consulta de stock*\n¿Tienen ${detalleFaltantes(p)} para el ${retiroTexto(p.retiro)}? (es para un cliente de ${SUC[p.sucursal].nombre}, pedido #${p.id})`,
      botones: [["si", "Sí, hay ✅"], ["no", "No hay ❌"]],
    });
    await enviarTarea(t);
  }
}

// Una sucursal respondió una consulta (sí / no) o confirmó un traslado (ok).
async function responderTarea(t, respuesta) {
  if (!t || t.estado !== "pendiente") return "Eso ya estaba respondido 👍";
  t.estado = "hecha"; t.respuesta = respuesta;
  await guardarTarea(t);
  const p = await leerPedido(t.pedido);
  if (t.tipo === "traslado") {
    if (p) { hist(p, `${SUC[t.suc].nombre} separó la mercadería del traslado`); await guardarPedido(p); }
    return "¡Gracias! 🙌";
  }
  if (!p || p.busqueda?.resultado) return "¡Gracias! Ya lo resolvimos 👍";
  hist(p, `${SUC[t.suc].nombre} responde que ${respuesta === "si" ? "sí hay" : "no hay"}`);
  if (respuesta === "si") {
    p.busqueda.resultado = t.suc;
    await guardarPedido(p);
    for (const otra of await tareasAbiertas()) {
      if (otra.tipo === "consulta" && otra.pedido === p.id) { otra.estado = "hecha"; otra.respuesta = "ya no hace falta"; await guardarTarea(otra); }
    }
    await hayEnOtraSucursal(p, t.suc);
    return "¡Genial, gracias! Ya le aviso al cliente 💛";
  }
  await guardarPedido(p);
  const pendientes = (await tareasAbiertas()).filter((x) => x.tipo === "consulta" && x.pedido === p.id);
  if (!pendientes.length) {
    p.busqueda.resultado = "ninguna";
    await guardarPedido(p);
    await sinDisponibilidad(p);
  }
  return "Gracias 👍";
}

async function hayEnOtraSucursal(p, s) {
  p.esperaDesde = null;
  await guardarPedido(p);
  const orig = SUC[p.sucursal].nombre, otra = SUC[s];
  return avisoInterno(p.waid, `En ${orig} no hay ${detalleFaltantes(p)} para el pedido #${p.id}, pero en ${otra.nombre} sí hay. Contale al cliente con cariño que en ${orig} se terminó y ofrecele:
1) Retirarlo en ${otra.nombre} (${otra.dir}; ${otra.horario}) → registrar_pedido con el pedido completo, sucursal=${s}, reemplaza=${p.id} y consultar_stock=false (ya confirmaron que hay).
2) Retirarlo al día siguiente en ${orig}: lo llevamos desde ${otra.nombre} → registrar_pedido con sucursal=${p.sucursal}, la nueva fecha (dentro del horario de ${orig}), reemplaza=${p.id} y traslado_desde=${s}.
3) Cambiarlo por otra variedad parecida.
4) Cancelar (cancelar_pedido).`);
}

async function sinDisponibilidad(p) {
  p.esperaDesde = null;
  await guardarPedido(p);
  const orig = SUC[p.sucursal].nombre, otras = p.busqueda ? " ni en las otras sucursales abiertas" : "";
  if (!p.cuandoHay) {
    await enviarASucursal(p.sucursal, `🔎 No hay ${detalleFaltantes(p)}${otras} para el pedido #${p.id} de ${p.cliente}. ¿Pueden consultar con la fábrica cuándo lo elaboran? Respondanme con el día y se lo ofrezco al cliente 💛`, [], p.id);
  }
  return avisoInterno(p.waid, `No hay ${detalleFaltantes(p)} en ${orig}${otras} para el pedido #${p.id}. ${p.cuandoHay
    ? `Vuelve a haber: ${p.cuandoHay}. Ofrecé tomarlo para ese día (registrar_pedido con reemplaza=${p.id} y la nueva fecha)`
    : "El local está consultando con la fábrica cuándo lo elaboran: avisale al cliente que apenas sepas el día se lo ofrecés"}, u ofrecé otra variedad parecida, o cancelar (cancelar_pedido). Explicáselo con cariño.`);
}

// El local avisa que el cliente todavía no vino a retirar.
// La primera vez damos 15 minutos de gracia y volvemos a preguntar; si vuelve a decir que no
// (o si el local cierra antes de que terminen esos 15 minutos), le avisamos al cliente.
// Devuelve el texto para responderle al local.
async function noVino(p) {
  const s = SUC[p.sucursal], cierre = cierreActual(p.sucursal);
  const cierraAntes = cierre === null || cierre - minutosDelDia() <= MIN_GRACIA;
  if (p.noVino || cierraAntes) {
    if (!p.avisoEsperando) {
      p.avisoEsperando = true; hist(p, "aviso al cliente: su pedido lo está esperando");
      await guardarPedido(p);
      const horario = cierre !== null ? `Estamos hasta las ${horaTexto(cierre)} hs` : `Volvemos a abrir ${proximaApertura(p.sucursal)}`;
      await decirleAlCliente(p.waid, `¡Hola ${nombreDe(p)}! 💛 Tu pedido #${p.id} te está esperando en ${s.nombre} (${s.dir}). ${horario}. ¡Te espero! 👵`);
    }
    return `Anotado. Le avisé a ${nombreDe(p)} que su pedido lo está esperando 💛`;
  }
  p.noVino = true; p.noVinoEn = Date.now(); hist(p, "el local avisa que el cliente todavía no vino");
  await guardarPedido(p);
  return `Anotado 👍 Les vuelvo a preguntar en ${MIN_GRACIA} minutos.`;
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
  if (msg.boton?.startsWith("t:")) {
    const [, id, respuesta] = msg.boton.split(":");
    await agregarTurno(chatSuc(suc), { role: "user", content: msg.titulo || respuesta });
    const t = await leerTarea(id);
    return enviarASucursal(suc, t && t.suc === suc ? await responderTarea(t, respuesta) : "No encuentro esa consulta 🤔");
  }
  if (msg.audio) return enviarASucursal(suc, "No puedo escuchar audios 🙈 ¿Me lo escribís? 🙏");
  let texto = msg.texto;
  if (msg.contexto) {
    const pid = await redis.get(`wamid:${msg.contexto}`);
    if (pid) texto = `[Responde al pedido #${pid}] ${texto}`;
  }
  // Un mensaje suelto del local no cuenta como "tomar" el pedido: solo los botones
  // o una acción concreta sobre ese pedido (que Mary registra con actualizar_pedido).
  await agregarTurno(chatSuc(suc), { role: "user", content: texto });
  await atenderSucursal(suc);
}

// Meta avisa cuando el local abre (lee) un mensaje: si era el de un pedido, lo anotamos.
async function marcarLeidoPorElLocal(wamid) {
  const pid = await redis.get(`wamid:${wamid}`);
  if (!pid) return;
  const p = await leerPedido(pid);
  if (p && !p.ack && !p.leido && !CERRADOS.includes(p.estado)) {
    p.leido = true; hist(p, "el local leyó el mensaje");
    await guardarPedido(p);
  }
}

async function atenderSucursal(suc, vuelta = 0) {
  const clave = chatSuc(suc);
  if (!(await tomarTurno(clave))) return;
  try {
    for (let i = 0; i < 3; i++) {
      const ts = await turnos(clave);
      if (!ts.length || ts[ts.length - 1].role !== "user") break;
      const abiertos = (await pedidosAbiertos()).filter((p) => p.sucursal === suc);
      const tareas = (await tareasAbiertas()).filter((t) => t.suc === suc);
      const ag = await agotados();
      const { texto, notas } = await pensar({
        fijo: reglasSucursal(suc, abiertos, ag[suc], tareas), turnos: ts.slice(-24), cache: false, herramientas: herramientasSucursal(suc),
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
      description: "Cambia el estado de un pedido de esta sucursal o le pasa información al cliente. recibido = el local tomó el pedido; confirmar = hay stock de lo que había que confirmar; sin_stock = falta algo; preparacion; listo = listo para retirar (le avisa al cliente); entregado = el cliente lo retiró; no_retiro = el cliente no vino a buscarlo; aviso_cliente = otra información para el cliente.",
      input_schema: {
        type: "object",
        properties: {
          pedido: { type: "integer", description: "Número de pedido, ej. 1024" },
          accion: { type: "string", enum: ["recibido", "confirmar", "sin_stock", "preparacion", "listo", "entregado", "no_retiro", "aviso_cliente"] },
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
      name: "responder_tarea",
      description: "Registra la respuesta del local a una consulta de stock de otra sucursal (si = hay, no = no hay) o la confirmación de que separaron la mercadería de un traslado (ok).",
      input_schema: {
        type: "object",
        properties: {
          tarea: { type: "integer", description: "Número de la consulta o traslado (de la lista de pendientes)" },
          respuesta: { type: "string", enum: ["si", "no", "ok"] },
        },
        required: ["tarea", "respuesta"],
      },
      ejecutar: async ({ tarea, respuesta }) => {
        const t = await leerTarea(tarea);
        if (!t || t.suc !== suc) return `No existe la consulta #${tarea} para ${SUC[suc].nombre}.`;
        return responderTarea(t, respuesta);
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
    case "problema":
      p.ack = true; hist(p, "el local avisa que hay un problema"); await guardarPedido(p);
      return responder(`Uh 😕 ¿Qué pasó con el pedido #${p.id}? Contame (por ejemplo, si falta algún producto y cuándo vuelve a haber) y yo me encargo de avisarle a ${nombreDe(p)} 💛`);
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
    case "noretiro":
      p.ack = true;
      return responder(await noVino(p));
  }
}

/* =========================================================
   Revisión periódica: recordatorios y aviso al backup
   ========================================================= */
// Horario de retiro del pedido como instante (el texto está en hora de Argentina, UTC-3).
function msRetiro(p) {
  const m = String(p.retiro || "").match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + 3 * 3600e3 : null;
}
const horaDe = (p) => String(p.retiro || "").slice(11, 16);

export async function revisarPendientes() {
  const hechos = [], ahora = Date.now();
  const alAbrir = {}; // sucursal → pedidos que entraron con el local cerrado y nadie tomó

  for (const p of await pedidosAbiertos()) {
    const suc = SUC[p.sucursal].nombre;
    const retiro = msRetiro(p);
    const sinListo = ["consultar", "recibido", "preparacion"].includes(p.estado);

    // Con el local cerrado los mensajes entran igual, pero sin alertas ni recordatorios: todo espera a que abra.
    if (!estaAbierta(p.sucursal)) continue;

    // 1) URGENTE: el cliente está por llegar (o ya debería estar llegando) y el pedido no está listo.
    //    Al abrir no hay gracia para estos; se repite cada 5 min hasta que lo marquen como listo.
    if (retiro && sinListo && ahora >= retiro - MIN_LISTO_ANTES * 60000 && ahora < retiro + MIN_ENTREGADO_DESPUES * 60000) {
      if (!p.ultimoAvisoListo || ahora - p.ultimoAvisoListo >= MIN_REPETIR_LISTO * 60000) {
        const primero = !p.ultimoAvisoListo;
        if (primero) p.primerAvisoListo = ahora;
        p.ultimoAvisoListo = ahora;
        hist(p, "aviso urgente: el cliente está por llegar y no está listo");
        await guardarPedido(p);
        const cuando = ahora < retiro ? `llega en ${Math.max(1, Math.round((retiro - ahora) / 60000))} min (retira ${horaDe(p)})` : `ya puede estar llegando (retiraba ${horaDe(p)})`;
        const alerta = `🚨 ${p.cliente} ${cuando} y el pedido #${p.id} todavía no está ${p.estado === "consultar" ? "confirmado" : "listo"}.`;
        const botones = p.estado === "consultar" ? botonesPara(p) : [[`p:${p.id}:listo`, "Listo para retirar"]];
        await enviarASucursal(p.sucursal, primero ? textoPedido(p, alerta) : alerta, botones, p.id);
        hechos.push(`#${p.id}: aviso urgente de listo`);
      }
      // Al backup: llegó la hora y el local ya tuvo al menos 5 min desde la primera alerta.
      if (!p.backupListo && ahora >= retiro && p.primerAvisoListo && ahora - p.primerAvisoListo >= MIN_REPETIR_LISTO * 60000) {
        p.backupListo = true; hist(p, "aviso al backup: llegó la hora de retiro sin estar listo");
        await guardarPedido(p);
        await avisarBackup(`⚠️ *${suc}*: ${p.cliente} retiraba el pedido #${p.id} a las ${horaDe(p)} y todavía no está marcado como listo.`);
        hechos.push(`#${p.id}: aviso al backup (no está listo)`);
      }
      continue;
    }

    // 2) Nadie tomó el pedido (Recibido / Hay todo / Falta algo).
    if (!p.ack && ["consultar", "recibido"].includes(p.estado) && (!retiro || ahora < retiro)) {
      const minutos = (ahora - (p.ultimoEnvio || 0)) / 60000;
      if (p.intentos === 0 && p.cerradoAlEnviar) {
        // Entró con el local cerrado: 15 min de gracia desde la apertura y después se reenvía todo junto.
        if (minutosDesdeApertura(p.sucursal) >= MIN_GRACIA_APERTURA) (alAbrir[p.sucursal] ||= []).push(p);
      } else if (p.intentos === 0 && minutos >= MIN_RECORDATORIO) {
        const leido = p.leido;
        p.intentos = 1; p.leido = false;
        hist(p, `recordatorio (${leido ? "leído sin tomar" : "sin leer"})`);
        await enviarPedido(p, leido ? "👀 Vi que leyeron este pedido, pero nadie lo tomó todavía. ¿Lo confirman con el botón? 🙏" : "⏰ Tienen un pedido sin ver 🙏");
        hechos.push(`#${p.id}: recordatorio`);
      } else if (p.intentos === 1 && minutos >= MIN_RECORDATORIO) {
        p.intentos = 2; p.escalado = true; hist(p, "aviso al número de backup");
        await guardarPedido(p);
        await avisarBackup(`⚠️ *${suc} no responde*\nPedido #${p.id} de ${p.cliente} (+${p.waid}), retira ${retiroTexto(p.retiro)}.\nSe envió y se insistió una vez; ${p.leido ? "lo leyeron pero nadie lo tomó" : "nadie lo abrió"}. ¿Pueden intervenir?`);
        hechos.push(`#${p.id}: aviso al backup`);
      }
      continue;
    }

    if (!retiro) continue;

    // 3) Pasó el horario de retiro y nadie marcó si lo retiraron.
    if (["recibido", "preparacion", "listo"].includes(p.estado) && !p.avisoEsperando) {
      const cierre = cierreActual(p.sucursal);
      const porCerrar = cierre !== null && cierre - minutosDelDia() <= 10; // si el local cierra en 10 min, no esperamos los 15
      if (!p.preguntaEntregado && !p.noVino && (ahora >= retiro + MIN_ENTREGADO_DESPUES * 60000 || (ahora >= retiro && porCerrar))) {
        p.preguntaEntregado = true; hist(p, "pregunta al local si lo retiraron");
        await guardarPedido(p);
        await enviarASucursal(p.sucursal, `📦 ¿${p.cliente} retiró el pedido #${p.id}? (retiraba a las ${horaDe(p)})`,
          [[`p:${p.id}:entregado`, "Sí, lo retiró ✅"], [`p:${p.id}:noretiro`, "No vino ❌"]], p.id);
        hechos.push(`#${p.id}: pregunta si lo retiraron`);
      } else if (p.noVino && !p.preguntaGracia && ahora >= p.noVinoEn + MIN_GRACIA * 60000) {
        // Terminó la gracia: volvemos a preguntar. Si responden "Todavía no", le avisamos al cliente.
        p.preguntaGracia = true; hist(p, "vuelve a preguntar después de la gracia");
        await guardarPedido(p);
        await enviarASucursal(p.sucursal, `📦 ¿Ya pasó ${p.cliente} a buscar el pedido #${p.id}?`,
          [[`p:${p.id}:entregado`, "Sí, lo retiró ✅"], [`p:${p.id}:noretiro`, "Todavía no ❌"]], p.id);
        hechos.push(`#${p.id}: vuelve a preguntar si lo retiraron`);
      }
    }
  }

  // Reenvío de lo que entró con el local cerrado: un resumen y después cada pedido con sus botones.
  for (const [suc, lista] of Object.entries(alAbrir)) {
    const saludo = new Date(ahora - 3 * 3600e3).getUTCHours() < 13 ? "☀️ ¡Buen día!" : "👋 ¡Buenas tardes!";
    await enviarASucursal(suc, `${saludo} Mientras el local estaba cerrado entr${lista.length === 1 ? "ó 1 pedido que todavía no tomaron" : `aron ${lista.length} pedidos que todavía no tomaron`}. Se los paso de nuevo 👇`);
    for (const p of lista) {
      p.intentos = 1; p.cerradoAlEnviar = false; p.leido = false;
      if (p.estado === "consultar" && !p.esperaDesde) p.esperaDesde = ahora;
      hist(p, "reenviado al abrir el local (después de la gracia)");
      await enviarPedido(p);
      hechos.push(`#${p.id}: reenviado al abrir`);
    }
  }

  // Consultas de stock y traslados sin responder: recordatorio a los 5 min y backup a los 5 más (solo con el local abierto).
  for (const t of await tareasAbiertas()) {
    if (!estaAbierta(t.suc)) continue;
    const minutos = (ahora - (t.ultimoEnvio || t.creada)) / 60000;
    if (t.intentos === 0 && minutos >= MIN_RECORDATORIO) {
      t.intentos = 1;
      await enviarTarea(t, `⏰ Les recuerdo esta ${t.tipo === "consulta" ? "consulta, el cliente está esperando" : "tarea"} 🙏`);
      hechos.push(`tarea #${t.id}: recordatorio`);
    } else if (t.intentos === 1 && minutos >= MIN_RECORDATORIO) {
      t.intentos = 2;
      await guardarTarea(t);
      await avisarBackup(`⚠️ *${SUC[t.suc].nombre} no responde* ${t.tipo === "consulta" ? "una consulta de stock" : "un traslado"} (pedido #${t.pedido}). Se insistió una vez. ¿Pueden intervenir?`);
      hechos.push(`tarea #${t.id}: aviso al backup`);
    }
  }

  // Cliente esperando una confirmación de stock: aviso a los 15 min y opciones a los 30.
  for (const p of await pedidosAbiertos()) {
    if (!p.esperaDesde) continue;
    const espera = (ahora - p.esperaDesde) / 60000;
    if (espera >= 15 && !p.aviso15) {
      p.aviso15 = true; hist(p, "aviso al cliente: seguimos consultando");
      await guardarPedido(p);
      await decirleAlCliente(p.waid, `Sigo consultando por tu pedido #${p.id}, tesoro, no me olvidé de vos 💛 Te aviso apenas me respondan.`);
      hechos.push(`#${p.id}: aviso de espera (15 min)`);
    } else if (espera >= 30 && !p.aviso30) {
      p.aviso30 = true; hist(p, "30 min de espera: se le ofrecen opciones al cliente");
      await guardarPedido(p);
      await avisoInterno(p.waid, `Pasaron 30 minutos y todavía no pude confirmar la disponibilidad del pedido #${p.id}. Explicáselo al cliente con honestidad y ofrecele: esperar a que le avise (seguís consultando), cambiarlo por otra variedad que haya seguro (registrar_pedido con reemplaza=${p.id}), o cancelar.`);
      hechos.push(`#${p.id}: opciones al cliente (30 min)`);
    }
  }
  return hechos;
}
