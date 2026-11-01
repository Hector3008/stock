// Paquete stock (5.70): validación de consultas y rutas con un núcleo y una colección falsos.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { leerConsulta, leerSerie, leerSeries, limpiarSerie, normalizar, limpiarFila, ErrorConsulta } from "../src/consulta.js";
import { createRouter, PERMISO } from "../src/index.js";

describe("leerConsulta", () => {
  test("valores por defecto", () => {
    const q = leerConsulta({});
    assert.deepEqual(q.filtro, {});
    assert.deepEqual(q.orden, { fecha: -1, codigo: 1 });
    assert.equal(q.pagina, 1);
    assert.equal(q.tamano, 10);
  });
  test("texto: sin tildes, en minúsculas y con los símbolos de regex escapados", () => {
    assert.equal(normalizar("  Válvula   DE  Bola "), "valvula de bola");
    const q = leerConsulta({ codigo: "ZM.*(", detalle: "Válvula bola" });
    assert.deepEqual(q.filtro.$and[0], { codigo_n: { $regex: "zm\\.\\*\\(" } });
    assert.deepEqual(q.filtro.$and.slice(1), [{ detalle_n: { $regex: "valvula" } }, { detalle_n: { $regex: "bola" } }]);
  });
  test("fechas: rango inclusivo, formato y orden", () => {
    const q = leerConsulta({ desde: "2026-01-05", hasta: "2026-02-01" });
    assert.equal(q.filtro.fecha.$gte.toISOString(), "2026-01-05T00:00:00.000Z");
    assert.equal(q.filtro.fecha.$lte.toISOString(), "2026-02-01T00:00:00.000Z");
    assert.throws(() => leerConsulta({ desde: "05/01/2026" }), ErrorConsulta);
    assert.throws(() => leerConsulta({ desde: "2026-02-30" }), ErrorConsulta);
    assert.throws(() => leerConsulta({ desde: "2026-03-01", hasta: "2026-02-01" }), ErrorConsulta);
  });
  test("listas: uno o varios valores, también con |; urgente si/no", () => {
    const q = leerConsulta({ grado: ["A", "B"], segmento: "X|Y", urgente: "si" });
    assert.deepEqual(q.filtro.grado, { $in: ["A", "B"] });
    assert.deepEqual(q.filtro.segmento, { $in: ["X", "Y"] });
    assert.equal(q.filtro.urgente, true);
    assert.equal(leerConsulta({ urgente: "no" }).filtro.urgente, false);
    assert.equal("urgente" in leerConsulta({ urgente: "" }).filtro, false);
    assert.throws(() => leerConsulta({ urgente: "tal vez" }), ErrorConsulta);
  });
  test("un operador de MongoDB en el query string no pasa", () => {
    // ?grado[$ne]=x llega como objeto: se convierte a texto y queda como valor literal, nunca como operador
    const q = leerConsulta({ grado: { $ne: "x" } });
    assert.deepEqual(q.filtro.grado, { $in: ["[object Object]"] });
    assert.throws(() => leerConsulta({ orden: "$where" }), ErrorConsulta);
  });
  test("paginación: solo 10 o 20, página entera positiva", () => {
    assert.equal(leerConsulta({ tamano: "20", pagina: "3" }).tamano, 20);
    assert.throws(() => leerConsulta({ tamano: "50" }), ErrorConsulta);
    assert.throws(() => leerConsulta({ pagina: "0" }), ErrorConsulta);
    assert.throws(() => leerConsulta({ pagina: "1.5" }), ErrorConsulta);
  });
  test("orden con desempate estable", () => {
    assert.deepEqual(leerConsulta({ orden: "cobertura_dias", dir: "asc" }).orden, { cobertura_dias: 1, codigo: 1, fecha: -1 });
    assert.deepEqual(leerConsulta({ orden: "codigo", dir: "desc" }).orden, { codigo: -1, fecha: -1 });
  });
});

test("limpiarFila: fechas en texto, NaN y ausentes como null, sin columnas ajenas", () => {
  const f = limpiarFila({ _id: 1, secreto: "x", codigo: "ZM1", fecha: new Date("2026-01-05T00:00:00Z"), total: NaN, grado: "A" });
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
    const d = (s, total) => ({ fecha: new Date(`${s}T00:00:00Z`), total });
    assert.deepEqual(limpiarSerie([d("2026-01-05", 3), d("2026-01-06", NaN), d("2026-01-07", null), { fecha: null, total: 1 }, d("2026-01-08", 0)], "total"), [
      { fecha: "2026-01-05", valor: 3 },
      { fecha: "2026-01-08", valor: 0 },
    ]);
  });
});

function coleccionFalsa() {
  const c = { llamadas: [], docs: [{ codigo: "ZM1", detalle: "Café", fecha: new Date("2026-01-05T00:00:00Z"), grado: "A", segmento: "X", urgente: true }] };
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
    assert.equal((html.match(/data-col="/g) ?? []).length, 24); // 23 columnas + la de evolución
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
    assert.deepEqual(col.llamadas.find((l) => l[0] === "count")[1], { grado: { $in: ["A"] }, urgente: true });
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
    assert.deepEqual(j.puntos, []); // el doc falso no trae total
    const f = col.llamadas.find((l) => l[0] === "find");
    assert.deepEqual(f[1], { codigo: "ZM1" });
    assert.deepEqual(f[2], { _id: 0, fecha: 1, total: 1 });
    assert.deepEqual(col.orden, { fecha: 1 });
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
    assert.deepEqual(col.llamadas.find((l) => l[0] === "find")[1], { codigo: { $in: ["ZM1", "ZM2"] } });
    assert.deepEqual(col.orden, { codigo: 1, fecha: 1 });
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
