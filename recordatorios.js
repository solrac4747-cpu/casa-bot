// Bot de recordatorios de la casa (WhatsApp, vía Whapi.cloud).
// Lee los datos de la app en Supabase y manda los avisos al grupo.
// Requiere Node 18 o superior (usa fetch). No tiene dependencias.

const TZ = "America/Tijuana";                 // Mexicali
const H = ["Bryan/Uriel", "Ricardo", "Carlos", "Erick"];
const PAGO_IMELDA_DOW = 2;                    // día del pago a Imelda: martes (0=domingo ... 6=sábado)
const HORA_NOCHE = 20;                        // recordatorios de basura/Imelda: desde las 8:00 pm
const HORA_RENTA = 9;
const HORA_RECIBOS = 9;                       // alertas de recibos (48 h y 24 h antes): desde las 9:00 am                         // aviso de renta el día 4: desde las 9:00 am

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
let DB = {}, HOY = "";
const G = () => DB.global;
const hoyStr = () => HOY;
const weekBoss = w => {
  const W = DB["sem-" + w]; if (W && W.boss != null) return W.boss;
  let bw = G().aW, bb = G().aB;
  for (const k in DB) if (k.startsWith("sem-") && DB[k].boss != null) { const d = k.slice(4); if (d < w && d >= bw) { bw = d; bb = DB[k].boss; } }
  return mod4(bb + Math.round(diffDays(w, bw) / 7));
};
const monthBoss = m => {
  const M = DB["mes-" + m]; if (M && M.boss != null) return M.boss;
  let bm = G().aM, bb = G().aR;
  for (const k in DB) if (k.startsWith("mes-") && DB[k].boss != null) { const d = k.slice(4); if (d < m && d >= bm) { bm = d; bb = DB[k].boss; } }
  return mod4(bb + mIdx(m) - mIdx(bm));
};
const missed = (w, k) => {
  const W = DB["sem-" + w] || {};
  return w >= G().aW && !W[k === "L" ? "basuraLun" : "basuraJue"] && HOY > addDays(w, k === "L" ? 0 : 3);
};

/* ===== NÚCLEO DE BASURA (idéntico en la app y en el bot) ===== */
let SIM = null;
const rangos = () => (DB.ausencias || {}).r || [];
const away = (p, d) => rangos().some(x => x.p === p && d >= x.d1 && d <= x.d2);
function slots() {
  if (SIM) return SIM;
  const g = G(), S = {}, deudas = [], last = addDays(hoyStr(), 7 * 60);
  for (let w = g.aW; w <= last; w = addDays(w, 7)) {
    const W = DB["sem-" + w] || {}, p = addDays(w, -7), boss = weekBoss(w);
    ["L", "J"].forEach(k => {
      const date = k === "L" ? w : addDays(w, 3), sw = W[k === "L" ? "swapLun" : "swapJue"];
      let base = boss;
      if (p >= g.aW) {
        if (k === "L") base = missed(p, "L") ? S[p + "L"].o : missed(p, "J") ? S[p + "J"].o : boss;
        else base = missed(p, "L") && missed(p, "J") ? S[p + "J"].o : boss;
      }
      let o = sw != null ? sw : base;
      const s = { base, date, swap: sw != null };
      const d = sw == null ? deudas.find(x => !x.pagada && x.acreedor === o && x.date < date && !away(x.deudor, date)) : null;
      if (d) { d.pagada = date; s.repone = { acreedor: o, deudor: d.deudor }; o = d.deudor; }
      if (away(o, date)) {
        let c = mod4(o + 1), n = 0;
        while (away(c, date) && n++ < 3) c = mod4(c + 1);
        if (c !== o) { deudas.push({ deudor: o, acreedor: c, date, pagada: null }); s.cubre = { titular: o }; o = c; }
      }
      s.o = o; S[w + k] = s;
    });
  }
  return (SIM = { S, deudas });
}
const monOwner = w => { const x = slots().S[w + "L"]; return x ? x.o : weekBoss(w); };
const thuOwner = w => { const x = slots().S[w + "J"]; return x ? x.o : weekBoss(w); };
const deudaBasura = () => slots().deudas.filter(x => !x.pagada);


const cuentaTxt = i => {
  const c = (DB.cuentas || {})[i] || {};
  return c.num ? `Depositar a ${H[i]}${c.ben ? " (" + c.ben + ")" : ""}${c.bank ? " · " + c.bank : ""} · CLABE ${c.num}` : `Depositar a ${H[i]} (su CLABE aún no está capturada en la app)`;
};

function planear(DBin, now) {
  DB = DBin; HOY = now.date; SIM = null;
  if (!G()) return [];
  const out = [], tk = i => `{{${i}}}`;
  const manana = addDays(now.date, 1), dowM = dowOf(manana), wk = mondayOf(manana);

  if (now.hour >= HORA_NOCHE) {
    if (dowM === 1 || dowM === 4) {
      const k = dowM === 1 ? "L" : "J", x = slots().S[wk + k];
      if (x) {
        let t = `🗑️ Recordatorio: mañana ${k === "L" ? "lunes" : "jueves"} pasa la basura. Le toca sacarla a ${tk(x.o)}.`;
        if (x.cubre) t += ` 🧳 Cubre a ${H[x.cubre.titular]}, que está fuera de casa; ${H[x.cubre.titular]} le repone un turno.`;
        else if (x.repone) t += ` 🔁 Es la reposición del turno que ${H[x.repone.acreedor]} le cubrió.`;
        else if (x.swap) t += ` (Cambio puntual; le tocaba a ${H[x.base]}.)`;
        else if (x.base !== weekBoss(wk)) t += " (Es su compensación por un turno no sacado.)";
        out.push({ key: `${manana}-${k === "L" ? "lun" : "jue"}`, texto: t });
      }
    }
    if (PAGO_IMELDA_DOW !== null && dowM === PAGO_IMELDA_DOW) {
      out.push({ key: `${manana}-imelda`, texto: `💵 Recordatorio: mañana toca el pago a Imelda. Le toca a ${tk(weekBoss(wk))}.` });
    }
  }

  if (now.day === 4 && now.hour >= HORA_RENTA) {
    const rent = arr((DB["mes-" + now.month] || {}).rent), pend = H.filter((h, i) => !rent[i]);
    if (pend.length) out.push({ key: `${now.month}-renta`, texto: `📅 Recordatorio de renta: hoy es 4 y la renta se paga antes del día 5. Encargado de cobrar este mes: ${tk(monthBoss(now.month))}. Todavía no aparecen como pagados: ${pend.join(", ")}. Márquenlo en la app cuando paguen.` });
  }

  if (now.hour >= HORA_RECIBOS) {
    const carlos = H.indexOf("Carlos");
    Object.keys(DB).filter(k => k.startsWith("mes-")).forEach(id => {
      const M = DB[id], items = [];
      (M.rec || []).forEach(x => items.push({ id: "r" + x.id, n: x.n, due: x.due, enc: x.enc, q: x.m / 4, paid: arr(x.paid) }));
      [["internet", "Internet", 225], ["luz", "Luz"], ["agua", "Agua"], ["gas", "Gas"]].forEach(([k, n, fx]) => {
        const t = (M.tot || {})[k] || 0;
        if ((M.due || {})[k] && (fx || t > 0)) items.push({ id: k, n, due: M.due[k], enc: carlos, q: fx || t / 4, paid: arr((M.svc || {})[k]) });
      });
      items.forEach(it => {
        const dl = diffDays(it.due, now.date), pend = [0, 1, 2, 3].filter(i => !it.paid[i]);
        if ((dl !== 1 && dl !== 2) || !pend.length) return;
        out.push({ key: `${id}-${it.id}-${dl === 2 ? "48h" : "24h"}`, texto: `⏰ ${dl === 2 ? "Faltan 48 horas" : "Falta 1 día (24 h)"} para pagar ${it.n} (límite ${it.due}). Cuota: $${it.q.toFixed(2)} c/u. Pendientes: ${pend.map(tk).join(", ")}. ${cuentaTxt(it.enc)}` });
      });
    });
  }
  return out;
}

/* ---------- Envío ---------- */
function armar(texto, TEL, MAP = {}) {
  const nums = [];
  const t = texto.replace(/\{\{(\d)\}\}/g, (m, i) => {
    const v = TEL[H[+i]]; const lista = (Array.isArray(v) ? v : v ? [v] : []).map(n => String(n).replace(/\D/g, "")).map(n => MAP[n.slice(-10)] || n);
    if (!lista.length) return H[+i];
    nums.push(...lista);
    return lista.map(n => "@" + n).join(" y ");
  });
  return { texto: t, nums };
}

async function mapaParticipantes(GRUPO, TOKEN) {
  try {
    const r = await fetch(`https://gate.whapi.cloud/groups/${encodeURIComponent(GRUPO)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!r.ok) { console.log("No pude leer los participantes del grupo:", r.status); return {}; }
    const g = await r.json(), map = {};
    (g.participants || []).forEach(p => { const d = String(p.id || "").split("@")[0].replace(/\D/g, ""); if (d.length >= 10) map[d.slice(-10)] = d; });
    return map;
  } catch (e) { console.log("No pude leer los participantes del grupo:", e.message); return {}; }
}

async function main() {
  const { SUPABASE_URL: U, SUPABASE_KEY: K, WHAPI_TOKEN, GRUPO_ID, TELEFONOS, PRUEBA, DRY_RUN } = process.env;
  const TEL = JSON.parse(TELEFONOS || "{}");
  const GRUPO = (GRUPO_ID || "").trim().replace(/^["']+|["']+$/g, "");
  const TOKEN = (WHAPI_TOKEN || "").trim();
  if (!GRUPO && !DRY_RUN) throw new Error("El secreto GRUPO_ID esta vacio o no existe");
  const sb = (path, opt = {}) => fetch(`${U}/rest/v1/${path}`, { ...opt, headers: { apikey: K, Authorization: `Bearer ${K}`, "Content-Type": "application/json", ...(opt.headers || {}) } });
  const enviar = async ({ texto, nums }) => {
    if (DRY_RUN) { console.log("[DRY_RUN]", texto, nums); return; }
    const r = await fetch("https://gate.whapi.cloud/messages/text", {
      method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: GRUPO, body: texto, mentions: nums })
    });
    if (!r.ok) throw new Error("Whapi: " + r.status + " " + await r.text());
  };

  const MAP = DRY_RUN ? {} : await mapaParticipantes(GRUPO, TOKEN);
  if (Object.keys(MAP).length) {
    Object.entries(TEL).forEach(([n, v]) => (Array.isArray(v) ? v : [v]).forEach(x => {
      const d = String(x).replace(/\D/g, ""); console.log(MAP[d.slice(-10)] ? `OK ${n}: ${MAP[d.slice(-10)]}` : `AVISO ${n}: el numero ${d} no aparece en el grupo`);
    }));
  }
  if (PRUEBA === "true" || PRUEBA === "1") { await enviar(armar("✅ Prueba del bot de la casa. Hola {{1}}", TEL, MAP)); console.log("Prueba enviada"); return; }

  const res = await sb("estado?select=id,data");
  if (!res.ok) throw new Error("Supabase: " + res.status + " " + await res.text());
  const DB = {}; (await res.json()).forEach(r => { DB[r.id] = r.data; });
  const sent = (DB.bot && DB.bot.sent) || {};
  const now = ahora();
  let cambio = false;

  for (const m of planear(DB, now)) {
    if (sent[m.key]) continue;
    await enviar(armar(m.texto, TEL, MAP));
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
