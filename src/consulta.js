// Traduce los parámetros de la URL a un filtro de MongoDB para la colección stock_snapshot (5.70).
// Todo lo que llega del cliente se valida contra listas fijas: nada del query string pasa directo al filtro.

import { COLUMNAS, K } from "./columnas.js";
export { COLUMNAS };

export const TAMANOS = [10, 20];
export const MAX_PAGINA = 100000;

export const CAMPOS_FILTRO_LISTA = ["grado", "segmento", "rotacion", "estado", "marca"];
export const CAMPOS_ORDEN = new Set(COLUMNAS.map((c) => c.campo));
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export class ErrorConsulta extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = "ErrorConsulta";
    this.status = 400;
  }
}

/** Minúsculas y sin tildes: es lo que guarda el cargador en codigo_n y detalle_n. */
export function normalizar(texto) {
  return String(texto ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim().replace(/\s+/g, " ");
}
const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function fecha(valor, nombre) {
  if (!FECHA.test(valor)) throw new ErrorConsulta(`${nombre} debe tener la forma AAAA-MM-DD`);
  const d = new Date(`${valor}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== valor) throw new ErrorConsulta(`${nombre} no es una fecha válida`);
  return d;
}
const uno = (v) => (Array.isArray(v) ? v[0] : v);
const lista = (v) => (v === undefined ? [] : (Array.isArray(v) ? v : [v])).flatMap((x) => String(x).split("|")).map((x) => x.trim()).filter(Boolean);

/** Devuelve { filtro, orden, pagina, tamano } o lanza ErrorConsulta. */
export function leerConsulta(query = {}) {
  const filtro = {};
  const y = [];

  const codigo = normalizar(uno(query.codigo));
  if (codigo) {
    if (codigo.length > 60) throw new ErrorConsulta("codigo es demasiado largo");
    y.push({ [K("codigo_n")]: { $regex: escapar(codigo) } });
  }
  const detalle = normalizar(uno(query.detalle));
  if (detalle) {
    if (detalle.length > 120) throw new ErrorConsulta("detalle es demasiado largo");
    for (const palabra of detalle.split(" ").slice(0, 6)) y.push({ [K("detalle_n")]: { $regex: escapar(palabra) } });
  }
  if (y.length) filtro.$and = y;

  const desde = uno(query.desde);
  const hasta = uno(query.hasta);
  if (desde || hasta) {
    const f = (filtro[K("fecha")] = {});
    if (desde) f.$gte = fecha(desde, "desde");
    if (hasta) f.$lte = fecha(hasta, "hasta");
    if (desde && hasta && f.$gte > f.$lte) throw new ErrorConsulta("desde no puede ser posterior a hasta");
  }

  for (const campo of CAMPOS_FILTRO_LISTA) {
    const valores = lista(query[campo]);
    if (valores.length > 50) throw new ErrorConsulta(`${campo} admite hasta 50 valores`);
    if (valores.length) filtro[K(campo)] = { $in: valores };
  }

  const urgente = uno(query.urgente);
  if (urgente !== undefined && urgente !== "") {
    if (urgente !== "si" && urgente !== "no") throw new ErrorConsulta("urgente debe ser si o no");
    filtro[K("urgente")] = urgente === "si";
  }

  const ord = uno(query.orden) ?? "fecha";
  if (!CAMPOS_ORDEN.has(ord)) throw new ErrorConsulta("orden no válido");
  const dir = uno(query.dir) ?? (ord === "fecha" ? "desc" : "asc");
  if (dir !== "asc" && dir !== "desc") throw new ErrorConsulta("dir debe ser asc o desc");
  // Desempate estable para que la paginación no repita ni salte filas.
  const orden = { [K(ord)]: dir === "asc" ? 1 : -1 };
  if (ord !== "codigo") orden[K("codigo")] = 1;
  if (ord !== "fecha") orden[K("fecha")] = -1;

  const tamano = Number(uno(query.tamano) ?? 10);
  if (!TAMANOS.includes(tamano)) throw new ErrorConsulta("tamano debe ser 10 o 20");
  const pagina = Number(uno(query.pagina) ?? 1);
  if (!Number.isInteger(pagina) || pagina < 1 || pagina > MAX_PAGINA) throw new ErrorConsulta("pagina no válida");

  return { filtro, orden, pagina, tamano };
}

export const proyeccion = () => ({ _id: 0, ...Object.fromEntries(COLUMNAS.map((c) => [c.corto, 1])) });

/** Deja cada fila con solo las columnas conocidas; fechas en AAAA-MM-DD; NaN e indefinidos como null. */
export function limpiarFila(doc) {
  const fila = {};
  for (const { campo, tipo } of COLUMNAS) {
    let v = doc[K(campo)];
    if (v === undefined || (typeof v === "number" && !Number.isFinite(v))) v = null;
    if (tipo === "fecha" && v instanceof Date) v = v.toISOString().slice(0, 10);
    fila[campo] = v;
  }
  return fila;
}

// Series que se pueden graficar por código (lista fija: el campo del query string nunca pasa directo a la consulta).
export const SERIES = [
  { campo: "total", titulo: "Stock" },
  { campo: "cobertura_dias", titulo: "Cobertura (días)" },
  { campo: "nivel_dia", titulo: "Nivel/día" },
  { campo: "demanda_300d_pred", titulo: "Demanda 300 d" },
  { campo: "pedido_central", titulo: "Pedido central" },
];
export const MAX_PUNTOS = 5000;

/** Devuelve { codigo, campo } o lanza ErrorConsulta. El código se busca exacto (tal como viene en la fila). */
export function leerSerie(query = {}) {
  const codigo = String(uno(query.codigo) ?? "").trim();
  if (!codigo) throw new ErrorConsulta("codigo es obligatorio");
  if (codigo.length > 60) throw new ErrorConsulta("codigo es demasiado largo");
  const campo = uno(query.campo) ?? "total";
  if (!SERIES.some((x) => x.campo === campo)) throw new ErrorConsulta("campo no válido");
  return { codigo, campo };
}

/** Puntos { fecha: "AAAA-MM-DD", valor } listos para graficar; descarta los que no tienen valor. */
export function limpiarSerie(docs, campo) {
  const puntos = [];
  for (const d of docs) {
    const v = d[K(campo)];
    const f = d[K("fecha")];
    if (!(f instanceof Date) || typeof v !== "number" || !Number.isFinite(v)) continue;
    puntos.push({ fecha: f.toISOString().slice(0, 10), valor: v });
  }
  return puntos;
}

export const MAX_CODIGOS = 20;

/** Varios códigos a la vez (la página trae 10 o 20): ?codigos=ZM1|ZM2&campo=total → { codigos, campo }. */
export function leerSeries(query = {}) {
  const codigos = [...new Set(String(uno(query.codigos) ?? "").split("|").map((c) => c.trim()).filter(Boolean))];
  if (!codigos.length) throw new ErrorConsulta("codigos es obligatorio");
  if (codigos.length > MAX_CODIGOS) throw new ErrorConsulta(`codigos admite hasta ${MAX_CODIGOS}`);
  if (codigos.some((c) => c.length > 60)) throw new ErrorConsulta("codigo es demasiado largo");
  const campo = uno(query.campo) ?? "total";
  if (!SERIES.some((x) => x.campo === campo)) throw new ErrorConsulta("campo no válido");
  return { codigos, campo };
}

/** Una exportación que pasa un tope: 413 con un mensaje que dice qué hacer. */
export class ErrorLimite extends ErrorConsulta {
  constructor(mensaje) {
    super(mensaje);
    this.status = 413;
  }
}

export const FORMATOS_EXPORTACION = ["xlsx", "pdf"];

/** ?formato=xlsx|pdf&columnas=fecha|codigo|… → { formato, columnas } con las columnas del catálogo en ese orden. */
export function leerExportacion(query = {}) {
  const formato = uno(query.formato);
  if (!FORMATOS_EXPORTACION.includes(formato)) throw new ErrorConsulta("formato debe ser xlsx o pdf");
  const pedidas = String(uno(query.columnas) ?? "").split("|").map((c) => c.trim()).filter(Boolean);
  if (new Set(pedidas).size !== pedidas.length) throw new ErrorConsulta("columnas tiene valores repetidos");
  if (pedidas.length > COLUMNAS.length) throw new ErrorConsulta("columnas tiene demasiados valores");
  const porCampo = new Map(COLUMNAS.map((c) => [c.campo, c]));
  const columnas = pedidas.length ? pedidas.map((c) => porCampo.get(c) ?? null) : COLUMNAS.filter((c) => !c.oculta);
  if (columnas.includes(null)) throw new ErrorConsulta("columnas tiene un nombre no válido");
  return { formato, columnas };
}

/** Solo lo que hace falta leer de MongoDB: las columnas pedidas y las dos que deciden los colores. */
export function proyeccionPara(columnas, conFormato) {
  const campos = new Set(columnas.map((c) => c.campo));
  if (conFormato) { campos.add("total"); campos.add("efectividad"); }
  return { _id: 0, ...Object.fromEntries([...campos].map((c) => [K(c), 1])) };
}
