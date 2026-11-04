import express from "express";
import { readFileSync } from "node:fs";
import { K } from "./columnas.js";
import { COLUMNAS, CAMPOS_FILTRO_LISTA, ErrorConsulta, ErrorLimite, MAX_PUNTOS, SERIES, leerConsulta, leerExportacion, leerSerie, leerSeries, limpiarFila, limpiarSerie, proyeccion, proyeccionPara } from "./consulta.js";
import { describirFiltros, escribirPdf, escribirXlsx, planPdf } from "./exportar.js";
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
//   GET /api/exportar  la vista actual (filtros, columnas visibles y orden) como Excel o PDF; ver LIMITES_EXPORTACION
//   GET /api/serie   evolución de un código en el tiempo (?codigo=&campo=total|cobertura_dias|…) para el gráfico de línea de cada fila

export const PERMISO = "stock:leer";
export const COLECCION = "stock_snapshot";
// Topes de la exportación (variables de entorno STOCK_EXPORT_*): por encima del tope de filas se rechaza con un aviso, y el Excel
// con más filas que FORMATO_XLSX sale sin colores (cada casilla coloreada es un estilo más y el archivo crece mucho).
const entero = (v, por) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : por);
export const limitesExportacion = (env = process.env) => ({
  maxXlsx: entero(env.STOCK_EXPORT_MAX_XLSX, 100000),
  maxPdf: entero(env.STOCK_EXPORT_MAX_PDF, 2000),
  formatoXlsx: entero(env.STOCK_EXPORT_FORMATO_XLSX, 20000),
});
const leer = (n) => readFileSync(new URL(n, import.meta.url), "utf8");

const INDICES = [
  [{ [K("codigo")]: 1, [K("fecha")]: 1 }, { unique: true }],
  [{ [K("fecha")]: -1, [K("codigo")]: 1 }, {}],
  ...["segmento", "rotacion", "estado", "grado", "marca", "urgente"].map((c) => [{ [K(c)]: 1, [K("fecha")]: -1 }, {}]),
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
  const limites = limitesExportacion(env);
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
          valores[c] = (await coleccion().distinct(K(c))).filter((v) => typeof v === "string" && v).sort((a, b) => a.localeCompare(b, "es"));
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
      const docs = await coleccion().find({ [K("codigo")]: codigo }, { projection: { _id: 0, [K("fecha")]: 1, [K(campo)]: 1 } }).sort({ [K("fecha")]: 1 }).limit(MAX_PUNTOS).toArray();
      res.json({ codigo, campo, series: SERIES, puntos: limpiarSerie(docs, campo) });
    } catch (e) {
      next(e);
    }
  });

  router.get("/api/series", ...acceso, async (req, res, next) => {
    try {
      const { codigos, campo } = leerSeries(req.query);
      const docs = await coleccion()
        .find({ [K("codigo")]: { $in: codigos } }, { projection: { _id: 0, [K("codigo")]: 1, [K("fecha")]: 1, [K(campo)]: 1 } })
        .sort({ [K("codigo")]: 1, [K("fecha")]: 1 })
        .limit(codigos.length * MAX_PUNTOS)
        .toArray();
      const porCodigo = Object.fromEntries(codigos.map((c) => [c, []]));
      for (const c of codigos) porCodigo[c] = limpiarSerie(docs.filter((d) => d[K("codigo")] === c), campo);
      res.json({ campo, series: SERIES, porCodigo });
    } catch (e) {
      next(e);
    }
  });

  const hoy = () => new Date(ahora()).toISOString().slice(0, 10);
  router.get("/api/exportar", ...acceso, async (req, res, next) => {
    let cursor;
    try {
      const { formato, columnas } = leerExportacion(req.query);
      const { filtro, orden } = leerConsulta({ ...req.query, tamano: "10", pagina: "1" });
      const vacio = Object.keys(filtro).length === 0;
      const total = vacio ? await coleccion().estimatedDocumentCount() : await coleccion().countDocuments(filtro);
      const tope = formato === "pdf" ? limites.maxPdf : limites.maxXlsx;
      if (total > tope) {
        throw new ErrorLimite(`Hay ${total.toLocaleString("es-PE")} filas y un ${formato === "pdf" ? "PDF" : "Excel"} admite hasta ${tope.toLocaleString("es-PE")}. Aplica filtros (por ejemplo un rango de fechas) para reducirlas.`);
      }
      if (formato === "pdf") { const plan = planPdf(columnas); if (plan.error) throw new ErrorLimite(plan.error); }
      const conFormato = formato === "pdf" || total <= limites.formatoXlsx;
      cursor = coleccion().find(filtro, { projection: proyeccionPara(columnas, conFormato) }).sort(orden).batchSize(1000);
      async function* filas() { for await (const d of cursor) yield limpiarFila(d); }
      const lineas = [`Generado: ${hoy()}`, `Filas: ${total.toLocaleString("es-PE")}`, `Filtros: ${describirFiltros(req.query)}`];
      res.set({
        "Content-Type": formato === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="stock-${hoy()}.${formato}"`,
        "X-Stock-Formato": conFormato ? "con-colores" : `sin-colores; limite=${limites.formatoXlsx}`,
        "Access-Control-Expose-Headers": "X-Stock-Formato, Content-Disposition",
      });
      res.on("close", () => cursor.close?.().catch?.(() => {})); // si se cierra la pestaña a mitad, se libera la consulta
      if (formato === "pdf") await escribirPdf({ salida: res, columnas, filas: filas(), titulo: "Stock · predicción diaria", lineas });
      else {
        await escribirXlsx({
          salida: res, columnas, filas: filas(), conFormato,
          resumen: [
            "Generado\t" + hoy(), "Filas\t" + total, "Filtros\t" + describirFiltros(req.query),
            "Formato condicional\t" + (conFormato ? "Incluido: stock agotado en rojo claro y pedido sugerido en amarillo (más intenso = mayor efectividad)" : `No incluido: hay más de ${limites.formatoXlsx.toLocaleString("es-PE")} filas`),
          ],
        });
      }
    } catch (e) {
      if (res.headersSent) { res.destroy(e); return; } // ya se empezó a enviar el archivo: no se puede responder con un error limpio
      next(e);
    }
  });

  // Errores del visor: los de validación como 400; el resto se registra y se responde sin detalles.
  router.use((err, req, res, next) => {
    if (err instanceof ErrorConsulta) return res.status(err.status ?? 400).json({ error: err.message });
    avisar(`[stock] error: ${err?.message ?? err}`);
    res.status(500).json({ error: "no se pudo leer el stock" });
  });

  return router;
}

export default createRouter;
export { PERMISO as permisoStock };
