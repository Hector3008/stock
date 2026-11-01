// Catálogo único de columnas del visor. Lo usan la API, la página y (por prueba) la celda de Colab.
//   campo   nombre en la API y en la pantalla
//   corto   nombre guardado en MongoDB: cada documento repite sus nombres de campo, y con 281 mil filas los nombres largos
//           pesan más que muchos de los valores (el cluster gratuito tiene 512 MB). Solo el cargador y este módulo lo conocen.
//   grupo   base | equivalentes | stock | calculo (agrupa las columnas en el panel)
//   oculta  true = empieza oculta (las columnas nuevas no cambian la pantalla de quien ya la usa)
const c = (campo, corto, titulo, tipo, grupo = "base", oculta = false) => ({ campo, corto, titulo, tipo, grupo, oculta });

export const COLUMNAS = [
  c("fecha", "f", "Fecha", "fecha"),
  c("codigo", "c", "Código", "texto"),
  c("detalle", "d", "Detalle", "texto"),
  c("marca", "m", "Marca", "texto"),
  c("total", "t", "Stock", "numero"),
  c("segmento", "sg", "Segmento", "texto"),
  c("rotacion", "ro", "Rotación", "texto"),
  c("estado", "es", "Estado", "texto"),
  c("grado", "gr", "Grado", "texto"),
  c("modelo", "mo", "Modelo", "texto"),
  c("nivel_dia", "nd", "Nivel/día", "numero"),
  c("cobertura_dias", "cd", "Cobertura (días)", "numero"),
  c("urgente", "ur", "Urgente", "bool"),
  c("demanda_300d_pred", "dp", "Demanda 300 d", "numero"),
  c("rango_bajo", "rb", "Rango bajo", "numero"),
  c("rango_alto", "ra", "Rango alto", "numero"),
  c("pedido_central", "pc", "Pedido central", "numero"),
  c("pedido_prudente", "pp", "Pedido prudente", "numero"),
  c("efectividad", "ef", "Efectividad", "numero"),
  c("error_esperado", "ee", "Error esperado", "numero"),
  c("fecha_agotamiento_est", "fa", "Agotamiento est.", "fecha"),
  c("motivo", "mt", "Motivo", "texto"),
  c("recomendacion", "rc", "Recomendación", "texto"),
  // Equivalentes
  c("equivalente_stock", "eq", "Equivalente + stock", "texto", "equivalentes", true),
  c("codigos_equivalentes", "ce", "Códigos equivalentes", "texto", "equivalentes", true),
  // Stock y movimientos
  c("stock_lv", "sl", "Stock LV", "numero", "stock", true),
  c("stock_sjl", "ss", "Stock SJL", "numero", "stock", true),
  c("ventas", "vt", "Ventas", "numero", "stock", true),
  c("movimientos", "mv", "Movimientos", "numero", "stock", true),
  c("devolucion", "dv", "Devolución", "numero", "stock", true),
  c("importacion", "im", "Importación", "numero", "stock", true),
  c("ajuste_lv", "al", "Ajuste LV", "numero", "stock", true),
  c("ajuste_sjl", "aj", "Ajuste SJL", "numero", "stock", true),
  // Detalle del cálculo
  c("dias_historial", "dh", "Días de historial", "numero", "calculo", true),
  c("consumo_demanda", "co", "Consumo demanda", "numero", "calculo", true),
  c("n_sem", "ns", "Semanas", "numero", "calculo", true),
  c("n_obs", "no", "Observaciones", "numero", "calculo", true),
  c("celda", "cl", "Celda", "texto", "calculo", true),
  c("wape_celda", "wc", "WAPE celda", "numero", "calculo", true),
  c("wape_codigo", "wd", "WAPE código", "numero", "calculo", true),
  c("wape_esperado", "we", "WAPE esperado", "numero", "calculo", true),
  c("r10", "r1", "R10", "numero", "calculo", true),
  c("r50", "r5", "R50", "numero", "calculo", true),
  c("r80", "r8", "R80", "numero", "calculo", true),
  c("r90", "r9", "R90", "numero", "calculo", true),
  c("demanda_300_p50", "d5", "Demanda 300 p50", "numero", "calculo", true),
  c("pedido_p50", "p5", "Pedido p50", "numero", "calculo", true),
  c("demanda_300_p80", "d8", "Demanda 300 p80", "numero", "calculo", true),
  c("pedido_p80", "p8", "Pedido p80", "numero", "calculo", true),
  c("revisar", "rv", "Revisar", "bool", "calculo", true),
];

// Campos internos de búsqueda (minúsculas y sin tildes), que no se muestran.
export const INTERNOS = { codigo_n: "cn", detalle_n: "dn" };

export const CORTO = Object.fromEntries([...COLUMNAS.map((x) => [x.campo, x.corto]), ...Object.entries(INTERNOS)]);

/** Nombre guardado en MongoDB de un campo de la API. */
export const K = (campo) => {
  const k = CORTO[campo];
  if (!k) throw new Error(`campo desconocido: ${campo}`);
  return k;
};
