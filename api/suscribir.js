// Suscribe la cuenta de WhatsApp Business a la app, para que Meta mande los mensajes al webhook.
// Uso (una sola vez): https://TU-PROYECTO.vercel.app/api/suscribir?clave=CRON_SECRET&waba=ID_DE_LA_CUENTA
const API = "https://graph.facebook.com/v23.0";

export async function GET(request) {
  const u = new URL(request.url);
  if (!process.env.CRON_SECRET || u.searchParams.get("clave") !== process.env.CRON_SECRET) {
    return new Response("No autorizado", { status: 401 });
  }
  const waba = u.searchParams.get("waba") || "";
  if (!/^\d+$/.test(waba)) return Response.json({ error: "Falta ?waba= con el identificador de la cuenta de WhatsApp" }, { status: 400 });

  const headers = { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
  const url = `${API}/${waba}/subscribed_apps`;
  const alta = await fetch(url, { method: "POST", headers }).then((r) => r.json()).catch((e) => ({ error: e.message }));
  const apps = await fetch(url, { headers }).then((r) => r.json()).catch((e) => ({ error: e.message }));
  return Response.json({ alta, apps_suscriptas: apps });
}
