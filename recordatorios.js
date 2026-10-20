// Bot de recordatorios de la casa (WhatsApp, vía Whapi.cloud).
// Lee los datos de la app en Supabase y manda los avisos al grupo.
// Requiere Node 18 o superior (usa fetch). No tiene dependencias.

const TZ = "America/Tijuana";                 // Mexicali
const H = ["Bryan/Uriel", "Ricardo", "Carlos", "Erick"];
const PAGO_IMELDA_DOW = 2;                    // día del pago a Imelda: martes (0=domingo ... 6=sábado)
const HORA_NOCHE = 20;                        // recordatorios de basura/Imelda: desde las 8:00 pm
const HORA_RENTA = 9;                         // aviso de renta el día 4: desde las 9:00 am

/* ---------- Fechas ---------- */
const mod4 = n => ((n % 4) + 4) % 4;
const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diffDays = (a, b) => Math.round((new Date(a + "T00:00:00Z") - new Date(b + "T00:00:00Z")) / 864e5);
const dowOf = s => new Date(s + "T00:00:00Z").getUTCDay();
const mondayOf = s => addDays(s, -((dowOf(s) + 6) % 7));
const mIdx = m => { const [y, n] = m.split("-").map(Number); return y * 12 + n - 1; };
const arr = a => (a && a.length === 4 ? a : [false, false, false, false]);

function ahora(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, day: +p.day, month: `${p.year}-${p.month}` };
}

/* ---------- Mismas reglas que la app ---------- */
function planear(DB, now) {
  const G = DB.global;
  if (!G) return [];
  const weekBoss = w => {
    const W = DB["sem-" + w]; if (W && W.boss != null) return W.boss;
    let bw = G.aW, bb = G.aB;
    for (const k in DB) if (k.startsWith("sem-") && DB[k].boss != null) { const d = k.slice(4); if (d < w && d >= bw) { bw = d; bb = DB[k].boss; } }
    return mod4(bb + Math.round(diffDays(w, bw) / 7));
  };
  const monthBoss = m => {
    const M = DB["mes-" + m]; if (M && M.boss != null) return M.boss;
    let bm = G.aM, bb = G.aR;
    for (const k in DB) if (k.startsWith("mes-") && DB[k].boss != null) { const d = k.slice(4); if (d < m && d >= bm) { bm = d; bb = DB[k].boss; } }
    return mod4(bb + mIdx(m) - mIdx(bm));
  };
  const missed = (w, k) => {
    const W = DB["sem-" + w] || {};
    return w >= G.aW && !W[k === "L" ? "basuraLun" : "basuraJue"] && now.date > addDays(w, k === "L" ? 0 : 3);
  };
  const thuOwner = w => { const p = addDays(w, -7); return p < G.aW ? weekBoss(w) : (missed(p, "L") && missed(p, "J") ? thuOwner(p) : weekBoss(w)); };
  const monOwner = w => {
    const p = addDays(w, -7);
    if (p < G.aW) return weekBoss(w);
    if (missed(p, "L")) return monOwner(p);
    if (missed(p, "J")) return thuOwner(p);
    return weekBoss(w);
  };

  const out = [], tk = i => `{{${i}}}`;
  const manana = addDays(now.date, 1), dowM = dowOf(manana), wk = mondayOf(manana);

  if (now.hour >= HORA_NOCHE) {
    if (dowM === 1) {
      const o = monOwner(wk);
      out.push({ key: `${manana}-lun`, texto: `🗑️ Recordatorio: mañana lunes pasa la basura. Le toca sacarla a ${tk(o)}.${o !== weekBoss(wk) ? " (Es su compensación por la semana pasada.)" : ""}` });
    }
    if (dowM === 4) {
      const o = thuOwner(wk);
      out.push({ key: `${manana}-jue`, texto: `🗑️ Recordatorio: mañana jueves pasa la basura. Le toca sacarla a ${tk(o)}.${o !== weekBoss(wk) ? " (Se recorrió de la semana pasada.)" : ""}` });
    }
    if (PAGO_IMELDA_DOW !== null && dowM === PAGO_IMELDA_DOW) {
      out.push({ key: `${manana}-imelda`, texto: `💵 Recordatorio: mañana toca el pago a Imelda. Le toca a ${tk(weekBoss(wk))}.` });
    }
  }

  if (now.day === 4 && now.hour >= HORA_RENTA) {
    const rent = arr((DB["mes-" + now.month] || {}).rent);
    const pend = H.filter((h, i) => !rent[i]);
    if (pend.length) {
      out.push({ key: `${now.month}-renta`, texto: `📅 Recordatorio de renta: hoy es 4 y la renta se paga antes del día 5. Encargado de cobrar este mes: ${tk(monthBoss(now.month))}. Todavía no aparecen como pagados: ${pend.join(", ")}. Márquenlo en la app cuando paguen.` });
    }
  }
  return out;
}

/* ---------- Envío ---------- */
function armar(texto, TEL) {
  const nums = [];
  const t = texto.replace(/\{\{(\d)\}\}/g, (m, i) => {
    const v = TEL[H[+i]]; const lista = (Array.isArray(v) ? v : v ? [v] : []).map(n => String(n).replace(/\D/g, ""));
    if (!lista.length) return H[+i];
    nums.push(...lista);
    return lista.map(n => "@" + n).join(" y ");
  });
  return { texto: t, nums };
}

async function main() {
  const { SUPABASE_URL: U, SUPABASE_KEY: K, WHAPI_TOKEN, GRUPO_ID, TELEFONOS, PRUEBA, DRY_RUN } = process.env;
  const TEL = JSON.parse(TELEFONOS || "{}");
  const sb = (path, opt = {}) => fetch(`${U}/rest/v1/${path}`, { ...opt, headers: { apikey: K, Authorization: `Bearer ${K}`, "Content-Type": "application/json", ...(opt.headers || {}) } });
  const enviar = async ({ texto, nums }) => {
    if (DRY_RUN) { console.log("[DRY_RUN]", texto, nums); return; }
    const r = await fetch("https://gate.whapi.cloud/messages/text", {
      method: "POST", headers: { Authorization: `Bearer ${WHAPI_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: GRUPO_ID, body: texto, mentions: nums })
    });
    if (!r.ok) throw new Error("Whapi: " + r.status + " " + await r.text());
  };

  if (PRUEBA === "true" || PRUEBA === "1") { await enviar(armar("✅ Prueba del bot de la casa. Hola {{1}}", TEL)); console.log("Prueba enviada"); return; }

  const res = await sb("estado?select=id,data");
  if (!res.ok) throw new Error("Supabase: " + res.status + " " + await res.text());
  const DB = {}; (await res.json()).forEach(r => { DB[r.id] = r.data; });
  const sent = (DB.bot && DB.bot.sent) || {};
  const now = ahora();
  let cambio = false;

  for (const m of planear(DB, now)) {
    if (sent[m.key]) continue;
    await enviar(armar(m.texto, TEL));
    sent[m.key] = true; cambio = true;
    console.log("Enviado:", m.key);
  }
  if (cambio && !DRY_RUN) {
    const corte = addDays(now.date, -40).slice(0, 7);
    Object.keys(sent).forEach(k => { if (k.slice(0, 7) < corte) delete sent[k]; });
    await sb("estado", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify([{ id: "bot", data: { sent } }]) });
  } else if (!cambio) console.log("Nada que enviar ahora", now);
}

module.exports = { planear, armar, ahora };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
