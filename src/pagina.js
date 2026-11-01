// Página del visor: HTML fijo, sin datos. La seguridad está en la API (sesión + permiso); esto solo es la cáscara.
import { COLUMNAS, CAMPOS_FILTRO_LISTA } from "./consulta.js";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ETIQUETA = { grado: "Grado", segmento: "Segmento", rotacion: "Rotación", estado: "Estado", marca: "Marca" };

export function paginaStock({ base, login }) {
  const selects = CAMPOS_FILTRO_LISTA.map(
    (c) => `<label>${ETIQUETA[c]}<select name="${c}" data-lista="${c}" multiple size="4"></select></label>`,
  ).join("\n");
  const cabecera = COLUMNAS.map((c) => `<th data-campo="${c.campo}" data-col="${c.campo}" data-tipo="${c.tipo}" data-grupo="${c.grupo}"${c.oculta ? ' data-oculta="1"' : ""} scope="col"><button type="button">${esc(c.titulo)}</button></th>`).join("");
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Stock · predicción diaria</title>
<link rel="stylesheet" href="${esc(base)}/estilo.css">
</head>
<body data-api="${esc(base)}/api" data-cuenta="${esc(login)}">
<header>
  <div><h1>Stock · predicción diaria</h1><p id="resumen" aria-live="polite"></p></div>
  <div class="columnas">
    <button type="button" id="btn-col" aria-expanded="false" aria-controls="panel-col">Columnas ▾</button>
    <div id="panel-col" role="group" aria-label="Columnas visibles" hidden>
      <p class="ayuda">Marca para mostrar u ocultar. Arrastra una fila (o una columna de la tabla) o usa ▲ ▼ para cambiar el orden.</p>
      <div id="lista-col"></div>
      <div class="acciones"><button type="button" id="col-todas">Mostrar todas</button><button type="button" id="col-basicas">Solo básicas</button><button type="button" id="col-orden">Orden original</button></div>
    </div>
  </div>
</header>
<main>
<form id="filtros" autocomplete="off">
  <label>Código<input type="search" name="codigo" maxlength="60" placeholder="ZM…"></label>
  <label>Detalle<input type="search" name="detalle" maxlength="120" placeholder="palabras del detalle"></label>
  <label>Desde<input type="date" name="desde"></label>
  <label>Hasta<input type="date" name="hasta"></label>
  ${selects}
  <label>Urgente<select name="urgente"><option value="">Todos</option><option value="si">Sí</option><option value="no">No</option></select></label>
  <label>Filas<select name="tamano"><option>10</option><option>20</option></select></label>
  <div class="acciones"><button type="submit">Filtrar</button><button type="reset" id="limpiar">Limpiar</button></div>
</form>
<div id="aviso" role="status"></div>
<p id="leyenda"><span class="muestra agotado"></span> Agotado (stock 0) <span class="sep"></span> <span class="muestra pedido"></span> Pedido sugerido: más intenso = mayor efectividad <span class="rampa"></span></p>
<div class="tabla"><table><thead><tr>${cabecera}<th scope="col" class="spark" data-col="spark">Evolución del stock</th></tr></thead><tbody id="filas"></tbody></table></div>
<nav id="paginacion" aria-label="Paginación"><button type="button" id="ant">‹ Anterior</button><span id="pos"></span><button type="button" id="sig">Siguiente ›</button></nav>
</main>
<script type="module" src="${esc(base)}/app.js"></script>
</body>
</html>`;
}
