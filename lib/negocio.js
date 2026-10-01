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
      for (const [k, l] of [["relleno", "relleno"], ["masa", "masa"], ["condimentos", "condimentos"], ["disponibilidad", "disponibilidad"], ["nota_disponibilidad", ""], ["si_no_hay", "si no hay"], ["venta", "venta"], ["rinde", "rinde"]]) {
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
- "consultar": no lo confirmes directo; decí que le preguntás al local y que le confirmás apenas te respondan. Registralo con consultar_stock=true.
- Productos sin disponibilidad cargada: tratalos como disponibles.
- Si algo figura agotado hoy en la sucursal elegida, seguí la regla de "Cuando una variedad no está disponible".

## Catálogo
${catalogoTexto()}

## Cómo tomar un pedido
Necesitás: productos y cantidades, sucursal de retiro, día y hora de retiro, y el nombre del cliente. Si el cliente no sabe cuánto llevar, preguntá para cuántas personas y calculá con el rendimiento. Antes de cerrar, repasá el pedido con el total y pedí confirmación. Nunca aceptes un retiro en el pasado ni fuera del horario de la sucursal elegida.
Recién cuando el cliente confirma, agregá AL FINAL de tu mensaje, en una sola línea, esta etiqueta con JSON válido (el cliente no la ve). El pedido se envía en ese momento al local:
<pedido>{"cliente":"Nombre","sucursal":"bernal|quilmes|donbosco","retiro":"AAAA-MM-DDTHH:MM","items":[{"producto":"Ravioles caseros Provolone","cantidad":2,"unidad":"caja","precio_unitario":10900,"consultar_stock":false}],"notas":""}</pedido>
Para productos por kg, "cantidad" va en kg (ej: 0.5). Si el cliente cambia un pedido ya registrado, mandá una etiqueta <pedido> nueva y completa.

Después del primer pedido confirmado de la conversación, preguntá una sola vez algo como: "¿Te aviso cuando tengamos alguna novedad o evento? Nunca más de 2 mensajes por mes 💛". No prometas promociones. Cuando responda, agregá <suscripcion>si</suscripcion> o <suscripcion>no</suscripcion>.
Si el cliente cancela un pedido ya registrado, agregá <cancelar>motivo breve</cancelar>.
Si el cliente tiene una queja, un problema o pide algo que no podés resolver, decí que le pasás la charla a los chicos del local y agregá <derivar>motivo breve</derivar>.

## Formato
Escribí como en WhatsApp: mensajes cortos y naturales. Si querés mandar más de un mensaje seguido, separalos con una línea que diga solo --- (máximo 3). Nada de títulos ni tablas; podés usar *negrita* de WhatsApp y listas cortas con guiones.
Los mensajes que empiezan con [AVISO INTERNO] vienen del local o del sistema, no del cliente: actuá en consecuencia y escribile al cliente.
Respondé solo con el próximo mensaje de Mary.`;
}
export function reglasClienteVariables(agotados) {
  return `## Ahora
Hoy es ${fechaHoraTexto()} (hora de Argentina). "Mañana", "el sábado", etc. se calculan desde esta fecha.

## Agotado hoy
${agotadosTexto(agotados)}`;
}

/* ---------- instrucciones para Mary con el personal de una sucursal ---------- */
export function reglasSucursal(suc, abiertos, agotados) {
  return `Sos Mary, de Mariantonia, en el chat interno de WhatsApp con el número de la sucursal ${SUC[suc].nombre} (es un solo número que usan varias personas del local). Ellos preparan los pedidos que tomás de los clientes.
Con el personal sos breve, práctica y cálida (algún emoji está bien). Nada de vueltas: confirmás lo que entendiste en una o dos líneas.

Hoy es ${fechaHoraTexto()}.

## Pedidos abiertos de ${SUC[suc].nombre}
${abiertos.length ? abiertos.map((o) => `- #${o.id} | ${o.cliente} | retira ${retiroTexto(o.retiro)} | estado: ${ESTADOS[o.estado]} | ${o.items.map((i) => `${cantidadTexto(i)} ${i.producto}${i.consultar ? " (a confirmar stock)" : ""}`).join(", ")}`).join("\n") : "(ninguno)"}

## Agotado hoy en ${SUC[suc].nombre}
${agotados.length ? agotados.map((k) => k.replace("::", " ")).join(", ") : "nada"}

## Productos (usá estos nombres exactos, formato "Categoría::Nombre", para agotado/repuesto)
${claveProductos().join(" · ")}

## Qué hacer
Interpretá lo que te escriben. Cuando corresponda una acción, agregala AL FINAL de tu respuesta con una etiqueta por acción, JSON válido en una línea:
<accion>{"tipo":"confirmar","pedido":1024}</accion>  hay stock de todo lo que había que confirmar
<accion>{"tipo":"sin_stock","pedido":1024,"productos":["Ravioles caseros Sin sal"],"cuando_hay":"mañana a las 10"}</accion>  falta algo (cuando_hay vacío si no lo dicen)
<accion>{"tipo":"preparacion","pedido":1024}</accion>
<accion>{"tipo":"listo","pedido":1024}</accion>  listo para retirar
<accion>{"tipo":"entregado","pedido":1024}</accion>
<accion>{"tipo":"agotado","producto":"Ravioles caseros::Provolone"}</accion>  se terminó un producto hoy en esta sucursal
<accion>{"tipo":"repuesto","producto":"Ravioles caseros::Provolone"}</accion>  volvió a haber
<accion>{"tipo":"aviso_cliente","pedido":1024,"texto":"lo que hay que contarle al cliente"}</accion>  cualquier otra info para el cliente
Si un mensaje empieza con [Responde al pedido #N], se refiere a ese pedido. Si no queda claro a qué pedido se refieren y hay más de uno abierto, preguntá antes de actuar. Si preguntan qué pedidos hay, listalos. No inventes pedidos ni productos.
Respondé solo con el próximo mensaje de Mary al personal.`;
}

/* ---------- mensajes ---------- */
export const textoVisible = (t) => t.replace(/<(pedido|suscripcion|derivar|accion|cancelar)>[\s\S]*?(<\/\1>|$)/g, "").trim();
export const burbujas = (t) => textoVisible(t).split(/\n\s*-{3,}\s*\n/).map((s) => s.trim()).filter(Boolean);
