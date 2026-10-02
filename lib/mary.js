// La llamada a Claude: la "cabeza" de Mary.
import Anthropic from "@anthropic-ai/sdk";
import { registrarError } from "./db.js";

const client = new Anthropic(); // usa ANTHROPIC_API_KEY
const MODELO = process.env.CLAUDE_MODEL || "claude-haiku-4-5";

// Los turnos guardados se convierten al formato de la API: empiezan por "user"
// y dos mensajes seguidos del mismo lado se juntan en uno.
export function aMensajes(turnos, max = 30) {
  const out = [];
  for (const t of turnos.slice(-max)) {
    if (t.role !== "user" && t.role !== "assistant") continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === t.role) prev.content += "\n\n" + t.content;
    else out.push({ role: t.role, content: t.content });
  }
  if (out[0]?.role === "assistant") out.unshift({ role: "user", content: "[Inicio de la conversación]" });
  return out;
}

// herramientas: [{ name, description, input_schema, ejecutar(input) }]
// Mary puede usarlas (registrar un pedido, actualizar un estado…); el código las ejecuta
// y le devuelve el resultado para que siga escribiendo.
// cache: la parte "fijo" se guarda en caché 5 minutos (más barato) — solo conviene si no cambia entre mensajes.
// Devuelve { texto, notas }: lo que Mary escribió y un resumen de las herramientas que usó.
export async function pensar({ fijo, variable, turnos, cache = true, herramientas = [] }) {
  const system = [
    { type: "text", text: fijo, ...(cache ? { cache_control: { type: "ephemeral" } } : {}) },
    ...(variable ? [{ type: "text", text: variable }] : []),
  ];
  const tools = herramientas.map(({ ejecutar, ...def }) => def);
  const messages = aMensajes(turnos);
  const partes = [], notas = [];

  for (let ronda = 0; ronda < 5; ronda++) {
    const r = await client.messages.create({
      model: MODELO,
      max_tokens: 1500,
      system,
      messages,
      ...(tools.length ? { tools } : {}),
    });
    const texto = r.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    if (texto) partes.push(texto);
    const usos = r.content.filter((b) => b.type === "tool_use");
    if (r.stop_reason !== "tool_use" || !usos.length) break;

    messages.push({ role: "assistant", content: r.content });
    const resultados = [];
    for (const u of usos) {
      const h = herramientas.find((x) => x.name === u.name);
      let salida, error = false;
      try {
        if (!h) throw new Error(`No existe la herramienta ${u.name}`);
        salida = String(await h.ejecutar(u.input || {}));
      } catch (e) {
        salida = `Error: ${e.message}`;
        error = true;
        console.error(`Herramienta ${u.name} falló:`, e);
        await registrarError(`Herramienta ${u.name} falló: ${e.message}`);
      }
      notas.push(`${u.name} → ${salida}`);
      resultados.push({ type: "tool_result", tool_use_id: u.id, content: salida, ...(error ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: resultados });
  }
  return { texto: partes.join("\n---\n"), notas };
}
