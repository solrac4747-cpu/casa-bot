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
      else if (x.repone) t += ` 🔁 Es la reposición del turno que ${H[x.repone.acreedor]} le cubrió.`;
      else if (x.swap) t += ` (Cambio puntual; le tocaba a ${H[x.base]}.)`;
      else if (x.base !== weekBoss(wk)) t += " (Compensación por turno no sacado.)";
      out.push({ key: `${manana}-${k === "L" ? "lun" : "jue"}`, texto: t });
    }
  }

  // Recordatorio de pago a Imelda: un día antes a las 4:00 PM (lunes)
  if (now.hour >= HORA_IMELDA && PAGO_IMELDA_DOW !== null && dowM === PAGO_IMELDA_DOW) {
    out.push({ key: `${manana}-imelda`, texto: `💵 Recordatorio: mañana toca el pago a Imelda. Le toca a ${tk(weekBoss(wk))}.` });
  }

  // Recordatorio de renta: día 4 a las 9:00 AM (etiquetando a los pendientes)
  if (now.day === 4 && now.hour >= HORA_RENTA) {
    const rent = arr((DB["mes-" + now.month] || {}).rent);
    const pendIdx = [0, 1, 2, 3].filter(i => !rent[i]);
    if (pendIdx.length) {
      out.push({
        key: `${now.month}-renta`,
        texto: `📅 Recordatorio de renta: hoy es 4 y la renta se paga antes del día 5. Encargado este mes: ${tk(monthBoss(now.month))}. Pendientes de marcar pago: ${pendIdx.map(tk).join(", ")}.`
      });
    }
  }

  if (now.hour >= HORA_RECIBOS) {
    const carlos = H.indexOf("Carlos");
    Object.keys(DB).filter(k => k.startsWith("mes-")).forEach(id => {
      const M = DB[id], items = [];
      (M.rec || []).forEach(x => items.push({ id: "r" + x.id, n: x.n, due: x.due, enc: x.enc, q: x.m / 4, paid: arr(x.paid) }));

      [["internet", "Internet", 900], ["luz", "Luz"], ["agua", "Agua"], ["gas", "Gas"]].forEach(([k, n, fx]) => {
        const t = (M.tot || {})[k] || 0;
        const q = (fx || t) / 4;
        if ((M.due || {})[k] && q > 0) items.push({ id: k, n, due: M.due[k], enc: carlos, q: q, paid: arr((M.svc || {})[k]) });
      });

      items.forEach(it => {
        const dl = diffDays(it.due, now.date), pend = [0, 1, 2, 3].filter(i => !it.paid[i]);
        if ((dl !== 1 && dl !== 2) || !pend.length) return;
        out.push({ key: `${id}-${it.id}-${dl === 2 ? "48h" : "24h"}`, texto: `⏰ ${dl === 2 ? "Faltan 48 horas" : "Falta 1 día (24 h)"} para pagar ${it.n} (límite ${it.due}). Cuota: $${it.q.toFixed(2)} c/u. Pendientes: ${pend.map(tk).join(", ")}. ${cuentaTxt(it.enc)}` });
      });
    });
  }

  if (now.hour >= HORA_COMPRAS) {
    const tr = calcularLiquidacion((DB["mes-" + now.month] || {}).shop);
    if (tr.length) {
      out.push({
        key: `${now.date}-compras`,
        texto: `🛒 *Recordatorio de Compras*\n\nSaldos pendientes por liquidar:\n${tr.map(t => `• ${tk(H.indexOf(t.de))} le debe *$${t.monto.toFixed(2)}* a ${tk(H.indexOf(t.a))}`).join("\n")}\n\nRevisen la app para realizar las transferencias pendientes.`
      });
    }
  }
  return out;
}

/* ---------- Liquidación estilo Splitwise ---------- */
function calcularLiquidacion(compras) {
  const cent = n => Math.round((+n || 0) * 100);
  const saldo = Object.fromEntries(H.map(h => [h, 0]));
  (compras || []).forEach(it => {
    const pagador = it.pagado_por || it.b;
    if (!(pagador in saldo)) return;
    const parts = it.participantes && it.participantes.length ? it.participantes : H;
    const cuota = cent(it.cuota_por_persona != null ? it.cuota_por_persona : (it.monto_total ?? it.m) / parts.length), pagos = arr(it.paid);
    parts.forEach(p => { const i = H.indexOf(p); if (i < 0 || p === pagador || pagos[i]) return; saldo[p] -= cuota; saldo[pagador] += cuota; });
  });
  const acr = H.filter(h => saldo[h] > 0).map(h => ({ n: h, v: saldo[h] })), deu = H.filter(h => saldo[h] < 0).map(h => ({ n: h, v: -saldo[h] })), out = [];
  while (acr.length && deu.length) {
    acr.sort((a, c) => c.v - a.v); deu.sort((a, c) => c.v - a.v);
    const c = acr[0], d = deu[0], m = Math.min(c.v, d.v);
    out.push({ de: d.n, a: c.n, monto: m / 100 });
    c.v -= m; d.v -= m;
    if (c.v <= 0) acr.shift();
    if (d.v <= 0) deu.shift();
  }
  return out;
}

/* ---------- Formateo de menciones (@usuario) ---------- */
function armar(texto, TEL) {
  const jids = [];

  const extraerNums = key => {
    const v = TEL[key];
    return (Array.isArray(v) ? v : v ? [v] : [])
      .map(n => String(n).replace(/\D/g, ""))
      .filter(Boolean);
  };

  // Expande {{TODOS}} omitiendo a Carlos (mismo teléfono emisor)
  const textoExpandido = texto.replace(/\{\{TODOS\}\}/g, () =>
    H.map((n, idx) => (n === "Carlos" ? null : `{{${idx}}}`))
      .filter(Boolean)
      .join(", ")
  );

  const t = textoExpandido.replace(/\{\{(\d)\}\}/g, (m, i) => {
    const nombre = H[+i];

    // Nunca etiquetar a Carlos (solo texto plano cuando le toque turno o pago)
    if (nombre === "Carlos") {
      return "Carlos";
    }

    // REGLA: Si es Bryan/Uriel, junta ambos números en orden (Bryan y Uriel) sin duplicados
    const lista = nombre === "Bryan/Uriel"
      ? [...extraerNums("Bryan"), ...extraerNums("Bryan/Uriel"), ...extraerNums("Uriel")]
      : extraerNums(nombre);

    if (!lista.length) return nombre;

    const representaciones = [];
    const vistos = new Set();

    lista.forEach(n => {
      // Detección automática de número de Estados Unidos (+1)
      if (n.startsWith("1") && n.length === 11) {
        if (vistos.has(n)) return;
        vistos.add(n);
        jids.push(`${n}@s.whatsapp.net`, n);
        representaciones.push(`@${n}`);
      } else {
        // Detección genérica (México)
        const diez = n.slice(-10);
        if (vistos.has(diez)) return;
        vistos.add(diez);
        jids.push(`521${diez}@s.whatsapp.net`, `52${diez}@s.whatsapp.net`, `521${diez}`, `52${diez}`);
        representaciones.push(`@521${diez}`);
      }
    });

    return representaciones.length > 0 ? representaciones.join(" y ") : nombre;
  });

  return { texto: t, nums: [...new Set(jids)] };
}

/* ---------- Verificación automática del Boiler (Optimizada contra duplicados) ---------- */
async function verificarBoilerGitHub(sb, enviar, TEL) {
  try {
    const res = await sb("estado?select=id,data&id=eq.global");
    if (!res.ok) return;
    const rows = await res.json();
    const g = rows[0]?.data || {};

    if (g.boilerOn && g.boilerTimestamp && !g.alertaBoilerEnviada) {
      const minutosTranscurridos = (Date.now() - g.boilerTimestamp) / (1000 * 60);

      if (minutosTranscurridos >= 30) {
        // 1. Marcamos como true PRIMERO localmente
        g.alertaBoilerEnviada = true;

        // 2. Guardamos en Supabase ANTES de mandar el mensaje para bloquear ráfagas de cronjob
        await sb("estado", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify([{ id: "global", data: g }])
        });

        // 3. Enviamos la notificación al grupo etiquetando a todos excepto Carlos
        const mensajeObj = armar("⚠️ *ALERTA DE BOILER*\nEl boiler lleva más de 30 minutos encendido y sigue prendido. ¿Alguien lo olvidó?\n\n{{TODOS}}", TEL);
        await enviar(mensajeObj);
        console.log("Alerta de boiler enviada y registrada correctamente.");
      }
    }
  } catch (err) {
    console.error("Error al verificar el boiler:", err);
  }
}

/* ---------- Ejecución principal ---------- */
async function run() {
  const { SUPABASE_URL: U, SUPABASE_KEY: K, GRUPO_ID, TELEFONOS, PRUEBA, DRY_RUN } = process.env;
  const TEL = JSON.parse(TELEFONOS || "{}");
  const GRUPO = (GRUPO_ID || DEFAULT_GRUPO).trim().replace(/^["']+|["']+$/g, "");

  const sb = (path, opt = {}) => fetch(`${U}/rest/v1/${path}`, {
    ...opt,
    headers: { apikey: K, Authorization: `Bearer ${K}`, "Content-Type": "application/json", ...(opt.headers || {}) }
  });

  const enviar = async ({ texto, nums }) => {
    if (DRY_RUN) { console.log("[DRY_RUN]", texto, nums); return; }
    const url = `${EVOLUTION_URL}/message/sendText/${INSTANCE}`;

    const payload = {
      number: GRUPO,
      text: texto,
      textMessage: {
        text: texto
      }
    };
    if (nums && nums.length) {
      payload.mentioned = nums;
    }

    const maxIntentos = 3;
    for (let intento = 1; intento <= maxIntentos; intento++) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": EVOLUTION_APIKEY
          },
          body: JSON.stringify(payload)
        });

        if (r.ok) {
          return; // Envío exitoso, salimos del ciclo de reintentos
        }

        const errText = await r.text();
        throw new Error(`Evolution API: ${r.status} ${errText}`);
      } catch (error) {
        console.warn(`Intento ${intento} de ${maxIntentos} fallido: ${error.message}`);

        // Si alcanzamos el límite de intentos, propagamos el error
        if (intento === maxIntentos) {
          throw error;
        }

        // Esperamos 8 segundos antes del siguiente reintento (tiempo para que Render despierte)
        await new Promise(resolve => setTimeout(resolve, 8000));
      }
    }
  };

  if (PRUEBA === "true" || PRUEBA === "1") {
    await enviar(armar("✅ Prueba del bot de la casa conectada a Evolution API. Hola {{1}}", TEL));
    console.log("Prueba enviada exitosamente");
    return;
  }

  // 1. Ejecutar revisión del boiler en cada corrida de GitHub Actions
  await verificarBoilerGitHub(sb, enviar, TEL);

  const res = await sb("estado?select=id,data");
  if (!res.ok) throw new Error("Supabase: " + res.status + " " + await res.text());
  const DB = {}; (await res.json()).forEach(r => { DB[r.id] = ordenDoc(r.id, r.data); });
  const sent = (DB.bot && DB.bot.sent) || {};
  const now = ahora();
  let cambio = false;

  console.log(`Diagnóstico: hora local ${now.hour}:00 (${now.date}) · compras pendientes: ${calcularLiquidacion((DB["mes-" + now.month] || {}).shop).length}`);

  for (const m of planear(DB, now)) {
    if (sent[m.key]) continue;
    await enviar(armar(m.texto, TEL));
    sent[m.key] = true;
    cambio = true;
    console.log("Recordatorio enviado:", m.key);
  }

  // Alerta de garrafones en stock crítico
  const gr = DB.garrafones;
  if (gr && gr.disponibles <= 1 && !gr.alertaEnviada && now.hour >= 9 && now.hour < 21) {
    const cap = CAP_G;
    const idxTurno = mod4(G().water || 0);
    const textoBase = gr.disponibles === 1
      ? `🚰 *Alerta de agua*: Queda solo 1 garrafón de los ${cap}. Le toca comprarlos/pedirlos hoy a {{${idxTurno}}}.`
      : `🚰 *Alerta de agua*: Ya no quedan garrafones (0 de ${cap}). Le toca comprarlos/pedirlos hoy a {{${idxTurno}}}.`;

    await enviar(armar(textoBase, TEL));
    if (!DRY_RUN) {
      const w = await sb("estado", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify([{ id: "garrafones", data: { ...gr, alertaEnviada: true } }])
      });
      if (!w.ok) console.log("No se pudo actualizar alertaEnviada:", w.status, await w.text());
    }
    console.log("Alerta de garrafones enviada con responsable etiquetado");
  }

  // Guardar en Supabase registro de recordatorios ya despachados para evitar repeticiones
  if (cambio && !DRY_RUN) {
    const corte = addDays(now.date, -40).slice(0, 7);
    Object.keys(sent).forEach(k => { if (k.slice(0, 7) < corte) delete sent[k]; });
    await sb("estado", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify([{ id: "bot", data: { sent } }])
    });
  } else if (!cambio) {
    console.log("Sin recordatorios pendientes en este ciclo.", now);
  }
}

module.exports = { planear, armar, ahora, calcularLiquidacion, ordenDoc };
if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
