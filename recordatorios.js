// Bot de recordatorios de la casa (WhatsApp, vía Evolution API v2).
// Lee los datos de la app en Supabase y manda los avisos al grupo.
// Requiere Node 18 o superior (usa fetch). Sin dependencias externas.

const TZ = "America/Tijuana";                               // Mexicali
const H = ["Bryan/Uriel", "Ricardo", "Erick", "Carlos"];    // orden oficial
const CAP_G = 6;                                            // capacidad total de garrafones

const EVOLUTION_URL = process.env.EVOLUTION_URL || "https://evolution-api-4upu.onrender.com";
const EVOLUTION_APIKEY = process.env.EVOLUTION_APIKEY || "MiClaveSeguraCasa2026";
const INSTANCE = process.env.EVOLUTION_INSTANCE || "casa-bot";
const DEFAULT_GRUPO = "120363398553193180@g.us";

/* Intercambio de índices 2 y 3 para compatibilidad histórica con Supabase */
const sw = i => (i === 2 ? 3 : i === 3 ? 2 : i);
const swArr = a => (Array.isArray(a) && a.length === 4 ? [a[0], a[1], a[3], a[2]] : a);
function ordenDoc(id, d) {
  if (!d || typeof d !== "object") return d;
  const x = JSON.parse(JSON.stringify(d)), num = (o, k) => { if (typeof o[k] === "number") o[k] = sw(o[k]); };
  if (id === "global") ["water", "aB", "aR"].forEach(k => num(x, k));
  else if (id.startsWith("sem-")) ["boss", "swapLun", "swapJue"].forEach(k => num(x, k));
  else if (id.startsWith("mes-")) {
    num(x, "boss");
    if (x.rent) x.rent = swArr(x.rent);
    if (x.svc) Object.keys(x.svc).forEach(k => { x.svc[k] = swArr(x.svc[k]); });
    (x.rec || []).forEach(r => { if (r.paid) r.paid = swArr(r.paid); num(r, "enc"); });
    (x.shop || []).forEach(s => { if (s.paid) s.paid = swArr(s.paid); });
  } else if (id === "cuentas") {
    const a = x[2], b = x[3]; delete x[2]; delete x[3];
    if (b !== undefined) x[2] = b;
    if (a !== undefined) x[3] = a;
  } else if (id === "ausencias") (x.r || []).forEach(r => num(r, "p"));
  return x;
}

const PAGO_IMELDA_DOW = 2;  // Martes
const HORA_BASURA = 20;     // 8:00 PM Mexicali (un día antes: domingo y miércoles)
const HORA_IMELDA = 16;     // 4:00 PM Mexicali (un día antes: lunes)
const HORA_RENTA = 9;       // 9:00 AM Mexicali
const HORA_COMPRAS = 14;    // 2:00 PM Mexicali (liquidación compras)
const HORA_RECIBOS = 9;     // 9:00 AM Mexicali (servicios y recibos)

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

/* ---------- Reglas de negocio de la casa ---------- */
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

/* ===== Núcleo de Basura ===== */
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

const cuentaTxt = i => {
  const c = (DB.cuentas || {})[i] || {};
  return c.num ? `Depositar a ${H[i]}${c.ben ? " (" + c.ben + ")" : ""}${c.bank ? " · " + c.bank : ""} · CLABE ${c.num}` : `Depositar a ${H[i]} (CLABE no capturada aún)`;
};

function planear(DBin, now) {
  DB = DBin; HOY = now.date; SIM = null;
  if (!G()) return [];
  const out = [], tk = i => `{{${i}}}`;
  const manana = addDays(now.date, 1), dowM = dowOf(manana), wk = mondayOf(manana);

  // Recordatorio de basura: un día antes a las 8:00 PM (domingo y miércoles)
  if (now.hour >= HORA_BASURA && (dowM === 1 || dowM === 4)) {
    const k = dowM === 1 ? "L" : "J", x = slots().S[wk + k];
    if (x) {
      let t = `🗑️ Recordatorio: mañana ${k === "L" ? "lunes" : "jueves"} pasa la basura. Le toca sacarla a ${tk(x.o)}.`;
      if (x.cubre) t += ` 🧳 Cubre a ${H[x.cubre.titular]}, que está fuera; ${H[x.cubre.titular]} le repone un turno.`;
      else if (x.rep
