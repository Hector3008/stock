import express from "express";
import { readFileSync } from "node:fs";
import { COLUMNAS, CAMPOS_FILTRO_LISTA, ErrorConsulta, MAX_PUNTOS, SERIES, leerConsulta, leerSerie, leerSeries, limpiarFila, limpiarSerie, proyeccion } from "./consulta.js";
import { paginaStock } from "./pagina.js";

// Visor de la snapshot diaria código×día. Se monta en el gateway como un router más:
//   import { createRouter as crearStock } from "stock";
//   gateway.use("/stock", crearStock({ core, db }));
// Los datos los carga el notebook de Colab directo a MongoDB (colección stock_snapshot); aquí solo se leen.
// Exige sesión y el permiso stock:leer, y solo en la empresa STOCK_EMPRESA_ID: sin ella el visor queda desactivado (503),
// porque la colección no tiene empresaId y otra empresa con permiso «*» no debe leer estos datos.
//   GET /            página (HTML fijo, sin datos), más /app.js y /estilo.css
//   GET /api/filtros valores para los selectores (grado, segmento, rotación, estado, marca)
//   GET /api/datos   filas paginadas (10 o 20) con filtros y orden en el servidor
//   GET /api/series  la misma evolución de todos los códigos de la página de una vez (?codigos=ZM1|ZM2): una columna de líneas pequeñas
//   GET /api/serie   evolución de un código en el tiempo (?codigo=&campo=total|cobertura_dias|…) para el gráfico de línea de cada fila

export const PERMISO = "stock:leer";
export const COLECCION = "stock_snapshot";
const leer = (n) => readFileSync(new URL(n, import.meta.url), "utf8");

const INDICES = [
  [{ codigo: 1, fecha: 1 }, { unique: true }],
  [{ fecha: -1, codigo: 1 }, {}],
  [{ segmento: 1, fecha: -1 }, {}],
  [{ rotacion: 1, fecha: -1 }, {}],
  [{ estado: 1, fecha: -1 }, {}],
  [{ grado: 1, fecha: -1 }, {}],
  [{ marca: 1, fecha: -1 }, {}],
  [{ urgente: 1, fecha: -1 }, {}],
];

/**
 * @param {object} o
 * @param {object} o.core  el núcleo del gateway (autenticar y requierePermiso)
 * @param {object} o.db    el Db del driver nativo, de la misma conexión del gateway
 * @param {string} [o.rutaLogin]  dónde mandar a quien no tiene sesión; por defecto «<gateway>/cuenta/» (el hermano /cuenta del punto de montaje)
 */
export function createRouter({ core, db, env = process.env, avisar = console.warn, rutaLogin, ahora = () => Date.now(), vigenciaListasMs = 10 * 60 * 1000 } = {}) {
  const empresaId = env.STOCK_EMPRESA_ID?.trim();
  const habilitado = !!empresaId && !!db && !!core?.autenticar && !!core?.requierePermiso;
  if (!habilitado) avisar("[stock] visor desactivado: falta STOCK_EMPRESA_ID (o core / db).");

  const router = express.Router();
  router.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    if (!habilitado) return res.status(503).json({ error: "visor de stock no configurado" });
    next();
  });
  if (!habilitado) return router; // desactivado: todo responde 503 y no se toca el núcleo

  const coleccion = () => db.collection(COLECCION);
  const js = leer("cliente/app.js");
  const css = leer("cliente/estilo.css");

  // Los índices son idempotentes. Si fallan no se tumba el gateway: la consulta funciona, solo más lenta.
  Promise.all(INDICES.map(([k, o]) => coleccion().createIndex(k, { background: true, ...o }))).catch((e) =>
    avisar(`[stock] no se pudieron crear los índices: ${e?.message ?? e}`),
  );

  const enviar = (res, tipo, cuerpo) => res.type(tipo).send(cuerpo);
  const loginDe = (req) => rutaLogin ?? `${req.baseUrl.replace(/\/[^/]*$/, "")}/cuenta/`;

  router.get("/", (req, res) => enviar(res, "html", paginaStock({ base: req.baseUrl, login: loginDe(req) })));
  router.get("/app.js", (req, res) => enviar(res, "js", js));
  router.get("/estilo.css", (req, res) => enviar(res, "css", css));

  const soloEmpresa = (req, res, next) =>
    String(req.auth?.empresaId) === empresaId ? next() : res.status(403).json({ error: "sin acceso a esta empresa" });
  const acceso = [core.autenticar({ requiereEmpresa: true }), soloEmpresa, core.requierePermiso(PERMISO)];

  let listas = null;
  router.get("/api/filtros", ...acceso, async (req, res, next) => {
    try {
      if (!listas || listas.vence <= ahora()) {
        const valores = {};
        for (const c of CAMPOS_FILTRO_LISTA) {
          valores[c] = (await coleccion().distinct(c)).filter((v) => typeof v === "string" && v).sort((a, b) => a.localeCompare(b, "es"));
        }
        listas = { valores, vence: ahora() + vigenciaListasMs };
      }
      res.json(listas.valores);
    } catch (e) {
      next(e);
    }
  });

  router.get("/api/datos", ...acceso, async (req, res, next) => {
    try {
      const { filtro, orden, pagina, tamano } = leerConsulta(req.query);
      const vacio = Object.keys(filtro).length === 0;
      const [filas, total] = await Promise.all([
        coleccion().find(filtro, { projection: proyeccion() }).sort(orden).skip((pagina - 1) * tamano).limit(tamano).toArray(),
        vacio ? coleccion().estimatedDocumentCount() : coleccion().countDocuments(filtro),
      ]);
      res.json({ total, pagina, tamano, columnas: COLUMNAS, filas: filas.map(limpiarFila) });
    } catch (e) {
      next(e);
    }
  });

  router.get("/api/serie", ...acceso, async (req, res, next) => {
    try {
      const { codigo, campo } = leerSerie(req.query);
      const docs = await coleccion().find({ codigo }, { projection: { _id: 0, fecha: 1, [campo]: 1 } }).sort({ fecha: 1 }).limit(MAX_PUNTOS).toArray();
      res.json({ codigo, campo, series: SERIES, puntos: limpiarSerie(docs, campo) });
    } catch (e) {
      next(e);
    }
  });

  router.get("/api/series", ...acceso, async (req, res, next) => {
    try {
      const { codigos, campo } = leerSeries(req.query);
      const docs = await coleccion()
        .find({ codigo: { $in: codigos } }, { projection: { _id: 0, codigo: 1, fecha: 1, [campo]: 1 } })
        .sort({ codigo: 1, fecha: 1 })
        .limit(codigos.length * MAX_PUNTOS)
        .toArray();
      const porCodigo = Object.fromEntries(codigos.map((c) => [c, []]));
      for (const c of codigos) porCodigo[c] = limpiarSerie(docs.filter((d) => d.codigo === c), campo);
      res.json({ campo, series: SERIES, porCodigo });
    } catch (e) {
      next(e);
    }
  });

  // Errores del visor: los de validación como 400; el resto se registra y se responde sin detalles.
  router.use((err, req, res, next) => {
    if (err instanceof ErrorConsulta) return res.status(400).json({ error: err.message });
    avisar(`[stock] error: ${err?.message ?? err}`);
    res.status(500).json({ error: "no se pudo leer el stock" });
  });

  return router;
}

export default createRouter;
export { PERMISO as permisoStock };
