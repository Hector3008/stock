import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { colorCasilla, ROJO, amarilloHex } from "./formato.js";

// Exportación de la vista actual (filtros, columnas visibles y su orden) a Excel y PDF. Ambos escriben directo a la respuesta HTTP,
// fila por fila, sin armar el archivo completo en memoria (el Excel puede tener decenas de miles de filas).

const PORCENTAJE = new Set(["efectividad", "error_esperado"]);
const LARGAS = new Set(["motivo", "recomendacion", "equivalente_stock", "codigos_equivalentes"]);
const sinControl = (t) => String(t).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

// ---------- descripción de los filtros (hoja «Resumen» y encabezado del PDF) ----------
const ETIQUETAS = { codigo: "Código", detalle: "Detalle", desde: "Desde", hasta: "Hasta", grado: "Grado", segmento: "Segmento", rotacion: "Rotación", estado: "Estado", marca: "Marca", urgente: "Urgente" };
const uno = (v) => (Array.isArray(v) ? v.join(", ") : v);
export function describirFiltros(query = {}) {
  const partes = [];
  for (const [k, etiqueta] of Object.entries(ETIQUETAS)) {
    const v = uno(query[k]);
    if (v === undefined || v === "") continue;
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
export async function escribirXlsx({ salida, columnas, filas, conFormato, resumen }) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: salida, useStyles: true, useSharedStrings: false });
  wb.creator = "stock";
  const ws = wb.addWorksheet("Stock", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columnas.map((c) => ({
    key: c.campo,
    width: anchoXlsx(c),
    style: {
      ...(c.tipo === "fecha" ? { numFmt: "yyyy-mm-dd" } : {}),
      ...(PORCENTAJE.has(c.campo) ? { numFmt: "0%" } : {}),
      alignment: { vertical: "top", ...(c.tipo === "texto" && (LARGAS.has(c.campo) || c.campo === "detalle") ? { wrapText: true } : {}) },
    },
  }));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columnas.length } };
  const cab = ws.addRow(columnas.map((c) => c.titulo));
  cab.font = { bold: true };
  cab.alignment = { vertical: "middle", wrapText: true };
  cab.eachCell((cell) => { cell.fill = relleno("E7E6DF"); });
  cab.commit();

  const rellenos = new Map(); // un solo objeto de estilo por color
  const dame = (hex) => rellenos.get(hex) ?? rellenos.set(hex, relleno(hex)).get(hex);
  let n = 0;
  for await (const f of filas) {
    const fila = ws.addRow(columnas.map((c) => {
      const v = f[c.campo];
      if (v === null || v === undefined) return null;
      if (c.tipo === "fecha") return new Date(`${v}T00:00:00Z`);
      if (c.tipo === "bool") return v ? "Sí" : "No";
      return typeof v === "string" ? sinControl(v) : v;
    }));
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
const PAGINA = { ancho: 1190.55, alto: 841.89, margen: 24 }; // A3 apaisado
const ANCHO_BASE = { fecha: 54, texto: 62, numero: 46, bool: 34 };
const ANCHO_CAMPO = { codigo: 62, detalle: 140, marca: 56, motivo: 170, recomendacion: 170, equivalente_stock: 170, codigos_equivalentes: 150, celda: 70 };
const MAX_LINEAS = 5;

/** Reparte el ancho de la hoja entre las columnas. Devuelve { anchos, fuente } o { error } si ya no caben legibles. */
export function planPdf(columnas) {
  const base = columnas.map((c) => ANCHO_CAMPO[c.campo] ?? ANCHO_BASE[c.tipo] ?? 50);
  const util = PAGINA.ancho - 2 * PAGINA.margen;
  const total = base.reduce((a, b) => a + b, 0);
  const escala = Math.min(1, util / total);
  if (escala < 0.62) {
    const caben = Math.floor((columnas.length * util) / (total * 0.62));
    return { error: `Hay demasiadas columnas visibles para un PDF legible (caben unas ${Math.max(caben, 1)}). Oculta algunas desde «Columnas» o exporta a Excel.` };
  }
  return { anchos: base.map((a) => a * escala), fuente: Math.max(5, 7 * escala) };
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
  const { anchos, fuente } = plan;
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
    const celdas = columnas.map((c) => texto(c, f[c.campo]));
    const alto = Math.min(
      Math.max(...celdas.map((t, i) => (t ? doc.heightOfString(t, { width: anchos[i] - 2 * pad }) : lineaAlto))),
      lineaAlto * MAX_LINEAS,
    ) + 2 * pad;
    if (y + alto > pie) {
      doc.addPage();
      y = encabezado(PAGINA.margen);
    }
    let x = x0;
    columnas.forEach((c, i) => {
      const hex = colorCasilla(c.campo, f);
      if (hex) doc.rect(x, y, anchos[i], alto).fill(`#${hex}`);
      doc.fillColor("#1d1d1b").font("Helvetica").fontSize(fuente);
      if (celdas[i]) doc.text(celdas[i], x + pad, y + pad, { width: anchos[i] - 2 * pad, height: alto - 2 * pad, ellipsis: true, align: c.tipo === "numero" ? "right" : "left" });
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
