# Última celda del notebook de Colab: sube `snap` (snapshot código×día) a MongoDB para el visor /stock del gateway (5.70).
# Antes, una vez:  !pip -q install pymongo
# La URI NO va en el notebook: en Colab → icono de llave (Secretos) → nombre MONGODB_URI, valor la cadena de Atlas, «Acceso desde el cuaderno» activado.
# Idempotente: cada fila se guarda por (codigo, fecha) con upsert; repetir la celda actualiza, no duplica.
import math
import unicodedata
import numpy as np
import pandas as pd
from google.colab import userdata
from pymongo import MongoClient, ReplaceOne

DATOS = snap                       # el dataframe final (merge de df_cob con pred_dia)
BASE = "mi-servidor"               # = MONGODB_DB del gateway
COLECCION = "stock_snapshot"       # la lee el gateway; no la cambies sin cambiarla allá
SOLO_FECHAS_DESDE = None           # por ejemplo "2026-09-01" para subir solo lo reciente; None = todo

COLUMNAS = ["fecha", "codigo", "detalle", "MARCA", "total", "segmento", "rotacion", "estado", "grado", "modelo",
            "nivel_dia", "cobertura_dias", "urgente", "demanda_300d_pred", "rango_bajo", "rango_alto",
            "pedido_central", "pedido_prudente", "efectividad", "error_esperado", "fecha_agotamiento_est",
            "motivo", "recomendacion"]
FECHAS = {"fecha", "fecha_agotamiento_est"}
TEXTOS = {"codigo", "detalle", "marca", "segmento", "rotacion", "estado", "grado", "modelo", "motivo", "recomendacion"}

def normalizar(t):
    t = unicodedata.normalize("NFD", str(t or "")).encode("ascii", "ignore").decode().lower().strip()
    return " ".join(t.split())

def limpio(v, campo):
    if v is None or (isinstance(v, float) and math.isnan(v)) or v is pd.NaT:
        return None
    if campo in FECHAS:
        return pd.Timestamp(v).to_pydatetime().replace(hour=0, minute=0, second=0, microsecond=0)
    if campo == "urgente":
        return bool(v)
    if campo in TEXTOS:
        if isinstance(v, (list, tuple, set, np.ndarray)):
            v = ", ".join(map(str, v))
        v = str(v).strip()
        return v or None
    if isinstance(v, (np.integer,)): return int(v)
    if isinstance(v, (np.floating, float)): return None if not math.isfinite(v) else float(v)
    if isinstance(v, (np.bool_,)): return bool(v)
    return v

def documentos(df):
    df = df.rename(columns={"MARCA": "marca"})
    cols = [c for c in (x.lower() if x == "MARCA" else x for x in COLUMNAS) if c in df.columns]
    faltan = [c for c in ("codigo", "fecha") if c not in cols]
    if faltan: raise ValueError(f"faltan columnas obligatorias: {faltan}")
    for fila in df[cols].itertuples(index=False, name=None):
        d = {c: limpio(v, c) for c, v in zip(cols, fila)}
        if not d["codigo"] or d["fecha"] is None:
            continue
        d["codigo_n"] = normalizar(d["codigo"])
        d["detalle_n"] = normalizar(d.get("detalle"))
        yield d

d = DATOS if SOLO_FECHAS_DESDE is None else DATOS[DATOS["fecha"] >= pd.Timestamp(SOLO_FECHAS_DESDE)]
cliente = MongoClient(userdata.get("MONGODB_URI"), serverSelectionTimeoutMS=20000)
col = cliente[BASE][COLECCION]
col.create_index([("codigo", 1), ("fecha", 1)], unique=True)   # el gateway crea el resto al arrancar

lote, n = [], 0
for doc in documentos(d):
    lote.append(ReplaceOne({"codigo": doc["codigo"], "fecha": doc["fecha"]}, doc, upsert=True))
    if len(lote) == 2000:
        col.bulk_write(lote, ordered=False); n += len(lote); lote = []
        print(f"{n:,} filas…", end="\r")
if lote:
    col.bulk_write(lote, ordered=False); n += len(lote)
print(f"Listo: {n:,} filas subidas a {BASE}.{COLECCION}  (en la colección hay {col.estimated_document_count():,}).")
