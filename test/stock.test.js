// Paquete stock (5.70): validación de consultas y rutas con un núcleo y una colección falsos.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { leerConsulta, leerSerie, leerSeries, limpiarSerie, normalizar, limpiarFila, ErrorConsulta } from "../src/consulta.js";
import { createRouter, PERMISO } from "../src/index.js";
import { COLUMNAS, CORTO, INTERNOS } from "../src/columnas.js";
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { leerExportacion, ErrorLimite } from "../src/consulta.js";
import { planPdf } from "../src/exportar.js";
import { colorCasilla, amarilloHex, nivelIntensidad } from "../src/formato.js";

describe("leerConsulta", () => {
  test("valores por defecto", () => {
    const q = leerConsulta({});
    assert.deepEqual(q.filtro, {});
    assert.deepEqual(q.orden, { f: -1, c: 1 });
    assert.equal(q.pagina, 1);
    assert.equal(q.tamano, 10);
  });
  test("texto: sin tildes, en minúsculas y con los símbolos de regex escapados", () => {
    assert.equal(normalizar("  Válvula   DE  Bola "), "valvula de bola");
    const q = leerConsulta({ codigo: "ZM.*(", detalle: "Válvula bola" });
    assert.deepEqual(q.filtro.$and[0], { cn: { $regex: "zm\\.\\*\\(" } });
    assert.deepEqual(q.filtro.$and.slice(1), [{ dn: { $regex: "valvula" } }, { dn: { $regex: "bola" } }]);
  });
  test("fechas: rango inclusivo, formato y orden", () => {
    const q = leerConsulta({ desde: "2026-01-05", hasta: "2026-02-01" });
    assert.equal(q.filtro.f.$gte.toISOString(), "2026-01-05T00:00:00.000Z");
    assert.equal(q.filtro.f.$lte.toISOString(), "2026-02-01T00:00:00.000Z");
    assert.throws(() => leerConsulta({ desde: "05/01/2026" }), ErrorConsulta);
    assert.throws(() => leerConsulta({ desde: "2026-02-30" }), ErrorConsulta);
    assert.throws(() => leerConsulta({ desde: "2026-03-01", hasta: "2026-02-01" }), ErrorConsulta);
  });
  test("listas: uno o varios valores, también con |; urgente si/no", () => {
    const q = leerConsulta({ grado: ["A", "B"], segmento: "X|Y", urgente: "si" });
    assert.deepEqual(q.filtro.gr, { $in: ["A", "B"] });
    assert.deepEqual(q.filtro.sg, { $in: ["X", "Y"] });
    assert.equal(q.filtro.ur, true);
    assert.equal(leerConsulta({ urgente: "no" }).filtro.ur, false);
    assert.equal("ur" in leerConsulta({ urgente: "" }).filtro, false);
    assert.throws(() => leerConsulta({ urgente: "tal vez" }), ErrorConsulta);
  });
  test("un operador de MongoDB en el query string no pasa", () => {
    // ?grado[$ne]=x llega como objeto: se convierte a texto y queda como valor literal, nunca como operador
    const q = leerConsulta({ grado: { $ne: "x" } });
    assert.deepEqual(q.filtro.gr, { $in: ["[object Object]"] });
    assert.throws(() => leerConsulta({ orden: "$where" }), ErrorConsulta);
  });
  test("paginación: solo 10 o 20, página entera positiva", () => {
    assert.equal(leerConsulta({ tamano: "20", pagina: "3" }).tamano, 20);
    assert.throws(() => leerConsulta({ tamano: "50" }), ErrorConsulta);
    assert.throws(() => leerConsulta({ pagina: "0" }), ErrorConsulta);
    assert.throws(() => leerConsulta({ pagina: "1.5" }), ErrorConsulta);
  });
  test("orden con desempate estable", () => {
    assert.deepEqual(leerConsulta({ orden: "cobertura_dias", dir: "asc" }).orden, { cd: 1, c: 1, f: -1 });
    assert.deepEqual(leerConsulta({ orden: "codigo", dir: "desc" }).orden, { c: -1, f: -1 });
  });
});

test("limpiarFila: fechas en texto, NaN y ausentes como null, sin columnas ajenas", () => {
  const f = limpiarFila({ _id: 1, secreto: "x", c: "ZM1", f: new Date("2026-01-05T00:00:00Z"), t: NaN, gr: "A" });
  assert.equal(f.fecha, "2026-01-05");
  assert.equal(f.total, null);
  assert.equal(f.modelo, null);
  assert.equal("secreto" in f, false);
  assert.equal("_id" in f, false);
});

describe("serie", () => {
  test("leerSerie: código exacto obligatorio y campo de lista fija", () => {
    assert.deepEqual(leerSerie({ codigo: " ZM1 " }), { codigo: "ZM1", campo: "total" });
    assert.equal(leerSerie({ codigo: "ZM1", campo: "cobertura_dias" }).campo, "cobertura_dias");
    assert.throws(() => leerSerie({}), ErrorConsulta);
    assert.throws(() => leerSerie({ codigo: "ZM1", campo: "$where" }), ErrorConsulta);
    assert.throws(() => leerSerie({ codigo: "ZM1", campo: "motivo" }), ErrorConsulta);
  });
  test("leerSeries: varios códigos únicos, hasta 20, campo de lista fija", () => {
    assert.deepEqual(leerSeries({ codigos: "ZM1|ZM2|ZM1| " }), { codigos: ["ZM1", "ZM2"], campo: "total" });
    assert.throws(() => leerSeries({}), ErrorConsulta);
    assert.throws(() => leerSeries({ codigos: Array.from({ length: 21 }, (_, i) => `ZM${i}`).join("|") }), ErrorConsulta);
    assert.throws(() => leerSeries({ codigos: "ZM1", campo: "$where" }), ErrorConsulta);
    assert.equal(leerSeries({ codigos: Array.from({ length: 20 }, (_, i) => `ZM${i}`).join("|") }).codigos.length, 20);
  });
  test("leerSerie: un objeto en el código se vuelve texto literal, no operador", () => {
    assert.equal(typeof leerSerie({ codigo: { $ne: "x" } }).codigo, "string");
  });
  test("limpiarSerie: fechas en texto y sin puntos vacíos", () => {
    const d = (s, total) => ({ f: new Date(`${s}T00:00:00Z`), t: total });
    assert.deepEqual(limpiarSerie([d("2026-01-05", 3), d("2026-01-06", NaN), d("2026-01-07", null), { f: null, t: 1 }, d("2026-01-08", 0)], "total"), [
      { fecha: "2026-01-05", valor: 3 },
      { fecha: "2026-01-08", valor: 0 },
    ]);
  });
});

function coleccionFalsa() {
  const c = { llamadas: [], docs: [{ c: "ZM1", d: "Café", f: new Date("2026-01-05T00:00:00Z"), gr: "A", sg: "X", ur: true, t: 7, eq: "ZM2 (3)", pc: 12 }] };
  c.find = (filtro, opc) => {
    const cur = { sort: (o) => ((c.orden = o), cur), skip: (n) => ((c.skip = n), cur), limit: (n) => ((c.limit = n), cur), toArray: async () => c.docs };
    c.llamadas.push(["find", filtro, opc.projection]);
    return cur;
  };
  c.countDocuments = async (f) => (c.llamadas.push(["count", f]), 42);
  c.estimatedDocumentCount = async () => (c.llamadas.push(["estimado"]), 281067);
  c.distinct = async (campo) => (c.llamadas.push(["distinct", campo]), ["b", "a", "", null, "Á"]);
  c.createIndex = async () => "ok";
  return c;
}

describe("rutas", () => {
  let servidor, base, col, sesion;
  const ENV = { STOCK_EMPRESA_ID: "emp1" };
  before(async () => {
    col = coleccionFalsa();
    const core = {
      autenticar: () => (req, res, next) => (sesion ? ((req.auth = sesion.auth), next()) : res.status(401).json({ error: "sin sesión" })),
      requierePermiso: (p) => (req, res, next) => (sesion.permisos.includes(p) ? next() : res.status(403).json({ error: "permiso insuficiente" })),
    };
    const app = express();
    app.use("/base/stock", createRouter({ core, db: { collection: () => col }, env: ENV, avisar: () => {} }));
    servidor = app.listen(0);
    base = `http://127.0.0.1:${servidor.address().port}/base/stock`;
  });
  after(() => servidor.close());
  const pedir = (ruta) => fetch(`${base}${ruta}`);

  test("la página y sus archivos se sirven sin sesión, con CSP sin scripts en línea", async () => {
    sesion = null;
    const r = await pedir("");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-security-policy"), /script-src 'self'/);
    const html = await r.text();
    assert.match(html, /data-api="\/base\/stock\/api"/);
    assert.match(html, /data-cuenta="\/base\/cuenta\/"/);
    assert.match(html, /id="btn-col"/);
    assert.match(html, /id="col-orden"/);
    assert.match(html, /id="leyenda"/);
    assert.equal((html.match(/data-col="/g) ?? []).length, COLUMNAS.length + 1); // todas las columnas + la de evolución
    assert.equal((await pedir("/app.js")).status, 200);
    assert.equal((await pedir("/estilo.css")).status, 200);
  });
  test("la API exige sesión, empresa y permiso", async () => {
    sesion = null;
    assert.equal((await pedir("/api/datos")).status, 401);
    sesion = { auth: { empresaId: "otra" }, permisos: [PERMISO] };
    assert.equal((await pedir("/api/datos")).status, 403);
    sesion = { auth: { empresaId: "emp1" }, permisos: [] };
    assert.equal((await pedir("/api/datos")).status, 403);
  });
  test("datos: filtra, pagina y limpia las filas", async () => {
    sesion = { auth: { empresaId: "emp1" }, permisos: [PERMISO] };
    col.llamadas.length = 0;
    const r = await pedir("/api/datos?grado=A&tamano=20&pagina=3&urgente=si");
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.total, 42);
    assert.equal(j.pagina, 3);
    assert.equal(j.tamano, 20);
    assert.equal(j.filas[0].fecha, "2026-01-05");
    assert.equal(col.skip, 40);
    assert.equal(col.limit, 20);
    assert.deepEqual(col.llamadas.find((l) => l[0] === "count")[1], { gr: { $in: ["A"] }, ur: true });
    assert.equal(col.llamadas.find((l) => l[0] === "find")[2]._id, 0);
  });
  test("sin filtros usa el conteo estimado", async () => {
    col.llamadas.length = 0;
    const j = await (await pedir("/api/datos")).json();
    assert.equal(j.total, 281067);
    assert.ok(col.llamadas.some((l) => l[0] === "estimado"));
  });
  test("serie: pide un código exacto ordenado por fecha y solo el campo graficado", async () => {
    sesion = { auth: { empresaId: "emp1" }, permisos: [PERMISO] };
    col.llamadas.length = 0;
    const j = await (await pedir("/api/serie?codigo=ZM1&campo=total")).json();
    assert.equal(j.codigo, "ZM1");
    assert.deepEqual(j.puntos, [{ fecha: "2026-01-05", valor: 7 }]);
    const f = col.llamadas.find((l) => l[0] === "find");
    assert.deepEqual(f[1], { c: "ZM1" });
    assert.deepEqual(f[2], { _id: 0, f: 1, t: 1 });
    assert.deepEqual(col.orden, { f: 1 });
    assert.equal((await pedir("/api/serie")).status, 400);
    assert.equal((await pedir("/api/serie?codigo=ZM1&campo=x")).status, 400);
    sesion = null;
    assert.equal((await pedir("/api/serie?codigo=ZM1")).status, 401);
    sesion = { auth: { empresaId: "emp1" }, permisos: [PERMISO] };
  });
  test("series: una sola consulta con $in para todos los códigos y un arreglo por código", async () => {
    sesion = { auth: { empresaId: "emp1" }, permisos: [PERMISO] };
    col.llamadas.length = 0;
    const j = await (await pedir("/api/series?codigos=ZM1|ZM2")).json();
    assert.deepEqual(Object.keys(j.porCodigo), ["ZM1", "ZM2"]);
    assert.equal(col.llamadas.filter((l) => l[0] === "find").length, 1);
    assert.deepEqual(col.llamadas.find((l) => l[0] === "find")[1], { c: { $in: ["ZM1", "ZM2"] } });
    assert.deepEqual(col.orden, { c: 1, f: 1 });
    assert.equal((await pedir("/api/series")).status, 400);
    sesion = null;
    assert.equal((await pedir("/api/series?codigos=ZM1")).status, 401);
    sesion = { auth: { empresaId: "emp1" }, permisos: [PERMISO] };
  });
  test("parámetros inválidos dan 400 con mensaje", async () => {
    const r = await pedir("/api/datos?tamano=500");
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /tamano/);
  });
  test("filtros: valores únicos, ordenados y en caché", async () => {
    col.llamadas.length = 0;
    const j = await (await pedir("/api/filtros")).json();
    assert.deepEqual(j.grado, ["a", "Á", "b"]);
    await pedir("/api/filtros");
    assert.equal(col.llamadas.filter((l) => l[0] === "distinct").length, 5); // solo la primera vez
  });
});

test("sin STOCK_EMPRESA_ID queda desactivado (503) y lo avisa", async () => {
  const avisos = [];
  const app = express();
  app.use("/stock", createRouter({ core: {}, db: {}, env: {}, avisar: (m) => avisos.push(m) }));
  const s = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/stock/api/datos`);
    assert.equal(r.status, 503);
    assert.match(avisos[0], /STOCK_EMPRESA_ID/);
  } finally {
    s.close();
  }
});

describe("catálogo de columnas", () => {
  test("sin repetidos: ni nombres ni claves cortas", () => {
    const campos = COLUMNAS.map((c) => c.campo), cortos = [...COLUMNAS.map((c) => c.corto), ...Object.values(INTERNOS)];
    assert.equal(new Set(campos).size, campos.length);
    assert.equal(new Set(cortos).size, cortos.length);
    assert.ok(cortos.every((k) => /^[a-z0-9]{1,2}$/.test(k)));
  });
  test("las columnas nuevas empiezan ocultas; las de siempre, no", () => {
    assert.equal(COLUMNAS.slice(0, 23).filter((c) => c.oculta).length, 0);
    assert.ok(COLUMNAS.slice(23).every((c) => c.oculta));
    assert.deepEqual([...new Set(COLUMNAS.map((c) => c.grupo))], ["base", "equivalentes", "stock", "calculo"]);
  });
  test("la celda de Colab crea los mismos índices que el router", () => {
    const py = readFileSync(new URL("../herramientas/colab-cargar-stock.py", import.meta.url), "utf8");
    assert.match(py, /create_index\(\[\("c", 1\), \("f", 1\)\], unique=True\)/);
    assert.match(py, /create_index\(\[\("f", -1\), \("c", 1\)\]\)/);
    for (const c of ["segmento", "rotacion", "estado", "grado", "marca", "urgente"]) assert.ok(py.includes(`"${CORTO[c]}"`), c);
  });
  test("la celda de Colab usa exactamente las mismas claves cortas", () => {
    const py = readFileSync(new URL("../herramientas/colab-cargar-stock.py", import.meta.url), "utf8");
    const bloque = py.slice(py.indexOf("CLAVES = {"), py.indexOf("}", py.indexOf("CLAVES = {")));
    const enPy = Object.fromEntries([...bloque.matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
    assert.deepEqual(enPy, CORTO);
  });
});

test("la API devuelve nombres largos aunque Mongo guarde claves cortas", async () => {
  const col = coleccionFalsa();
  const core = { autenticar: () => (q, r, n) => ((q.auth = { empresaId: "e1" }), n()), requierePermiso: () => (q, r, n) => n() };
  const app = express();
  app.use("/stock", createRouter({ core, db: { collection: () => col }, env: { STOCK_EMPRESA_ID: "e1" }, avisar: () => {} }));
  const s = app.listen(0);
  try {
    const j = await (await fetch(`http://127.0.0.1:${s.address().port}/stock/api/datos`)).json();
    assert.equal(j.filas[0].equivalente_stock, "ZM2 (3)");
    assert.equal(j.filas[0].pedido_central, 12);
    assert.equal(j.filas[0].codigo, "ZM1");
    assert.equal(j.filas[0].stock_lv, null); // columna que el documento no trae
    assert.equal(col.llamadas.find((l) => l[0] === "find")[2].eq, 1); // y se pide con su clave corta
  } finally {
    s.close();
  }
});

describe("exportación", () => {
  const fila = (o) => ({ c: "UF-1", d: "Arrancador", f: new Date("2026-10-30T00:00:00Z"), m: "BOSCH", t: 50, pc: 0, pp: 0, ef: 0.5, ur: false, mt: "Error esperado 28%", ...o });
  const DOCS = [fila({ c: "UF-1", t: 0, pc: 40, pp: 60, ef: 0.9 }), fila({ c: "UF-2", t: 30, pc: 9, pp: 12, ef: 0.2, ur: true }), fila({ c: "UF-3", t: 80, pc: 0, pp: 0, ef: null })];
  function coleccion(total) {
    const c = { llamadas: [] };
    c.find = (filtro, opc) => {
      c.llamadas.push(["find", filtro, opc.projection]);
      const cur = { sort: (o) => ((c.orden = o), cur), batchSize: () => cur, close: async () => {}, async *[Symbol.asyncIterator]() { yield* DOCS; } };
      return cur;
    };
    c.countDocuments = async () => total;
    c.estimatedDocumentCount = async () => total;
    c.createIndex = async () => {};
    return c;
  }
  async function servir(env, total = 3) {
    const col = coleccion(total);
    const core = { autenticar: () => (q, r, n) => (sesionEx ? ((q.auth = { empresaId: "e1" }), n()) : r.status(401).json({ error: "sin sesión" })), requierePermiso: () => (q, r, n) => n() };
    const app = express();
    app.use("/stock", createRouter({ core, db: { collection: () => col }, env: { STOCK_EMPRESA_ID: "e1", ...env }, avisar: () => {} }));
    const s = app.listen(0);
    return { col, s, url: `http://127.0.0.1:${s.address().port}/stock/api/exportar` };
  }
  let sesionEx = true;
  const leerXlsx = async (r) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await r.arrayBuffer())); return wb; };

  test("leerExportacion: formato y columnas válidos, en el orden pedido", () => {
    const { formato, columnas } = leerExportacion({ formato: "xlsx", columnas: "pedido_central|codigo|total" });
    assert.equal(formato, "xlsx");
    assert.deepEqual(columnas.map((c) => c.campo), ["pedido_central", "codigo", "total"]);
    assert.ok(leerExportacion({ formato: "pdf" }).columnas.length >= 23); // sin columnas: las visibles de fábrica
    assert.throws(() => leerExportacion({ formato: "csv" }), ErrorConsulta);
    assert.throws(() => leerExportacion({ formato: "xlsx", columnas: "codigo|codigo" }), ErrorConsulta);
    assert.throws(() => leerExportacion({ formato: "xlsx", columnas: "codigo|$where" }), ErrorConsulta);
  });
  test("formato: agotado en rojo, pedido en amarillo según efectividad, y niveles para Excel", () => {
    assert.equal(colorCasilla("total", { total: 0 }), "F6C4BF");
    assert.equal(colorCasilla("total", { total: 5 }), null);
    assert.equal(colorCasilla("total", { total: null }), null);
    assert.equal(colorCasilla("pedido_central", { pedido_central: 0, efectividad: 1 }), null);
    assert.notEqual(colorCasilla("pedido_central", { pedido_central: 9, efectividad: 0.1 }), colorCasilla("pedido_central", { pedido_central: 9, efectividad: 0.95 }));
    assert.equal(amarilloHex(1), "F2C200");
    assert.equal(nivelIntensidad(0.15), 0.125);
    const niveles = new Set(Array.from({ length: 101 }, (_, i) => colorCasilla("pedido_central", { pedido_central: 1, efectividad: i / 100 }, true)));
    assert.ok(niveles.size <= 8, `hasta 8 colores en Excel, hubo ${niveles.size}`);
  });
  test("Excel: columnas en el orden pedido, filtros aplicados y colores", async () => {
    const { col, s, url } = await servir({});
    try {
      const r = await fetch(`${url}?formato=xlsx&columnas=codigo|pedido_central|total|urgente|fecha&grado=A&orden=total&dir=asc`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type"), /spreadsheetml/);
      assert.match(r.headers.get("content-disposition"), /attachment; filename="stock-\d{4}-\d{2}-\d{2}\.xlsx"/);
      assert.equal(r.headers.get("x-stock-formato"), "con-colores");
      const wb = await leerXlsx(r);
      const ws = wb.getWorksheet("Stock");
      assert.deepEqual(ws.getRow(1).values.slice(1), ["Código", "Pedido central", "Stock", "Urgente", "Fecha"]);
      assert.equal(ws.rowCount, 4);
      assert.deepEqual([ws.getRow(2).getCell(1).value, ws.getRow(2).getCell(2).value, ws.getRow(2).getCell(3).value, ws.getRow(2).getCell(4).value], ["UF-1", 40, 0, "No"]);
      assert.equal(ws.getRow(3).getCell(4).value, "Sí");
      assert.ok(ws.getRow(2).getCell(5).value instanceof Date);
      assert.equal(ws.getRow(2).getCell(3).fill.fgColor.argb, "FFF6C4BF"); // stock 0 → rojo
      assert.match(ws.getRow(2).getCell(2).fill.fgColor.argb, /^FFF/); // pedido > 0 → amarillo
      assert.ok(!ws.getRow(4).getCell(2).fill || !ws.getRow(4).getCell(2).fill.fgColor); // pedido 0 → sin color
      const resumen = wb.getWorksheet("Resumen");
      assert.match(resumen.getRow(3).getCell(2).value, /Grado: A/);
      // solo se piden a MongoDB las columnas elegidas más las dos que deciden los colores
      const proy = col.llamadas.find((l) => l[0] === "find")[2];
      assert.deepEqual(Object.keys(proy).sort(), ["_id", "c", "ef", "f", "pc", "t", "ur"].sort());
      assert.deepEqual(col.orden, { t: 1, c: 1, f: -1 });
      assert.deepEqual(col.llamadas.find((l) => l[0] === "find")[1], { gr: { $in: ["A"] } });
    } finally { s.close(); }
  });
  test("Excel: con más filas que el límite de formato sale sin colores y lo avisa", async () => {
    const { s, url } = await servir({ STOCK_EXPORT_FORMATO_XLSX: "2" }, 3);
    try {
      const r = await fetch(`${url}?formato=xlsx&columnas=codigo|total|pedido_central`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get("x-stock-formato"), /^sin-colores; limite=2$/);
      const wb = await leerXlsx(r);
      const ws = wb.getWorksheet("Stock");
      assert.equal(ws.rowCount, 4); // los datos están todos
      for (let i = 2; i <= 4; i++) for (let j = 1; j <= 3; j++) assert.ok(!ws.getRow(i).getCell(j).fill || !ws.getRow(i).getCell(j).fill.fgColor, `fila ${i} col ${j} sin color`);
      assert.match(wb.getWorksheet("Resumen").getRow(4).getCell(2).value, /No incluido/);
    } finally { s.close(); }
  });
  test("Excel y PDF: sobre el tope de filas se rechaza con 413 y un mensaje útil", async () => {
    const { s, url } = await servir({ STOCK_EXPORT_MAX_XLSX: "2", STOCK_EXPORT_MAX_PDF: "1" }, 3);
    try {
      for (const f of ["xlsx", "pdf"]) {
        const r = await fetch(`${url}?formato=${f}&columnas=codigo|total`);
        assert.equal(r.status, 413, f);
        assert.match((await r.json()).error, /filtros/i);
      }
    } finally { s.close(); }
  });
  test("PDF: se genera con los colores; demasiadas columnas anchas dan 413", async () => {
    const { s, url } = await servir({});
    try {
      const r = await fetch(`${url}?formato=pdf&columnas=fecha|codigo|detalle|marca|total|pedido_central|pedido_prudente|efectividad|motivo`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-type"), "application/pdf");
      const b = Buffer.from(await r.arrayBuffer());
      assert.equal(b.subarray(0, 5).toString(), "%PDF-");
      assert.ok(b.length > 2000);
      const todas = COLUMNAS.map((c) => c.campo).join("|");
      const r2 = await fetch(`${url}?formato=pdf&columnas=${todas}`);
      assert.equal(r2.status, 413);
      assert.match((await r2.json()).error, /demasiadas columnas/i);
    } finally { s.close(); }
    assert.equal(planPdf(COLUMNAS.slice(0, 8)).error, undefined);
    assert.ok(planPdf(COLUMNAS).error);
  });
  test("exige sesión (401) y valida parámetros (400)", async () => {
    const { s, url } = await servir({});
    try {
      sesionEx = false;
      assert.equal((await fetch(`${url}?formato=xlsx`)).status, 401);
      sesionEx = true;
      assert.equal((await fetch(`${url}?formato=csv`)).status, 400);
      assert.equal((await fetch(`${url}?formato=xlsx&columnas=nope`)).status, 400);
      assert.equal((await fetch(`${url}?formato=xlsx&desde=ayer`)).status, 400);
    } finally { sesionEx = true; s.close(); }
  });
});
