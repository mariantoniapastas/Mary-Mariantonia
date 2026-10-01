// Envío de mensajes por la WhatsApp Cloud API de Meta.
const API = "https://graph.facebook.com/v23.0";

async function llamar(payload) {
  const r = await fetch(`${API}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data?.error?.message || `WhatsApp respondió ${r.status}`);
    e.code = data?.error?.code;
    throw e;
  }
  return data;
}

const idDe = (data) => data?.messages?.[0]?.id || null;

// Celulares argentinos: Meta informa al que escribe como 549XXXXXXXXXX, pero a veces solo acepta
// enviarle a 54XXXXXXXXXX (sin el 9). Si rechaza por "número no permitido", reintentamos sin el 9.
async function enviar(to, payload) {
  to = String(to);
  try {
    return idDe(await llamar({ to, ...payload }));
  } catch (e) {
    if (e.code === 131030 && /^549\d{10}$/.test(to)) {
      return idDe(await llamar({ to: "54" + to.slice(3), ...payload }));
    }
    console.error(`WhatsApp no pudo enviar a ${to} (código ${e.code}): ${e.message}`);
    throw e;
  }
}

export async function enviarTexto(to, texto) {
  return enviar(to, { type: "text", text: { body: texto.slice(0, 4096), preview_url: false } });
}

// botones: [[id, titulo], ...] — WhatsApp admite hasta 3, con títulos de hasta 20 caracteres.
export async function enviarBotones(to, texto, botones) {
  return enviar(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: texto.slice(0, 1024) },
      action: { buttons: botones.slice(0, 3).map(([id, title]) => ({ type: "reply", reply: { id, title: title.slice(0, 20) } })) },
    },
  });
}

// Marca el mensaje como leído y muestra "escribiendo…" mientras Mary piensa.
export async function marcarLeido(messageId) {
  try {
    await llamar({ status: "read", message_id: messageId, typing_indicator: { type: "text" } });
  } catch {
    // no es crítico
  }
}
