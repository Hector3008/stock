// Reglas del formato condicional para las exportaciones (las mismas de la pantalla; ver «Formato condicional» en arquitectura.md).
//   Agotado: stock <= 0 → casilla de Stock en rojo claro.
//   Pedido sugerido: pedido central o prudente > 0 → casilla en amarillo; cuanto mayor la efectividad (0 a 1), más intenso.
export const MIN_INTENSIDAD = 0.15;
export const ROJO = "F6C4BF";
const AMARILLO = [0xf2, 0xc2, 0x00];

export const intensidad = (efectividad) =>
  typeof efectividad === "number" && Number.isFinite(efectividad) ? MIN_INTENSIDAD + (1 - MIN_INTENSIDAD) * Math.min(1, Math.max(0, efectividad)) : 0.08;

export const esAgotado = (fila) => typeof fila.total === "number" && fila.total <= 0;
export const pideCampo = (campo, fila) => (campo === "pedido_central" || campo === "pedido_prudente") && typeof fila[campo] === "number" && fila[campo] > 0;

/** Excel guarda cada color distinto como un estilo más: se agrupa la intensidad en 8 niveles para que el archivo no crezca. */
export const nivelIntensidad = (k) => Math.max(1, Math.round(k * 8)) / 8;

/** Amarillo mezclado con blanco según la intensidad (como se ve en la pantalla con tema claro), en hexadecimal sin «#». */
export function amarilloHex(k) {
  return AMARILLO.map((c) => Math.round(255 - (255 - c) * k).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** Color de relleno de una casilla (hex sin «#») o null. `nivelado` agrupa la intensidad (Excel). */
export function colorCasilla(campo, fila, nivelado = false) {
  if (campo === "total" && esAgotado(fila)) return ROJO;
  if (pideCampo(campo, fila)) {
    const k = intensidad(fila.efectividad);
    return amarilloHex(nivelado ? nivelIntensidad(k) : k);
  }
  return null;
}
