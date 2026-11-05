import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import JSZip from "jszip";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { colorCasilla, ROJO, amarilloHex } from "./formato.js";

// Exportación de la vista actual (filtros, columnas visibles y su orden) a Excel y PDF. Ambos escriben directo a la respuesta HTTP,
// fila por fila, sin armar el archivo completo en memoria (el Excel puede tener decenas de miles de filas).

const PORCENTAJE = new Set(["efectividad", "error_esperado"]);
const LARGAS = new Set(["motivo", "recomendacion", "equivalente_stock", "codigos_equivalentes"]);
/** Reduce una serie a como mucho `max` puntos repartidos parejo, conservando el primero y el último. */
export function muestrear(valores, max) {
  if (valores.length <= max) return valores;
  return Array.from({ length: max }, (_, i) => valores[Math.round((i * (valores.length - 1)) / (max - 1))]);
}
const letra = (n) => { let s = ""; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const sinControl = (t) => String(t).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

// ---------- descripción de los filtros (hoja «Resumen» y encabezado del PDF) ----------
const ETIQUETAS = { codigo: "Código", detalle: "Detalle", ultima: "Solo la última fecha", desde: "Desde", hasta: "Hasta", grado: "Grado", segmento: "Segmento", rotacion: "Rotación", estado: "Estado", marca: "Marca", urgente: "Urgente" };
const uno = (v) => (Array.isArray(v) ? v.join(", ") : v);
export function describirFiltros(query = {}) {
  const partes = [];
  const ultima = ["1", "si"].includes(String(uno(query.ultima) ?? ""));
  for (const [k, etiqueta] of Object.entries(ETIQUETAS)) {
    const v = uno(query[k]);
    if (v === undefined || v === "") continue;
    if (k === "ultima") { if (ultima) partes.push(`Solo la última fecha${query.desde ? ` (${uno(query.desde)})` : ""}`); continue; }
    if (ultima && (k === "desde" || k === "hasta")) continue;
    partes.push(`${etiqueta}: ${String(v).split("|").join(", ")}`);
  }
  return partes.length ? partes.join(" · ") : "Sin filtros";
}

// ---------- Excel ----------
const anchoXlsx = (c) => (c.campo === "detalle" ? 42 : LARGAS.has(c.campo) ? 60 : c.tipo === "fecha" ? 12 : c.campo === "codigo" ? 14 : c.tipo === "texto" ? 14 : 12);
const relleno = (hex) => ({ type: "pattern", pattern: "solid", fgColor: { argb: `FF${hex}` } });

/**
 * @param {object} o
 * @param {import("node:stream").Writable} o.salida
 * @param {Array} o.columnas  columnas del catálogo, en el orden de la pantalla
 * @param {AsyncIterable<object>} o.filas  filas con nombres largos (limpiarFila)
 * @param {boolean} o.conFormato  false: sin colores de agotado / pedido (archivo mucho más liviano)
 * @param {string[]} o.resumen  líneas de la hoja «Resumen»
 */
export const PUNTOS_XLSX = 30;
export async function escribirXlsx({ salida, columnas, filas, conFormato, resumen }) {
  const iSerie = columnas.findIndex((c) => c.tipo === "serie");
  if (iSerie >= 0) return escribirXlsxConGraficos({ salida, columnas, filas, conFormato, resumen, iSerie });
  return escribirXlsxPlano({ salida, columnas, filas, conFormato, resumen });
}

/**
 * Con gráficos: exceljs no sabe escribir minigráficos (sparklines), así que el libro se arma en un archivo temporal, se le inserta
 * el bloque x14 de la hoja «Stock» (una línea por fila, leyendo los puntos de columnas ocultas a la derecha) y recién ahí se envía.
 * Solo se usa con pocas filas (tope STOCK_EXPORT_GRAFICO_XLSX), así que cabe en memoria.
 */
async function escribirXlsxConGraficos({ salida, columnas, filas, conFormato, resumen, iSerie }) {
  const dir = await mkdtemp(join(tmpdir(), "stock-xlsx-"));
  const ruta = join(dir, "libro.xlsx");
  try {
    const guardadas = [];
    const n = await escribirXlsxPlano({ salida: createWriteStream(ruta), columnas, filas, conFormato, resumen, puntos: guardadas });
    const zip = await JSZip.loadAsync(await readFile(ruta));
    const nombre = "xl/worksheets/sheet1.xml";
    const xml = await zip.file(nombre).async("string");
    const ini = columnas.length + 1, col = letra(iSerie + 1);
    const lineas = guardadas.map((v, i) => {
      const fila = i + 2;
      return v.length ? `<x14:sparkline><xm:f>Stock!${letra(ini)}${fila}:${letra(ini + v.length - 1)}${fila}</xm:f><xm:sqref>${col}${fila}</xm:sqref></x14:sparkline>` : "";
    }).join("");
    const bloque = `<extLst><ext uri="{05C60535-1F16-4fd2-B633-F4F36F0B64E0}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:sparklineGroups xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:sparklineGroup manualMin="0" minAxisType="custom" displayHidden="1" displayEmptyCellsAs="gap" lineWeight="1.25" last="1"><x14:colorSeries rgb="FF2F6BE8"/><x14:colorNegative rgb="FFD00000"/><x14:colorAxis rgb="FF000000"/><x14:colorMarkers rgb="FF2F6BE8"/><x14:colorFirst rgb="FF2F6BE8"/><x14:colorLast rgb="FFD32F2F"/><x14:colorHigh rgb="FF2F6BE8"/><x14:colorLow rgb="FF2F6BE8"/><x14:sparklines>${lineas}</x14:sparklines></x14:sparklineGroup></x14:sparklineGroups></ext></extLst>`;
    if (!xml.includes("</worksheet>")) throw new Error("hoja inesperada");
    zip.file(nombre, xml.replace("</worksheet>", `${bloque}</worksheet>`));
    await pipeline(zip.generateNodeStream({ type: "nodebuffer", streamFiles: true, compression: "DEFLATE" }), salida);
    return n;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function escribirXlsxPlano({ salida, columnas, filas, conFormato, resumen, puntos }) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: salida, useStyles: true, useSharedStrings: false });
  wb.creator = "stock";
  const ws = wb.addWorksheet("Stock", { views: [{ state: "frozen", ySplit: 1 }] });
  const datos = puntos ? Array.from({ length: PUNTOS_XLSX }, (_, i) => ({ key: `p${i}`, width: 4, hidden: true })) : [];
  ws.columns = [...columnas.map((c) => ({
    key: c.campo,
    width: c.tipo === "serie" ? 22 : anchoXlsx(c),
    style: {
      ...(c.tipo === "fecha" ? { numFmt: "yyyy-mm-dd" } : {}),
      ...(PORCENTAJE.has(c.campo) ? { numFmt: "0%" } : {}),
      alignment: { vertical: "top", ...(c.tipo === "texto" && (LARGAS.has(c.campo) || c.campo === "detalle") ? { wrapText: true } : {}) },
    },
  })), ...datos];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columnas.length } };
  const cab = ws.addRow(columnas.map((c) => c.titulo));
  const alturaSerie = puntos ? 26 : null;
  cab.font = { bold: true };
  cab.alignment = { vertical: "middle", wrapText: true };
  cab.eachCell((cell) => { cell.fill = relleno("E7E6DF"); });
  cab.commit();

  const rellenos = new Map(); // un solo objeto de estilo por color
  const dame = (hex) => rellenos.get(hex) ?? rellenos.set(hex, relleno(hex)).get(hex);
  let n = 0;
  for await (const f of filas) {
    const ptsFila = puntos ? muestrear(f.spark ?? [], PUNTOS_XLSX) : [];
    puntos?.push(ptsFila); // para armar después el bloque x14
    const fila = ws.addRow([...columnas.map((c) => {
      if (c.tipo === "serie") return null;
      const v = f[c.campo];
      if (v === null || v === undefined) return null;
      if (c.tipo === "fecha") return new Date(`${v}T00:00:00Z`);
      if (c.tipo === "bool") return v ? "Sí" : "No";
      return typeof v === "string" ? sinControl(v) : v;
    }), ...ptsFila]);
    if (alturaSerie) fila.height = Math.max(alturaSerie, fila.height ?? 0);
    if (conFormato) {
      columnas.forEach((c, i) => {
        const hex = colorCasilla(c.campo, f, true);
        if (hex) fila.getCell(i + 1).fill = dame(hex);
      });
    }
    fila.commit();
    n += 1;
  }
  ws.commit();

  const rs = wb.addWorksheet("Resumen");
  rs.columns = [{ width: 24 }, { width: 110 }];
  for (const linea of resumen) {
    const [a, ...b] = linea.split("\t");
    const r = rs.addRow([a, b.join("\t")]);
    r.getCell(1).font = { bold: true };
    r.commit();
  }
  rs.commit();
  await wb.commit();
  return n;
}

// ---------- PDF ----------
const MARGEN = 24;
const HOJAS = [{ nombre: "A4", ancho: 841.89, alto: 595.28 }, { nombre: "A3", ancho: 1190.55, alto: 841.89 }]; // las dos apaisadas
const ANCHO_BASE = { fecha: 54, texto: 62, numero: 46, bool: 34 };
const ANCHO_CAMPO = { codigo: 62, detalle: 140, marca: 56, motivo: 170, recomendacion: 170, equivalente_stock: 170, codigos_equivalentes: 150, celda: 70, spark: 78 };
const MAX_LINEAS = 5;

const FLEXIBLES = new Set(["detalle", "motivo", "recomendacion", "equivalente_stock", "codigos_equivalentes"]);

/**
 * Elige la hoja (A4 apaisada si las columnas caben con letra normal; si no, A3) y reparte el ancho: lo que sobra va a las columnas
 * de texto largo, y la letra crece un poco (hasta 9 pt) cuando hay pocas columnas. Devuelve { pagina, anchos, fuente } o { error }.
 */
export function planPdf(columnas) {
  const base = columnas.map((c) => ANCHO_CAMPO[c.campo] ?? ANCHO_BASE[c.tipo] ?? 50);
  const total = base.reduce((a, b) => a + b, 0);
  const util = (h) => h.ancho - 2 * MARGEN;
  const pagina = HOJAS.find((h) => util(h) / total >= 0.85) ?? HOJAS.at(-1);
  const escala = util(pagina) / total;
  if (escala < 0.62) {
    const caben = Math.floor((columnas.length * util(pagina)) / (total * 0.62));
    return { error: `Hay demasiadas columnas visibles para un PDF legible (caben unas ${Math.max(caben, 1)}). Oculta algunas desde «Columnas» o exporta a Excel.` };
  }
  const s = Math.min(escala, 1.25);
  let anchos = base.map((a) => a * s);
  const sobra = util(pagina) - anchos.reduce((a, b) => a + b, 0);
  if (sobra > 0) {
    const flex = columnas.map((c) => FLEXIBLES.has(c.campo));
    const k = flex.filter(Boolean).length;
    anchos = k ? anchos.map((a, i) => a + (flex[i] ? sobra / k : 0)) : anchos.map((a) => a * (util(pagina) / (util(pagina) - sobra)));
  }
  return { pagina, anchos, fuente: Math.min(9, Math.max(5, 7 * s)) };
}

function graficoCelda(doc, valores, x, y, ancho, alto) {
  const v = (valores ?? []).filter((n) => typeof n === "number");
  if (v.length < 2) return;
  const pts = muestrear(v, 60);
  const hi = Math.max(0, ...pts), lo = Math.min(0, ...pts), rango = hi - lo || 1;
  const X = (i) => x + (i / (pts.length - 1)) * ancho;
  const Y = (n) => y + alto - ((n - lo) / rango) * alto;
  doc.moveTo(x, Y(0)).lineTo(x + ancho, Y(0)).lineWidth(0.3).strokeColor("#b9b8b0").stroke(); // el eje parte de 0, igual que en pantalla
  pts.forEach((n, i) => (i ? doc.lineTo(X(i), Y(n)) : doc.moveTo(X(i), Y(n))));
  doc.lineWidth(0.8).strokeColor("#2F6BE8").stroke();
  doc.circle(X(pts.length - 1), Y(pts.at(-1)), 1.4).fill("#D32F2F");
}

function texto(c, v) {
  if (v === null || v === undefined) return "";
  if (c.tipo === "bool") return v ? "Sí" : "No";
  if (PORCENTAJE.has(c.campo) && typeof v === "number") return `${Math.round(v * 100)} %`;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toLocaleString("es-PE", { maximumFractionDigits: 2 });
  return sinControl(v);
}

/** Todas las filas llevan los colores (el PDF ya está acotado por el tope de filas, que es bajo). */
export async function escribirPdf({ salida, columnas, filas, titulo, lineas }) {
  const plan = planPdf(columnas);
  if (plan.error) throw new Error(plan.error);
  const { anchos, fuente, pagina: PAGINA0 } = plan;
  const PAGINA = { ancho: PAGINA0.ancho, alto: PAGINA0.alto, margen: MARGEN };
  const doc = new PDFDocument({ size: [PAGINA.ancho, PAGINA.alto], margin: PAGINA.margen, bufferPages: true, info: { Title: titulo, Creator: "stock" } });
  doc.pipe(salida);
  const x0 = PAGINA.margen;
  const pie = PAGINA.alto - PAGINA.margen - 12;
  const pad = 3;
  const lineaAlto = fuente * 1.2;

  const encabezado = (y) => {
    doc.font("Helvetica-Bold").fontSize(fuente);
    const h = Math.max(...columnas.map((c, i) => doc.heightOfString(c.titulo, { width: anchos[i] - 2 * pad }))) + 2 * pad;
    let x = x0;
    doc.rect(x0, y, anchos.reduce((a, b) => a + b, 0), h).fill("#E7E6DF");
    doc.fillColor("#1d1d1b");
    columnas.forEach((c, i) => {
      doc.text(c.titulo, x + pad, y + pad, { width: anchos[i] - 2 * pad, align: c.tipo === "numero" ? "right" : "left" });
      x += anchos[i];
    });
    return y + h;
  };

  doc.font("Helvetica-Bold").fontSize(14).fillColor("#1d1d1b").text(titulo, x0, PAGINA.margen);
  doc.font("Helvetica").fontSize(8).fillColor("#555");
  for (const l of lineas) doc.text(l, x0);
  let y = doc.y + 4;
  doc.rect(x0, y, 9, 9).fill(`#${ROJO}`);
  doc.fillColor("#555").text("Agotado (stock 0)", x0 + 13, y + 1, { lineBreak: false });
  doc.rect(x0 + 110, y, 9, 9).fill(`#${amarilloHex(1)}`);
  doc.fillColor("#555").text("Pedido sugerido: más intenso = mayor efectividad", x0 + 123, y + 1, { lineBreak: false });
  y = encabezado(y + 16);

  let n = 0;
  for await (const f of filas) {
    doc.font("Helvetica").fontSize(fuente);
    const celdas = columnas.map((c) => (c.tipo === "serie" ? "" : texto(c, f[c.campo])));
    const alto0 = Math.min(
      Math.max(...celdas.map((t, i) => (t ? doc.heightOfString(t, { width: anchos[i] - 2 * pad }) : lineaAlto))),
      lineaAlto * MAX_LINEAS,
    ) + 2 * pad;
    const alto = columnas.some((c) => c.tipo === "serie") ? Math.max(alto0, 24) : alto0;
    if (y + alto > pie) {
      doc.addPage();
      y = encabezado(PAGINA.margen);
    }
    let x = x0;
    columnas.forEach((c, i) => {
      const hex = colorCasilla(c.campo, f);
      if (hex) doc.rect(x, y, anchos[i], alto).fill(`#${hex}`);
      doc.fillColor("#1d1d1b").font("Helvetica").fontSize(fuente);
      if (c.tipo === "serie") graficoCelda(doc, f.spark, x + pad, y + 4, anchos[i] - 2 * pad, alto - 8);
      else if (celdas[i]) doc.text(celdas[i], x + pad, y + pad, { width: anchos[i] - 2 * pad, height: alto - 2 * pad, ellipsis: true, align: c.tipo === "numero" ? "right" : "left" });
      x += anchos[i];
    });
    doc.moveTo(x0, y + alto).lineTo(x0 + anchos.reduce((a, b) => a + b, 0), y + alto).lineWidth(0.3).strokeColor("#d9d8d0").stroke();
    y += alto;
    n += 1;
  }

  const { start, count } = doc.bufferedPageRange();
  for (let i = start; i < start + count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // sin esto, escribir en el pie crea una página nueva
    doc.font("Helvetica").fontSize(7).fillColor("#777").text(`Página ${i - start + 1} de ${count}`, x0, pie + 4, { width: PAGINA.ancho - 2 * PAGINA.margen, align: "right", lineBreak: false });
  }
  doc.end();
  await new Promise((ok, mal) => { salida.on("finish", ok); salida.on("error", mal); });
  return n;
}
