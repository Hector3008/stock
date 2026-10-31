// Cliente del visor. Sin dependencias; todo el texto de la API entra con textContent (nunca innerHTML).
const api = document.body.dataset.api;
const $ = (s) => document.querySelector(s);
const form = $("#filtros");
const estado = { pagina: 1, orden: "fecha", dir: "desc", total: 0, tamano: 10 };
let columnas = [];
let pedido = 0;

const aviso = (texto, error = false) => {
  const el = $("#aviso");
  el.textContent = texto;
  el.className = error ? "error" : "";
};

function parametros() {
  const p = new URLSearchParams();
  for (const [k, v] of new FormData(form)) if (v !== "") p.append(k, v);
  p.set("pagina", estado.pagina);
  p.set("orden", estado.orden);
  p.set("dir", estado.dir);
  return p;
}

function formato(v, tipo) {
  if (v === null || v === undefined) return "";
  if (tipo === "bool") return v ? "Sí" : "No";
  if (tipo === "numero") return Number.isInteger(v) ? String(v) : v.toLocaleString("es-PE", { maximumFractionDigits: 2 });
  return String(v);
}

async function pedir(ruta) {
  const r = await fetch(`${api}${ruta}`, { credentials: "same-origin", headers: { accept: "application/json" } });
  if (r.status === 401) {
    aviso("Necesitas iniciar sesión para ver esto.", true);
    const a = document.createElement("a");
    a.href = document.body.dataset.cuenta;
    a.textContent = " Entrar";
    $("#aviso").append(a);
    throw new Error("401");
  }
  if (r.status === 403) { aviso("Tu usuario no tiene permiso para ver el stock (stock:leer).", true); throw new Error("403"); }
  if (r.status === 503) { aviso("El visor todavía no está configurado en el servidor.", true); throw new Error("503"); }
  const cuerpo = await r.json().catch(() => ({}));
  if (!r.ok) { aviso(cuerpo.error ?? `Error ${r.status}`, true); throw new Error(String(r.status)); }
  return cuerpo;
}

async function cargar() {
  const mio = ++pedido;
  aviso("Cargando…");
  let cuerpo;
  try { cuerpo = await pedir(`/datos?${parametros()}`); } catch { return; }
  if (mio !== pedido) return; // llegó una respuesta más vieja que otra ya pedida
  columnas = cuerpo.columnas;
  estado.total = cuerpo.total;
  estado.tamano = cuerpo.tamano;
  const tbody = $("#filas");
  tbody.replaceChildren();
  for (const fila of cuerpo.filas) {
    const tr = document.createElement("tr");
    if (fila.urgente) tr.className = "urgente";
    for (const c of columnas) {
      const td = document.createElement("td");
      td.dataset.col = c.campo;
      td.textContent = formato(fila[c.campo], c.tipo);
      if (c.tipo === "numero") td.className = "num";
      tr.append(td);
    }
    tr.append(celdaMini(fila, tr));
    tbody.append(tr);
  }
  const paginas = Math.max(1, Math.ceil(cuerpo.total / cuerpo.tamano));
  $("#resumen").textContent = `${cuerpo.total.toLocaleString("es-PE")} registros`;
  $("#pos").textContent = `Página ${cuerpo.pagina} de ${paginas.toLocaleString("es-PE")}`;
  $("#ant").disabled = cuerpo.pagina <= 1;
  $("#sig").disabled = cuerpo.pagina >= paginas;
  aviso(cuerpo.filas.length ? "" : "Ningún registro coincide con los filtros.");
  aplicarOcultas();
  if (cuerpo.filas.length && !ocultas.has("spark")) pintarMinis(cuerpo.filas.map((f) => f.codigo), mio);
  for (const th of document.querySelectorAll("th[data-campo]")) {
    th.setAttribute("aria-sort", th.dataset.campo === estado.orden ? (estado.dir === "asc" ? "ascending" : "descending") : "none");
  }
}

async function cargarListas() {
  let f;
  try { f = await pedir("/filtros"); } catch { return; }
  for (const sel of document.querySelectorAll("select[data-lista]")) {
    for (const v of f[sel.dataset.lista] ?? []) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v;
      sel.append(o);
    }
  }
}

form.addEventListener("submit", (e) => { e.preventDefault(); estado.pagina = 1; cargar(); });
form.addEventListener("reset", () => setTimeout(() => { estado.pagina = 1; cargar(); }));
form.elements.tamano.addEventListener("change", () => { estado.pagina = 1; cargar(); });
$("#ant").addEventListener("click", () => { estado.pagina = Math.max(1, estado.pagina - 1); cargar(); });
$("#sig").addEventListener("click", () => { estado.pagina += 1; cargar(); });
for (const th of document.querySelectorAll("th[data-campo]")) {
  th.querySelector("button").addEventListener("click", () => {
    const campo = th.dataset.campo;
    if (estado.orden === campo) estado.dir = estado.dir === "asc" ? "desc" : "asc";
    else { estado.orden = campo; estado.dir = th.dataset.tipo === "texto" ? "asc" : "desc"; }
    estado.pagina = 1;
    cargar();
  });
}

// ---------- gráfico de línea por fila ----------
const NS = "http://www.w3.org/2000/svg";
const series = new Map(); // "codigo|campo" → respuesta de /serie
const svg = (nombre, attrs = {}, texto) => {
  const e = document.createElementNS(NS, nombre);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (texto !== undefined) e.textContent = texto;
  return e;
};
const num = (v) => v.toLocaleString("es-PE", { maximumFractionDigits: 2 });

function celdaMini(fila, tr) {
  const td = document.createElement("td");
  td.className = "spark";
  td.dataset.col = "spark";
  td.dataset.codigo = fila.codigo;
  td.tabIndex = 0;
  td.title = "Pulsa para ver el gráfico grande";
  td.setAttribute("role", "button");
  td.setAttribute("aria-label", `Ver gráfico de ${fila.codigo}`);
  const alternar = () => {
    const abierto = tr.nextElementSibling?.classList.contains("grafico");
    if (abierto) { tr.nextElementSibling.remove(); return; }
    const det = document.createElement("tr");
    det.className = "grafico";
    const celda = document.createElement("td");
    celda.colSpan = columnas.length + 1;
    det.append(celda);
    tr.after(det);
    mostrarSerie(celda, fila.codigo, "total");
  };
  td.addEventListener("click", alternar);
  td.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); alternar(); } });
  td.append(Object.assign(document.createElement("span"), { className: "sin", textContent: "…" }));
  return td;
}

/** Una sola petición para los 10 o 20 códigos de la página; cada celda recibe su línea. */
async function pintarMinis(codigos, mio) {
  const faltan = codigos.filter((c) => !series.has(`${c}|total`));
  if (faltan.length) {
    let cuerpo;
    try { cuerpo = await pedir(`/series?campo=total&codigos=${encodeURIComponent(faltan.join("|"))}`); } catch { return; }
    for (const c of faltan) series.set(`${c}|total`, { codigo: c, campo: "total", series: cuerpo.series, puntos: cuerpo.porCodigo[c] ?? [] });
  }
  if (mio !== pedido) return; // la tabla ya cambió de página
  for (const td of document.querySelectorAll("td.spark")) {
    const p = series.get(`${td.dataset.codigo}|total`)?.puntos ?? [];
    td.replaceChildren(p.length >= 2 ? mini(p) : Object.assign(document.createElement("span"), { className: "sin", textContent: p.length ? "1 día" : "sin datos" }));
  }
}

function mini(puntos) {
  const W = 130, H = 34, m = 3;
  const ms = puntos.map((p) => Date.parse(`${p.fecha}T00:00:00Z`));
  const x0 = ms[0], x1 = ms.at(-1);
  const vs = puntos.map((p) => p.valor);
  const lo = Math.min(...vs), hi = Math.max(...vs), rango = hi - lo || 1;
  const X = (t) => m + ((t - x0) / (x1 - x0)) * (W - 2 * m);
  const Y = (v) => H - m - ((v - lo) / rango) * (H - 2 * m);
  const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Stock de ${puntos[0].fecha} a ${puntos.at(-1).fecha}` });
  g.append(
    svg("title", {}, `${puntos[0].fecha} → ${puntos.at(-1).fecha}\nPrimero ${num(vs[0])} · Último ${num(vs.at(-1))} · Mín ${num(lo)} · Máx ${num(hi)}`),
    svg("polyline", { class: "mini", points: puntos.map((p, i) => `${X(ms[i]).toFixed(1)},${Y(p.valor).toFixed(1)}`).join(" ") }),
    svg("circle", { class: "fin", r: 2.5, cx: X(x1).toFixed(1), cy: Y(vs.at(-1)).toFixed(1) }),
  );
  return g;
}

async function mostrarSerie(celda, codigo, campo) {
  celda.replaceChildren(Object.assign(document.createElement("span"), { className: "serie-vacia", textContent: "Cargando gráfico…" }));
  const clave = `${codigo}|${campo}`;
  let cuerpo = series.get(clave);
  if (!cuerpo) {
    try { cuerpo = await pedir(`/serie?codigo=${encodeURIComponent(codigo)}&campo=${campo}`); } catch { return; }
    series.set(clave, cuerpo);
  }
  celda.replaceChildren();
  const cab = document.createElement("div");
  cab.className = "serie-cab";
  const t = document.createElement("strong");
  t.textContent = codigo;
  const sel = document.createElement("select");
  sel.setAttribute("aria-label", "Serie a graficar");
  for (const s of cuerpo.series) {
    const o = document.createElement("option");
    o.value = s.campo;
    o.textContent = s.titulo;
    o.selected = s.campo === campo;
    sel.append(o);
  }
  sel.addEventListener("change", () => mostrarSerie(celda, codigo, sel.value));
  cab.append(t, sel);
  celda.append(cab);
  if (cuerpo.puntos.length < 2) {
    celda.append(Object.assign(document.createElement("p"), { className: "serie-vacia", textContent: cuerpo.puntos.length ? "Hay un solo día con datos; no alcanza para una línea." : "Sin datos para graficar." }));
    return;
  }
  celda.append(dibujar(cuerpo.puntos));
}

function dibujar(puntos) {
  const W = 900, H = 260, m = { i: 56, d: 16, s: 14, b: 30 };
  const ms = puntos.map((p) => Date.parse(`${p.fecha}T00:00:00Z`));
  const x0 = ms[0], x1 = ms[ms.length - 1];
  const vs = puntos.map((p) => p.valor);
  // Escala con valores redondos; las series que no bajan de cero parten de cero.
  const minimo = Math.min(...vs), maximo = Math.max(...vs);
  const paso = (() => {
    const bruto = ((maximo - (minimo >= 0 ? 0 : minimo)) || 1) / 4, mag = 10 ** Math.floor(Math.log10(bruto)), f = bruto / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
  })();
  const y0 = minimo >= 0 ? 0 : Math.floor(minimo / paso) * paso;
  const y1 = Math.max(Math.ceil(maximo / paso) * paso, y0 + paso);
  const marcas = Math.round((y1 - y0) / paso);
  const X = (t) => m.i + ((t - x0) / (x1 - x0)) * (W - m.i - m.d);
  const Y = (v) => H - m.b - ((v - y0) / (y1 - y0)) * (H - m.b - m.s);
  const caja = document.createElement("div");
  caja.className = "serie";
  const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Evolución entre ${puntos[0].fecha} y ${puntos.at(-1).fecha}` });
  for (let i = 0; i <= marcas; i++) {
    const v = y0 + paso * i, y = Y(v);
    g.append(svg("line", { x1: m.i, x2: W - m.d, y1: y, y2: y, class: "guia" }), svg("text", { x: m.i - 6, y: y + 4, "text-anchor": "end" }, num(v)));
  }
  g.append(svg("line", { x1: m.i, x2: W - m.d, y1: H - m.b, y2: H - m.b, class: "eje" }));
  for (let i = 0; i <= 4; i++) {
    const t = x0 + ((x1 - x0) * i) / 4;
    g.append(svg("text", { x: X(t), y: H - 10, "text-anchor": i === 0 ? "start" : i === 4 ? "end" : "middle" }, new Date(t).toISOString().slice(0, 10)));
  }
  g.append(svg("polyline", { class: "linea", points: puntos.map((p, i) => `${X(ms[i]).toFixed(1)},${Y(p.valor).toFixed(1)}`).join(" ") }));
  const marca = svg("circle", { r: 4, class: "punto", visibility: "hidden" });
  g.append(marca);
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  g.addEventListener("pointermove", (e) => {
    const r = g.getBoundingClientRect();
    const t = x0 + (((e.clientX - r.left) / r.width) * W - m.i) / (W - m.i - m.d) * (x1 - x0);
    let k = 0;
    for (let i = 1; i < ms.length; i++) if (Math.abs(ms[i] - t) < Math.abs(ms[k] - t)) k = i;
    marca.setAttribute("cx", X(ms[k]));
    marca.setAttribute("cy", Y(puntos[k].valor));
    marca.setAttribute("visibility", "visible");
    tip.textContent = `${puntos[k].fecha} · ${num(puntos[k].valor)}`;
    tip.hidden = false;
    tip.style.left = `${Math.min(r.width - 140, Math.max(0, (X(ms[k]) / W) * r.width + 8))}px`;
    tip.style.top = `${(Y(puntos[k].valor) / H) * r.height - 30}px`;
  });
  g.addEventListener("pointerleave", () => { marca.setAttribute("visibility", "hidden"); tip.hidden = true; });
  caja.append(g, tip);
  return caja;
}

// ---------- panel de columnas ----------
const CLAVE = "stock:columnas-ocultas";
const BASICAS = new Set(["fecha", "codigo", "detalle", "marca", "total", "urgente", "cobertura_dias", "spark"]);
const FIJAS = new Set(["codigo"]); // sin el código no se sabe qué fila es cada una
const leerOcultas = () => {
  try { const v = JSON.parse(localStorage.getItem(CLAVE) ?? "[]"); return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string" && !FIJAS.has(x)) : []); } catch { return new Set(); }
};
const ocultas = leerOcultas();
const guardarOcultas = () => { try { localStorage.setItem(CLAVE, JSON.stringify([...ocultas])); } catch { /* sin almacenamiento: vale solo esta visita */ } };

function aplicarOcultas() {
  for (const el of document.querySelectorAll("table [data-col]")) el.hidden = ocultas.has(el.dataset.col);
  for (const caja of document.querySelectorAll("#lista-col input")) caja.checked = !ocultas.has(caja.value);
}

function armarPanel() {
  const lista = $("#lista-col");
  for (const th of document.querySelectorAll("thead th[data-col]")) {
    const l = document.createElement("label");
    const i = document.createElement("input");
    i.type = "checkbox";
    i.value = th.dataset.col;
    i.disabled = FIJAS.has(i.value);
    i.addEventListener("change", () => {
      if (i.checked) ocultas.delete(i.value); else ocultas.add(i.value);
      guardarOcultas();
      aplicarOcultas();
      if (i.value === "spark" && i.checked) pintarMinis([...document.querySelectorAll("td.spark")].map((t) => t.dataset.codigo), pedido);
    });
    l.append(i, document.createTextNode(` ${th.textContent.trim()}`));
    lista.append(l);
  }
  const todas = [...document.querySelectorAll("thead th[data-col]")].map((t) => t.dataset.col);
  $("#col-todas").addEventListener("click", () => { ocultas.clear(); guardarOcultas(); aplicarOcultas(); pintarMinis([...document.querySelectorAll("td.spark")].map((t) => t.dataset.codigo), pedido); });
  $("#col-basicas").addEventListener("click", () => {
    ocultas.clear();
    for (const c of todas) if (!BASICAS.has(c) && !FIJAS.has(c)) ocultas.add(c);
    guardarOcultas();
    aplicarOcultas();
  });
  const btn = $("#btn-col"), panel = $("#panel-col");
  const abrir = (v) => { panel.hidden = !v; btn.setAttribute("aria-expanded", String(v)); };
  btn.addEventListener("click", () => abrir(panel.hidden));
  document.addEventListener("click", (e) => { if (!panel.hidden && !e.target.closest(".columnas")) abrir(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) { abrir(false); btn.focus(); } });
}

armarPanel();
aplicarOcultas();
cargarListas();
cargar();
