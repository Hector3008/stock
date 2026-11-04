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
      if (c.tipo === "numero") td.classList.add("num");
      condicional(td, c.campo, fila);
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
  aplicarOrden();
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

// ---------- formato condicional ----------
// Agotado: stock <= 0 (misma regla que el notebook) → la casilla de stock en rojo claro.
// Pedido sugerido: pedido central o prudente > 0 → la casilla en amarillo; cuanto mayor la efectividad (0 a 1, = 1 − error esperado),
// más intenso. Sin efectividad calculada (sin ventas, no evaluable) queda el amarillo más pálido.
const MIN_INTENSIDAD = 0.15;
export const intensidad = (efectividad) =>
  typeof efectividad === "number" && Number.isFinite(efectividad) ? MIN_INTENSIDAD + (1 - MIN_INTENSIDAD) * Math.min(1, Math.max(0, efectividad)) : 0.08;

function condicional(td, campo, fila) {
  if (campo === "total" && typeof fila.total === "number" && fila.total <= 0) {
    td.classList.add("agotado");
    td.title = "Agotado: sin stock";
  } else if ((campo === "pedido_central" || campo === "pedido_prudente") && typeof fila[campo] === "number" && fila[campo] > 0) {
    const k = intensidad(fila.efectividad);
    td.classList.add("pide");
    if (k >= 0.6) td.classList.add("alto"); // fondo fuerte: texto oscuro
    td.style.setProperty("--int", String(k));
    const ef = typeof fila.efectividad === "number" ? `efectividad ${Math.round(fila.efectividad * 100)} %` : "sin efectividad calculada";
    td.title = `Pedido sugerido: ${num(fila[campo])} · ${ef}${fila.grado ? ` (grado ${fila.grado})` : ""}`;
  }
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
  const mn = Math.min(...vs), mx = Math.max(...vs);
  // El eje parte de 0 (como el gráfico grande) para no exagerar variaciones pequeñas.
  const lo = Math.min(0, mn), hi = Math.max(0, mx), rango = hi - lo || 1;
  const X = (t) => m + ((t - x0) / (x1 - x0)) * (W - 2 * m);
  const Y = (v) => H - m - ((v - lo) / rango) * (H - 2 * m);
  const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Stock de ${puntos[0].fecha} a ${puntos.at(-1).fecha}` });
  g.append(
    svg("title", {}, `${puntos[0].fecha} → ${puntos.at(-1).fecha}\nPrimero ${num(vs[0])} · Último ${num(vs.at(-1))} · Mín ${num(mn)} · Máx ${num(mx)}`),
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

// ---------- exportar a Excel o PDF ----------
// Manda al servidor lo que ves: los filtros del formulario, el orden de la tabla y las columnas visibles en su orden actual.
async function exportar(formato) {
  const botones = [$("#exp-xlsx"), $("#exp-pdf")];
  const p = parametros();
  p.delete("pagina");
  p.set("formato", formato);
  p.set("columnas", [...document.querySelectorAll("thead th[data-col]")].filter((t) => !t.hidden).map((t) => t.dataset.col).join("|"));
  for (const b of botones) b.disabled = true;
  aviso(`Generando ${formato === "pdf" ? "el PDF" : "el Excel"}…`);
  try {
    const r = await fetch(`${api}/exportar?${p}`, { credentials: "same-origin" });
    if (!r.ok) {
      const cuerpo = await r.json().catch(() => ({}));
      aviso(r.status === 401 ? "Tu sesión venció: vuelve a entrar." : r.status === 403 ? "Tu usuario no tiene permiso para ver el stock (stock:leer)." : cuerpo.error ?? `No se pudo exportar (error ${r.status}).`, true);
      return;
    }
    const nombre = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? `stock.${formato}`;
    const url = URL.createObjectURL(await r.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: nombre });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    const sin = /sin-colores; limite=(\d+)/.exec(r.headers.get("x-stock-formato") ?? "");
    const sinGraf = /omitido; limite=(\d+)/.exec(r.headers.get("x-stock-grafico") ?? "");
    const avisos = [];
    if (sin) avisos.push(`sin colores (hay más de ${Number(sin[1]).toLocaleString("es-PE")} filas y con colores pesaría demasiado)`);
    if (sinGraf) avisos.push(`sin la columna de gráficos (solo se incluye hasta ${Number(sinGraf[1]).toLocaleString("es-PE")} filas)`);
    aviso(avisos.length ? `Excel exportado ${avisos.join(" y ")}. Con menos filas (usa filtros) sale completo.` : `${nombre} descargado.`);
  } catch {
    aviso("No se pudo exportar: revisa tu conexión e inténtalo de nuevo.", true);
  } finally {
    for (const b of botones) b.disabled = false;
  }
}
$("#exp-xlsx").addEventListener("click", () => exportar("xlsx"));
$("#exp-pdf").addEventListener("click", () => exportar("pdf"));

// ---------- panel de columnas: visibilidad y orden ----------
const CLAVE = "stock:columnas-ocultas";
const CLAVE_ORDEN = "stock:columnas-orden";
const BASICAS = new Set(["fecha", "codigo", "detalle", "marca", "total", "urgente", "cobertura_dias", "spark"]);
const FIJAS = new Set(["codigo"]); // sin el código no se sabe qué fila es cada una
const ULTIMA = "spark"; // la columna de líneas queda fija en el borde derecho y no se mueve
const BASE = [...document.querySelectorAll("thead th[data-col]")].map((t) => t.dataset.col).filter((c) => c !== ULTIMA);
const TITULOS = Object.fromEntries([...document.querySelectorAll("thead th[data-col]")].map((t) => [t.dataset.col, t.textContent.trim()]));
const guardar = (clave, valor) => { try { localStorage.setItem(clave, JSON.stringify(valor)); } catch { /* sin almacenamiento: vale solo esta visita */ } };
const leerJson = (clave) => { try { const v = JSON.parse(localStorage.getItem(clave) ?? "null"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : null; } catch { return null; } };

const CLAVE_MOSTRADAS = "stock:columnas-mostradas";
// Las columnas nuevas (data-oculta) empiezan ocultas, salvo que esa persona ya las haya mostrado alguna vez.
const OCULTAS_DE_FABRICA = new Set([...document.querySelectorAll("thead th[data-oculta]")].map((t) => t.dataset.col));
const GRUPOS = { equivalentes: "equivalentes", stock: "stock y mov.", calculo: "cálculo" };
const GRUPO_DE = Object.fromEntries([...document.querySelectorAll("thead th[data-col]")].map((t) => [t.dataset.col, t.dataset.grupo]));
const mostradas = new Set(leerJson(CLAVE_MOSTRADAS) ?? []);
const ocultas = new Set((leerJson(CLAVE) ?? []).filter((x) => !FIJAS.has(x)));
for (const c of OCULTAS_DE_FABRICA) if (!mostradas.has(c)) ocultas.add(c);
// Orden guardado, sin columnas que ya no existen y con las nuevas al final (por si se agrega una columna en el servidor).
const guardado = (leerJson(CLAVE_ORDEN) ?? []).filter((c) => BASE.includes(c));
let orden = [...new Set([...guardado, ...BASE])];
const guardarOcultas = () => {
  guardar(CLAVE, [...ocultas].filter((c) => !OCULTAS_DE_FABRICA.has(c)));
  guardar(CLAVE_MOSTRADAS, [...OCULTAS_DE_FABRICA].filter((c) => !ocultas.has(c)));
};
const guardarOrden = () => guardar(CLAVE_ORDEN, orden);

function aplicarOcultas() {
  for (const el of document.querySelectorAll("table [data-col]")) el.hidden = ocultas.has(el.dataset.col);
  for (const caja of document.querySelectorAll("#lista-col input")) caja.checked = !ocultas.has(caja.value);
}

/** Reordena encabezado y celdas de cada fila según `orden`; la columna de líneas va siempre al final. */
function aplicarOrden() {
  const filas = document.querySelectorAll("table thead tr, table tbody tr:not(.grafico)");
  for (const tr of filas) {
    for (const c of [...orden, ULTIMA]) {
      const el = tr.querySelector(`:scope > [data-col="${c}"]`);
      if (el) tr.append(el);
    }
  }
}

function mover(col, haciaCol) {
  if (col === haciaCol || !orden.includes(col) || !orden.includes(haciaCol)) return;
  const sin = orden.filter((c) => c !== col);
  sin.splice(orden.indexOf(haciaCol), 0, col); // la columna ocupa el lugar de la columna destino
  orden = sin;
  guardarOrden();
  aplicarOrden();
  pintarLista();
}
function desplazar(col, delta) {
  const i = orden.indexOf(col), j = i + delta;
  if (j < 0 || j >= orden.length) return;
  mover(col, orden[j]);
}

function pintarLista(foco) {
  const lista = $("#lista-col");
  lista.replaceChildren();
  for (const col of [...orden, ULTIMA]) {
    const fijaPos = col === ULTIMA;
    const item = document.createElement("div");
    item.className = "item";
    item.dataset.col = col;
    if (!fijaPos) {
      item.draggable = true;
      item.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", col); e.dataTransfer.effectAllowed = "move"; item.classList.add("arrastrando"); });
      item.addEventListener("dragend", () => item.classList.remove("arrastrando"));
      item.addEventListener("dragover", (e) => { e.preventDefault(); item.classList.add("sobre"); });
      item.addEventListener("dragleave", () => item.classList.remove("sobre"));
      item.addEventListener("drop", (e) => { e.preventDefault(); item.classList.remove("sobre"); mover(e.dataTransfer.getData("text/plain"), col); });
    }
    const asa = Object.assign(document.createElement("span"), { className: "asa", textContent: fijaPos ? "" : "⠿" });
    asa.setAttribute("aria-hidden", "true");
    const l = document.createElement("label");
    const i = document.createElement("input");
    i.type = "checkbox";
    i.value = col;
    i.checked = !ocultas.has(col);
    i.disabled = FIJAS.has(col);
    i.addEventListener("change", () => {
      if (i.checked) ocultas.delete(col); else ocultas.add(col);
      guardarOcultas();
      aplicarOcultas();
      if (col === ULTIMA && i.checked) pintarMinis([...document.querySelectorAll("td.spark")].map((t) => t.dataset.codigo), pedido);
    });
    l.append(i, document.createTextNode(` ${TITULOS[col]}`));
    if (GRUPOS[GRUPO_DE[col]]) l.append(Object.assign(document.createElement("small"), { className: "grupo", textContent: GRUPOS[GRUPO_DE[col]] }));
    item.append(asa, l);
    if (!fijaPos) {
      const sube = Object.assign(document.createElement("button"), { type: "button", className: "sube", textContent: "▲" });
      const baja = Object.assign(document.createElement("button"), { type: "button", className: "baja", textContent: "▼" });
      sube.setAttribute("aria-label", `Subir ${TITULOS[col]}`);
      baja.setAttribute("aria-label", `Bajar ${TITULOS[col]}`);
      sube.disabled = orden[0] === col;
      baja.disabled = orden.at(-1) === col;
      sube.addEventListener("click", () => { desplazar(col, -1); $(`#lista-col .item[data-col="${col}"] .${sube.disabled ? "baja" : "sube"}`)?.focus(); });
      baja.addEventListener("click", () => { desplazar(col, 1); $(`#lista-col .item[data-col="${col}"] .${baja.disabled ? "sube" : "baja"}`)?.focus(); });
      item.append(sube, baja);
    }
    lista.append(item);
  }
  aplicarOcultas();
}

/** Los encabezados también se arrastran: se suelta una columna sobre otra para cambiarla de lugar. */
function armarEncabezados() {
  for (const th of document.querySelectorAll("thead th[data-col]")) {
    const col = th.dataset.col;
    if (col === ULTIMA) continue;
    th.draggable = true;
    th.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", col); e.dataTransfer.effectAllowed = "move"; });
    th.addEventListener("dragover", (e) => { e.preventDefault(); th.classList.add("sobre"); });
    th.addEventListener("dragleave", () => th.classList.remove("sobre"));
    th.addEventListener("drop", (e) => { e.preventDefault(); th.classList.remove("sobre"); mover(e.dataTransfer.getData("text/plain"), col); });
  }
}

function armarPanel() {
  pintarLista();
  armarEncabezados();
  const minis = () => pintarMinis([...document.querySelectorAll("td.spark")].map((t) => t.dataset.codigo), pedido);
  $("#col-todas").addEventListener("click", () => { ocultas.clear(); guardarOcultas(); aplicarOcultas(); minis(); });
  $("#col-basicas").addEventListener("click", () => {
    ocultas.clear();
    for (const c of [...BASE, ULTIMA]) if (!BASICAS.has(c) && !FIJAS.has(c)) ocultas.add(c);
    guardarOcultas();
    aplicarOcultas();
  });
  $("#col-orden").addEventListener("click", () => { orden = [...BASE]; guardarOrden(); aplicarOrden(); pintarLista(); });
  const btn = $("#btn-col"), panel = $("#panel-col");
  const abrir = (v) => { panel.hidden = !v; btn.setAttribute("aria-expanded", String(v)); };
  btn.addEventListener("click", () => abrir(panel.hidden));
  // composedPath se calcula al despachar el clic: sigue valiendo aunque la lista se haya redibujado y el botón ya no esté en el DOM.
  const caja = btn.closest(".columnas");
  document.addEventListener("click", (e) => { if (!panel.hidden && !e.composedPath().includes(caja)) abrir(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) { abrir(false); btn.focus(); } });
}

armarPanel();
aplicarOrden();
aplicarOcultas();
cargarListas();
cargar();
