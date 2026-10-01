// La llamada a Claude: la "cabeza" de Mary.
import Anthropic from "@anthropic-ai/sdk";

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

// cache: la parte "fijo" se guarda en caché 5 minutos (más barato) — solo conviene si no cambia entre mensajes.
export async function pensar({ fijo, variable, turnos, cache = true }) {
  const r = await client.messages.create({
    model: MODELO,
    max_tokens: 1500,
    system: [
      { type: "text", text: fijo, ...(cache ? { cache_control: { type: "ephemeral" } } : {}) },
      ...(variable ? [{ type: "text", text: variable }] : []),
    ],
    messages: aMensajes(turnos),
  });
  return r.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}
