# stock

Visor de la snapshot diaria de stock (una fila por código y por día, con la predicción calculada ese día). Es un router de Express que se monta en el gateway; no arranca servidor propio.

- Lee la colección `stock_snapshot` de la misma base del gateway (la carga el notebook de Colab, ver `herramientas/colab-cargar-stock.py`).
- Exige sesión, el permiso `stock:leer` y que la empresa activa sea `STOCK_EMPRESA_ID`. Sin esa variable responde 503 en todas las rutas.
- Filtros (código, detalle, fechas, grado, segmento, rotación, marca, estado, urgente), orden y paginación de 10 o 20 filas, todo en el servidor.

## Rutas (relativas al punto de montaje)

| Ruta | Qué hace |
|---|---|
| `GET /` | La página (HTML fijo; `/app.js` y `/estilo.css` son suyos) |
| `GET /api/filtros` | Valores de los selectores |
| `GET /api/datos` | `?codigo=&detalle=&desde=AAAA-MM-DD&hasta=&grado=&segmento=&rotacion=&estado=&marca=&urgente=si\|no&orden=&dir=asc\|desc&pagina=&tamano=10\|20` |

## Montarlo en el gateway

```bash
npm install github:Hector3008/stock
```

`src/services.js` del gateway:

```js
import prueba from "prueba";
import stock from "stock";

export const services = [
  { name: "prueba", path: "/prueba", factory: prueba },
  { name: "stock", path: "/stock", factory: stock },
];
```

El gateway ya llama a cada fábrica con `{ db, core }`. Variable de entorno: `STOCK_EMPRESA_ID` (el id de la empresa que puede ver los datos). El permiso `stock:leer` se asigna desde `cuenta` → Administración → Equipo; el administrador (`*`) ya lo tiene.

## Cargar los datos

`herramientas/colab-cargar-stock.py` es la última celda del notebook (`!pip -q install pymongo`). Usa el Secreto de Colab `MONGODB_URI`; repetirla actualiza sin duplicar (clave `codigo` + `fecha`).

## Pruebas

```bash
npm install
npm test
```

Con un núcleo y una colección falsos; no necesitan MongoDB.

## Exportar a Excel y PDF

Los botones «Excel» y «PDF» descargan la vista actual (filtros, orden y columnas visibles). Límites por variable de entorno (opcionales):

| Variable | Defecto | Efecto |
|---|---|---|
| `STOCK_EXPORT_MAX_XLSX` | 100000 | más filas → 413, hay que filtrar |
| `STOCK_EXPORT_MAX_PDF` | 2000 | ídem para PDF |
| `STOCK_EXPORT_FORMATO_XLSX` | 20000 | más filas → Excel sin formato condicional (más liviano) |

| `STOCK_EXPORT_GRAFICO_XLSX` | 5000 | más filas → Excel sin la columna de gráficos |

El PDF usa A4 apaisada o A3 según las columnas. La columna «Evolución del stock» se exporta como línea en el PDF y como minigráfico (sparkline) en el Excel.

Dependencias: `exceljs`, `pdfkit`, `jszip`.
