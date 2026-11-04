# Última celda del notebook de Colab: sube `snap` (snapshot código×día) a MongoDB para el visor /stock del gateway (5.70).
# Antes, una vez por sesión, en otra celda:  %pip -q install pymongo
# La URI NO va en el notebook: en Colab → icono de llave (Secretos) → nombre MONGODB_URI, valor la cadena de Atlas, «Acceso desde el cuaderno» activado.
#
# Qué hace, en orden:
#   1. Calcula cuánto pesará lo que vas a subir y lo compara con el espacio libre del cluster. Si no cabe, NO sube nada y te dice
#      qué columnas pesan más (usa OMITIR para dejar fuera las que no necesites).
#   2. Con REEMPLAZAR = True borra la colección stock_snapshot y la vuelve a crear (es una copia derivada: siempre se puede regenerar desde snap).
#      Con REEMPLAZAR = False agrega o actualiza por (codigo, fecha), útil con SOLO_FECHAS_DESDE para subir solo lo reciente.
#   3. Sube por lotes. Los nombres de campo se guardan abreviados (CLAVES) porque cada documento los repite y el cluster gratuito
#      tiene 512 MB; la API y la pantalla siguen usando los nombres largos.
import math
import unicodedata
import numpy as np
import pandas as pd
import bson
from google.colab import userdata
from pymongo import MongoClient, ReplaceOne

DATOS = snap                       # el dataframe final (merge de df_cob con pred_dia)
BASE = "mi-servidor"               # = MONGODB_DB del gateway
COLECCION = "stock_snapshot"       # la lee el gateway; no la cambies sin cambiarla allá
REEMPLAZAR = True                  # True: borra y vuelve a crear la colección (necesario la primera vez con las claves abreviadas)
SOLO_FECHAS_DESDE = None           # por ejemplo "2026-09-01" (con REEMPLAZAR = False); None = todo
LIMITE_MB = 470                    # tope de uso total del cluster (512 MB menos un margen)
OMITIR = []                        # nombres largos que no quieres subir, p. ej. ["r10", "r50", "r80", "r90", "celda"]
FORZAR = False                     # True: sube aunque la estimación pase el límite (no recomendado)

# nombre en la API  →  clave guardada en MongoDB. Debe ser idéntico al catálogo del paquete stock (hay una prueba que lo verifica).
CLAVES = {
    "fecha": "f",
    "codigo": "c",
    "detalle": "d",
    "marca": "m",
    "total": "t",
    "segmento": "sg",
    "rotacion": "ro",
    "estado": "es",
    "grado": "gr",
    "modelo": "mo",
    "nivel_dia": "nd",
    "cobertura_dias": "cd",
    "urgente": "ur",
    "demanda_300d_pred": "dp",
    "rango_bajo": "rb",
    "rango_alto": "ra",
    "pedido_central": "pc",
    "pedido_prudente": "pp",
    "efectividad": "ef",
    "error_esperado": "ee",
    "fecha_agotamiento_est": "fa",
    "motivo": "mt",
    "recomendacion": "rc",
    "equivalente_stock": "eq",
    "codigos_equivalentes": "ce",
    "stock_lv": "sl",
    "stock_sjl": "ss",
    "ventas": "vt",
    "movimientos": "mv",
    "devolucion": "dv",
    "importacion": "im",
    "ajuste_lv": "al",
    "ajuste_sjl": "aj",
    "dias_historial": "dh",
    "consumo_demanda": "co",
    "n_sem": "ns",
    "n_obs": "no",
    "celda": "cl",
    "wape_celda": "wc",
    "wape_codigo": "wd",
    "wape_esperado": "we",
    "r10": "r1",
    "r50": "r5",
    "r80": "r8",
    "r90": "r9",
    "demanda_300_p50": "d5",
    "pedido_p50": "p5",
    "demanda_300_p80": "d8",
    "pedido_p80": "p8",
    "revisar": "rv",
    "codigo_n": "cn",
    "detalle_n": "dn",
}
# columna del dataframe → nombre en la API (las demás se llaman igual)
ORIGEN = {"MARCA": "marca", "EQUIVALENTE + STOCK": "equivalente_stock"}
FECHAS = {"fecha", "fecha_agotamiento_est"}
BOOLS = {"urgente", "revisar"}
TEXTOS = {"codigo", "detalle", "marca", "segmento", "rotacion", "estado", "grado", "modelo", "motivo", "recomendacion",
          "equivalente_stock", "codigos_equivalentes", "celda"}
SI = {"true", "1", "si", "sí", "yes", "y", "urgente", "revisar"}


def normalizar(t):
    t = unicodedata.normalize("NFD", str(t or "")).encode("ascii", "ignore").decode().lower().strip()
    return " ".join(t.split())


def vacio(v):
    if v is None or v is pd.NaT:
        return True
    if isinstance(v, (float, np.floating)):
        return not math.isfinite(v)
    return False


def limpio(v, campo):
    if isinstance(v, (list, tuple, set, np.ndarray)):
        v = ", ".join(map(str, v))
    if vacio(v):
        return None
    if campo in FECHAS:
        return pd.Timestamp(v).to_pydatetime().replace(hour=0, minute=0, second=0, microsecond=0)
    if campo in BOOLS:
        if isinstance(v, str):
            return v.strip().lower() in SI
        return bool(v)
    if campo in TEXTOS:
        v = str(v).strip()
        return v or None
    if isinstance(v, (bool, np.bool_)):
        return bool(v)
    if isinstance(v, (int, np.integer)):
        return int(v)
    v = float(v)
    # 375.0 se guarda como entero (4 bytes en vez de 8): ahorra bastante en 281 mil filas y en la pantalla se ve igual
    return int(v) if v.is_integer() and abs(v) < 2**31 else v


def documentos(df, omitir=()):
    df = df.rename(columns=ORIGEN)
    cols = [c for c in CLAVES if c in df.columns and c not in ("codigo_n", "detalle_n") and c not in omitir]
    faltan = [c for c in ("codigo", "fecha") if c not in cols]
    if faltan:
        raise ValueError(f"faltan columnas obligatorias: {faltan}")
    sin = [c for c in CLAVES if c not in df.columns and c not in ("codigo_n", "detalle_n")]
    if sin:
        print(f"Aviso: el dataframe no trae estas columnas y no se subirán: {sin}")
    for fila in df[cols].itertuples(index=False, name=None):
        d = {}
        for c, v in zip(cols, fila):
            x = limpio(v, c)
            if x is not None:
                d[CLAVES[c]] = x
        if "c" not in d or "f" not in d:
            continue
        d["cn"] = normalizar(d["c"])
        d["dn"] = normalizar(d.get("d"))
        yield d


def mb(b):
    return b / 1024 / 1024


d = DATOS if SOLO_FECHAS_DESDE is None else DATOS[DATOS["fecha"] >= pd.Timestamp(SOLO_FECHAS_DESDE)]
cliente = MongoClient(userdata.get("MONGODB_URI"), serverSelectionTimeoutMS=20000)
db = cliente[BASE]
col = db[COLECCION]

# ---- 1. estimación de espacio (muestra al azar: las primeras semanas no tienen predicción y pesan menos) ----
muestra = list(documentos(d.sample(min(3000, len(d)), random_state=1), OMITIR))
largo = {v: k for k, v in CLAVES.items()}
peso_col = {}
for doc in muestra:
    for k, v in doc.items():
        peso_col[k] = peso_col.get(k, 0) + len(bson.encode({k: v})) - 5
prom = sum(len(bson.encode(x)) for x in muestra) / len(muestra)
datos_mb = mb(prom * len(d))
indices_mb = mb(len(d) * 180)          # 8 índices, unos 180 bytes por fila en total
try:
    usado = sum(mb(cliente[n].command("dbStats").get("dataSize", 0) + cliente[n].command("dbStats").get("indexSize", 0))
                for n in cliente.list_database_names())
    try:
        cs = db.command("collStats", COLECCION)
        actual = mb(cs.get("size", 0) + cs.get("totalIndexSize", 0))
    except Exception:
        actual = 0.0
    otros = usado - (actual if REEMPLAZAR else 0)
except Exception as e:
    print(f"No se pudo medir el uso del cluster ({e}); se muestra solo la estimación.")
    otros = None

print(f"Filas a subir: {len(d):,}  ·  promedio por documento: {prom:,.0f} bytes")
print(f"Estimación de la colección: datos {datos_mb:,.0f} MB + índices {indices_mb:,.0f} MB")
if otros is not None:
    total = otros + datos_mb + indices_mb
    print(f"Resto del cluster (otras colecciones): {otros:,.0f} MB  →  uso total estimado: {total:,.0f} MB de {LIMITE_MB} MB permitidos")
    if total > LIMITE_MB and not FORZAR:
        print("\nNO cabe. Las columnas que más pesan (MB estimados en la colección):")
        for k, v in sorted(peso_col.items(), key=lambda kv: -kv[1])[:15]:
            print(f"  {largo.get(k, k):<22} {mb(v / len(muestra) * len(d)):6.1f} MB")
        raise SystemExit("Pon en OMITIR las columnas que no necesites (o sube LIMITE_MB / FORZAR bajo tu responsabilidad) y vuelve a ejecutar.")
for campo in ("urgente", "revisar"):
    if campo in d.columns:
        print(f"Valores de '{campo}' en tu dataframe (revisa que se interpreten bien):", d[campo].map(repr).value_counts().head(6).to_dict())

# ---- 2 y 3. subir ----
if REEMPLAZAR:
    col.drop()
col.create_index([("c", 1), ("f", 1)], unique=True)
lote, n = [], 0


def vaciar():
    global lote, n
    if not lote:
        return
    if REEMPLAZAR:
        col.insert_many(lote, ordered=False)
    else:
        col.bulk_write([ReplaceOne({"c": x["c"], "f": x["f"]}, x, upsert=True) for x in lote], ordered=False)
    n += len(lote)
    lote = []
    print(f"{n:,} filas…", end="\r")


for doc in documentos(d, OMITIR):
    lote.append(doc)
    if len(lote) == 2000:
        vaciar()
vaciar()
# Índices de las consultas del visor (mismos que crea el gateway al arrancar; se crean al final porque así salen más rápido).
col.create_index([("f", -1), ("c", 1)])
for clave in ("sg", "ro", "es", "gr", "m", "ur"):
    col.create_index([(clave, 1), ("f", -1)])
cs = db.command("collStats", COLECCION)
print(f"Listo: {n:,} filas subidas a {BASE}.{COLECCION}  (en la colección hay {col.estimated_document_count():,}; "
      f"datos {mb(cs.get('size', 0)):,.0f} MB + índices {mb(cs.get('totalIndexSize', 0)):,.0f} MB).")
