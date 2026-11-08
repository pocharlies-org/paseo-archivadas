/** `#rrggbb` or `#rgb` with an alpha, or null when the host's color is not a hex one (the caller then picks a flat fallback). */
export function conAlfa(color: string, alfa: number): string | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex) return null;
  const plano = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  const n = Number.parseInt(plano, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alfa})`;
}
