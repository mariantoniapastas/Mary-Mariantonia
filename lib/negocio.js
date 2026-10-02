// Datos del negocio: sucursales, horarios, catálogo y textos que lee Mary.
import { readFileSync } from "node:fs";
import path from "node:path";

const leer = (f) => readFileSync(path.join(process.cwd(), "data", f), "utf8");
export const CATALOGO = JSON.parse(leer("catalogo.json"));
export const REGLAS = leer("reglas-mary.md");

// Horarios en minutos desde la medianoche, por día (0 = domingo).
const MS = [[480, 780], [1020, 1200]]; // martes a sábado en Bernal
export const SUC = {
  bernal: {
    nombre: "Bernal", dir: "9 de Julio 201 esquina Lavalle, Bernal",
    horario: "Martes a sábados de 8 a 13 y de 17 a 20 hs. Domingos de 8 a 13:30. Lunes cerrado.",
    h: { 0: [[480, 810]], 1: [], 2: MS, 3: MS, 4: MS, 5: MS, 6: MS },
  },
  quilmes: {
    nombre: "Quilmes", dir: "Brown 490 entre 9 de Julio y Videla, Quilmes centro",
    horario: "Martes a sábados de 9 a 21 hs. Domingos de 9 a 15 hs. Lunes cerrado.",
    h: { 0: [[540, 900]], 1: [], 2: [[540, 1260]], 3: [[540, 1260]], 4: [[540, 1260]], 5: [[540, 1260]], 6: [[540, 1260]] },
  },
  donbosco: {
    nombre: "Don Bosco", dir: "Av. Caseros 1750, Centro comercial Nuevo Quilmes Plaza",
    horario: "Lunes a domingos de 9 a 21 hs.",
    h: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [[540, 1260]]])),
  },
};
export const SUC_IDS = Object.keys(SUC);
export const ESTADOS = {
  consultar: "A confirmar stock", recibido: "Confirmado", preparacion: "En preparación", listo: "Listo para retirar",
  entregado: "Entregado", pausado: "Sin stock, esperando al cliente", reemplazado: "Modificado", rechazado: "Rechazado",
};
export const CERRADOS = ["entregado", "reemplazado", "rechazado"];

/* ---------- hora de Argentina (UTC-3, sin horario de verano) ---------- */
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const pad = (n) => String(n).padStart(2, "0");
const ahora = () => new Date(Date.now() - 3 * 3600e3);
export const hoyISO = () => ahora().toISOString().slice(0, 10);
export function fechaHoraTexto() {
  const d = ahora();
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]} de ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} hs`;
}
export function estaAbierta(suc) {
  const d = ahora(), m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return SUC[suc].h[d.getUTCDay()].some(([a, b]) => m >= a && m < b);
}
export const minutosDelDia = () => { const d = ahora(); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
export const horaTexto = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
// Turno actual [apertura, cierre] en minutos del día (null si ahora está cerrada).
const turnoActual = (suc) => { const m = minutosDelDia(); return SUC[suc].h[ahora().getUTCDay()].find(([a, b]) => m >= a && m < b) || null; };
export const cierreActual = (suc) => turnoActual(suc)?.[1] ?? null;
// Minutos desde que abrió el turno actual (null si está cerrada).
export const minutosDesdeApertura = (suc) => { const t = turnoActual(suc); return t ? minutosDelDia() - t[0] : null; };
export function proximaApertura(suc) {
  const d = ahora(), m = d.getUTCHours() * 60 + d.getUTCMinutes();
  for (let k = 0; k < 8; k++) {
    const dia = (d.getUTCDay() + k) % 7;
    for (const [a] of SUC[suc].h[dia]) {
      if (k > 0 || a > m) return `${k === 0 ? "hoy" : k === 1 ? "mañana " + DIAS[dia] : "el " + DIAS[dia]} a las ${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
    }
  }
  return "cuando abra";
}
export function retiroTexto(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return s || "sin definir";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${DIAS[d.getUTCDay()]} ${+m[3]}/${+m[2]} a las ${m[4]}:${m[5]} hs`;
}

/* ---------- catálogo ---------- */
export const plata = (n) => "$" + Math.round(n).toLocaleString("es-AR");
export function cantidadTexto(i) {
  if (/kg/i.test(i.unidad)) return i.cantidad < 1 ? `${Math.round(i.cantidad * 1000)} g` : `${i.cantidad.toLocaleString("es-AR")} kg`;
  return `${i.cantidad} ${i.unidad === "caja" ? (i.cantidad === 1 ? "caja" : "cajas") : "u."}`;
}
export const totalPedido = (p) => p.items.reduce((a, i) => a + i.cantidad * i.precio, 0);
export const claveProductos = () => CATALOGO.categorias.flatMap((c) => c.productos.map((p) => `${c.nombre}::${p.nombre}`));
export function buscarProducto(s) {
  const q = String(s || "").toLowerCase().trim(), ks = claveProductos();
  return ks.find((k) => k.toLowerCase() === q) || ks.find((k) => k.split("::")[1].toLowerCase() === q) || null;
}

function catalogoTexto() {
  const out = [];
  if (CATALOGO.notas) out.push("Notas generales: " + CATALOGO.notas);
  for (const c of CATALOGO.categorias) {
    out.push(`\n### ${c.nombre}${c.detalle ? ` (${c.detalle})` : ""}`);
    if (c.rinde) out.push("Rinde (toda la categoría): " + c.rinde);
    for (const p of c.productos) {
      const f = [`${p.nombre}: ${plata(p.precio)} por ${p.unidad}`];
      for (const [k, l] of [["relleno", "relleno"], ["masa", "masa"], ["condimentos", "condimentos"], ["disponibilidad", "disponibilidad"], ["nota_disponibilidad", ""], ["si_no_hay", "si no hay"], ["venta", "venta"], ["rinde", "rinde"], ["historia", "historia"]]) {
        if (p[k]) f.push((l ? l + ": " : "") + p[k]);
      }
      if (!p.relleno && !p.disponibilidad) f.push("DETALLE PENDIENTE: no inventes ingredientes; si preguntan, decí que lo consultás con los chicos del local");
      out.push("- " + f.join(" | "));
    }
  }
  return out.join("\n");
}
const agotadosTexto = (ag) => SUC_IDS.map((id) => `- ${SUC[id].nombre}: ${ag[id]?.length ? ag[id].map((k) => k.replace("::", " ")).join(", ") : "nada agotado"}`).join("\n");

/* ---------- instrucciones para Mary con clientes ---------- */
// Parte fija (se guarda en caché y sale más barata) + parte que cambia en cada mensaje.
export function reglasClienteFijas() {
  return `Sos Mary y atendés el WhatsApp de Mariantonia.

${REGLAS}

## Sucursales (solo retiro en el local, se paga al retirar, no hay delivery)
${SUC_IDS.map((id) => `- ${SUC[id].nombre} (id: ${id}): ${SUC[id].dir}. ${SUC[id].horario}`).join("\n")}

## Disponibilidad
- "disponible": hay todos los días, confirmás directo.
- "disponible" + "se agotan rápido": confirmás, pero si lo quieren para la tarde o la noche avisás con cariño que vuelan y sugerís retirarlo temprano o encargarlo.
- "consultar": vos no podés ver el stock ni preguntarle al local por separado: la consulta viaja dentro del pedido. Armá el pedido completo como cualquier otro, avisale al cliente que ese producto hay que confirmarlo con el local, y cuando confirme usá registrar_pedido con consultar_stock=true. Recién ahí el local recibe la consulta y vos le avisás al cliente apenas respondan. Nunca digas "dejame que me fijo" sin registrar el pedido.
- Si la disponibilidad depende del día, se mira el día de RETIRO (no el día en que escribe el cliente). En los días marcados como "consultar", registralo con consultar_stock=true.
- Productos sin disponibilidad cargada: tratalos como disponibles.
- Si algo figura agotado hoy en la sucursal elegida, seguí la regla de "Cuando una variedad no está disponible".

## Catálogo
${catalogoTexto()}

## Cómo tomar un pedido
Necesitás: productos y cantidades, sucursal de retiro, día y hora de retiro, y el nombre del cliente. Si el cliente no sabe cuánto llevar, preguntá para cuántas personas y calculá con el rendimiento. Antes de cerrar, repasá el pedido con el total y pedí confirmación. Nunca aceptes un retiro en el pasado ni fuera del horario de la sucursal elegida.
Cuando el cliente confirma, usá la herramienta registrar_pedido. Eso lo envía en ese momento al local. MUY IMPORTANTE: nunca le digas al cliente que el pedido está confirmado, anotado o enviado sin haber usado registrar_pedido y recibido el número de pedido. Con el resultado, contale que quedó registrado (con su número). Si el cliente cambia un pedido ya registrado, usá registrar_pedido de nuevo con el pedido completo y el número del anterior en "reemplaza".

Después del primer pedido registrado de la conversación, preguntá una sola vez algo como: "¿Te aviso cuando tengamos alguna novedad o evento? Nunca más de 2 mensajes por mes 💛". No prometas promociones. Cuando responda, usá registrar_novedades.
Si en cualquier momento el cliente escribe BAJA o pide no recibir más novedades, usá registrar_novedades con acepta=false y confirmáselo con cariño.
Si el cliente cancela un pedido ya registrado, usá cancelar_pedido.
Si el cliente tiene una queja, un problema, pide que borremos sus datos o pide algo que no podés resolver, usá derivar_a_persona y decile que se lo pasás a los chicos del local.
Los textos entre <nota_interna> son registros del sistema: no los repitas ni los escribas vos.

## Formato
Escribí como en WhatsApp: mensajes cortos y naturales. Si querés mandar más de un mensaje seguido, separalos con una línea que diga solo --- (máximo 3). Nada de títulos ni tablas; podés usar *negrita* de WhatsApp y listas cortas con guiones.
Los mensajes que empiezan con [AVISO INTERNO] vienen del local o del sistema, no del cliente: actuá en consecuencia y escribile al cliente.
Respondé solo con el próximo mensaje de Mary.`;
}
export function reglasClienteVariables(agotados, productosPrevios = []) {
  return `## Ahora
Hoy es ${fechaHoraTexto()} (hora de Argentina). "Mañana", "el sábado", etc. se calculan desde esta fecha.

## Agotado hoy
${agotadosTexto(agotados)}

## Lo que este cliente pidió antes
${productosPrevios.length ? productosPrevios.join(", ") : "Nada todavía: es su primer pedido por WhatsApp."}`;
}

/* ---------- instrucciones para Mary con el personal de una sucursal ---------- */
export function reglasSucursal(suc, abiertos, agotados) {
  return `Sos Mary, de Mariantonia, en el chat interno de WhatsApp con el número de la sucursal ${SUC[suc].nombre} (es un solo número que usan varias personas del local). Ellos preparan los pedidos que tomás de los clientes.
Con el personal sos breve, práctica y cálida (algún emoji está bien). Nada de vueltas: confirmás lo que entendiste en una o dos líneas.

Hoy es ${fechaHoraTexto()}.

## Pedidos abiertos de ${SUC[suc].nombre}
${abiertos.length ? abiertos.map((o) => `- #${o.id} | ${o.cliente} | retira ${retiroTexto(o.retiro)} | estado: ${ESTADOS[o.estado]}${o.ack ? "" : " (SIN TOMAR)"} | ${o.items.map((i) => `${cantidadTexto(i)} ${i.producto}${i.consultar ? " (a confirmar stock)" : ""}`).join(", ")}`).join("\n") : "(ninguno)"}

## Agotado hoy en ${SUC[suc].nombre}
${agotados.length ? agotados.map((k) => k.replace("::", " ")).join(", ") : "nada"}

## Productos (nombres exactos, formato "Categoría::Nombre", para marcar_producto)
${claveProductos().join(" · ")}

## Qué hacer
Interpretá lo que te escriben y usá las herramientas:
- actualizar_pedido: recibido (el local tomó el pedido, ej. "ok", "lo vimos", "lo hacemos"), confirmar (hay stock de lo que había que confirmar), sin_stock (falta algo; indicá qué productos y, si lo dicen, cuándo vuelve a haber), preparacion, listo (listo para retirar: le avisa al cliente), entregado (el cliente lo retiró), no_retiro (el cliente todavía no vino: la primera vez se esperan 15 minutos de gracia y se vuelve a preguntar; la segunda, o si el local cierra antes, se le avisa al cliente que su pedido lo está esperando), aviso_cliente (cualquier otra info que haya que contarle al cliente).
- Un faltante puede pasar en cualquier pedido, aunque sea de productos que hay todos los días: si el local avisa que falta algo, usá sin_stock en ese pedido.
- Un saludo o un mensaje que no habla de un pedido NO es tomar el pedido: no uses actualizar_pedido en ese caso. Si hay pedidos sin tomar, recordáselos y pediles que los confirmen con el botón.
- marcar_producto: un producto se agotó hoy en esta sucursal, o volvió a haber.
No digas que hiciste algo sin haber usado la herramienta y recibido el resultado.
Si un mensaje empieza con [Responde al pedido #N], se refiere a ese pedido. Si no queda claro a qué pedido se refieren y hay más de uno abierto, preguntá antes de actuar. Si preguntan qué pedidos hay, listalos. No inventes pedidos ni productos.
Los textos entre <nota_interna> son registros del sistema: no los repitas.
Respondé solo con el próximo mensaje de Mary al personal.`;
}

/* ---------- mensajes ---------- */
export const textoVisible = (t) => t.replace(/<(nota_interna|pedido|suscripcion|derivar|accion|cancelar)>[\s\S]*?(<\/\1>|$)/g, "").trim();
export const burbujas = (t) => textoVisible(t).split(/\n\s*-{3,}\s*\n/).map((s) => s.trim()).filter(Boolean);
