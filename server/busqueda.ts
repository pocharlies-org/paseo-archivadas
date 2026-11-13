import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { BusquedaOut, TranscriptIn } from "../shared/contract.ts";
import { palabrasDe, sinAcentos } from "../shared/sesiones.ts";
import { type DiscoTranscripts, discoReal, localizaTranscripts } from "./transcripts.ts";

/** What the search needs from the host on top of the lookup: kept apart so a test can run it against a fake disk. */
export interface DiscoBusqueda extends DiscoTranscripts {
  /** The size of a file in bytes, or null when it cannot be read. */
  tamano(ruta: string): Promise<number | null>;
  /**
   * The lines of the first `maxBytes` bytes of a file, read as a stream (never the whole file at once). A line longer than
   * `maxLinea` is skipped unread: in a Claude transcript that is a tool output or an inline image, never text someone typed.
   * With `sirve`, only the lines it accepts (looking at the raw bytes) are decoded and returned: most of a transcript is not
   * text anyone wrote, and decoding it is most of the cost.
   */
  lineas(ruta: string, maxBytes: number, maxLinea: number, sirve?: (linea: Buffer) => boolean): AsyncIterable<string>;
}

export interface Limites {
  /** Bytes read per transcript at most: past them the result is `parcial`. */
  readonly maxBytes: number;
  /** A single line longer than this is skipped (see `DiscoBusqueda.lineas`). */
  readonly maxLinea: number;
  /** Transcripts read at the same time. */
  readonly concurrencia: number;
  /** Wall time of one search: what is not read by then is `parcial`. */
  readonly presupuestoMs: number;
}

export const LIMITES: Limites = { maxBytes: 64 * 1024 * 1024, maxLinea: 16 * 1024 * 1024, concurrencia: 4, presupuestoMs: 8_000 };

/** Characters of context the fragment shows around the first hit, before the ellipses. */
const LARGO_FRAGMENTO = 120;
const ANTES_DEL_HIT = 40;

const NUEVA_LINEA = 0x0a;
const USUARIO = Buffer.from('"type":"user"');
const ASISTENTE = Buffer.from('"type":"assistant"');
const RESULTADO = Buffer.from('"type":"tool_result"');
const TEXTO = Buffer.from('"type":"text"');

/**
 * Whether a raw transcript line can hold message text, decided without decoding it. Claude Code writes each entry with
 * `JSON.stringify`, so these tokens are always spelled exactly like this, and inside a string their quotes would be escaped:
 * - only `user` and `assistant` entries carry messages;
 * - a user entry with a `tool_result` block and no `text` block anywhere only returns tool output (the bulk of a transcript).
 * It only prunes: `textosDe` still decides on the parsed entry.
 */
export function puedeTenerTexto(linea: Buffer): boolean {
  if (linea.includes(ASISTENTE)) return true;
  if (!linea.includes(USUARIO)) return false;
  return !linea.includes(RESULTADO) || linea.includes(TEXTO);
}

export const discoBusquedaReal: DiscoBusqueda = {
  ...discoReal,
  tamano: (ruta) => stat(ruta).then(
    (info) => info.size,
    () => null,
  ),
  async *lineas(ruta, maxBytes, maxLinea, sirve = () => true) {
    if (maxBytes <= 0) return;
    const flujo = createReadStream(ruta, { start: 0, end: maxBytes - 1, highWaterMark: 1024 * 1024 });
    // Lines are split on the byte «\n», which never occurs inside a UTF-8 sequence, so each line decodes on its own.
    let trozos: Buffer[] = [];
    let largo = 0;
    let descartando = false;
    try {
      for await (const bloque of flujo as AsyncIterable<Buffer>) {
        let desde = 0;
        for (let fin = bloque.indexOf(NUEVA_LINEA); fin !== -1; fin = bloque.indexOf(NUEVA_LINEA, desde)) {
          if (!descartando && largo + (fin - desde) <= maxLinea) {
            const cola = bloque.subarray(desde, fin);
            const linea = trozos.length === 0 ? cola : Buffer.concat([...trozos, cola]);
            if (sirve(linea)) yield linea.toString("utf8");
          }
          trozos = [];
          largo = 0;
          descartando = false;
          desde = fin + 1;
        }
        if (descartando || desde >= bloque.length) continue;
        largo += bloque.length - desde;
        if (largo > maxLinea) {
          descartando = true;
          trozos = [];
        } else {
          trozos.push(bloque.subarray(desde));
        }
      }
      if (!descartando && trozos.length > 0) {
        const linea = Buffer.concat(trozos);
        if (sirve(linea)) yield linea.toString("utf8");
      }
    } finally {
      flujo.destroy();
    }
  },
};

const esObjeto = (valor: unknown): valor is Record<string, unknown> => typeof valor === "object" && valor !== null && !Array.isArray(valor);

/**
 * The text of one transcript entry that a person wrote or read: a `user` or `assistant` message's string content, or the
 * `text` blocks of its content list. Tool calls and their results, thinking, images and the meta entries Claude Code injects
 * (`isMeta`) give nothing, so a user entry that only carries tool results is empty.
 */
export function textosDe(entrada: unknown): string[] {
  if (!esObjeto(entrada) || (entrada.type !== "user" && entrada.type !== "assistant") || entrada.isMeta === true) return [];
  const mensaje = entrada.message;
  if (!esObjeto(mensaje)) return [];
  const contenido = mensaje.content;
  if (typeof contenido === "string") return contenido ? [contenido] : [];
  if (!Array.isArray(contenido)) return [];
  const textos: string[] = [];
  for (const bloque of contenido) {
    if (esObjeto(bloque) && bloque.type === "text" && typeof bloque.text === "string" && bloque.text) textos.push(bloque.text);
  }
  return textos;
}

/**
 * About `LARGO_FRAGMENTO` characters of `texto` around the first occurrence of `palabra` (already normalised), on one line,
 * with «…» where it was cut. The hit is found in the normalised text and mapped back to the original one character at a time,
 * so the fragment shows the accents the message had.
 */
export function fragmentoDe(texto: string, palabra: string): string {
  let normalizado = "";
  const origen: number[] = [];
  let indice = 0;
  for (const caracter of texto) {
    const plano = sinAcentos(caracter);
    for (let n = 0; n < plano.length; n++) origen.push(indice);
    normalizado += plano;
    indice += caracter.length;
  }
  const hit = normalizado.indexOf(palabra);
  const inicioHit = hit === -1 ? 0 : (origen[hit] ?? 0);
  // Whole code points: a cut never splits a surrogate pair.
  const puntos = Array.from(texto);
  let puntoHit = 0;
  for (let unidades = 0; puntoHit < puntos.length && unidades < inicioHit; puntoHit++) unidades += (puntos[puntoHit] as string).length;
  const desde = Math.max(0, puntoHit - ANTES_DEL_HIT);
  const hasta = Math.min(puntos.length, desde + LARGO_FRAGMENTO);
  const cuerpo = puntos.slice(desde, hasta).join("").replace(/\s+/g, " ").trim();
  return `${desde > 0 ? "…" : ""}${cuerpo}${hasta < puntos.length ? "…" : ""}`;
}

interface Hallazgo {
  coincidencias: number;
  fragmento: string | null;
  parcial: boolean;
}

/**
 * Reads one transcript line by line and counts the messages where any word appears; the session matches only when every word
 * appears somewhere in it (as the list's own search does), else it counts zero. Malformed lines are skipped. Nothing read is
 * logged or kept but the fragment.
 */
async function buscaEnFichero(disco: DiscoBusqueda, ruta: string, palabras: readonly string[], limites: Limites, vence: number, ahora: () => number): Promise<Hallazgo> {
  const tamano = await disco.tamano(ruta);
  let parcial = tamano === null || tamano > limites.maxBytes;
  const vistas = new Set<string>();
  let coincidencias = 0;
  let fragmento: string | null = null;
  const primera = palabras[0] as string;
  // Most lines of a transcript are not messages, or only tool output: those are not even decoded.
  for await (const linea of disco.lineas(ruta, limites.maxBytes, limites.maxLinea, puedeTenerTexto)) {
    if (ahora() > vence) {
      parcial = true;
      break;
    }
    let entrada: unknown;
    try {
      entrada = JSON.parse(linea);
    } catch {
      continue;
    }
    let acierta = false;
    for (const texto of textosDe(entrada)) {
      const normalizado = sinAcentos(texto);
      for (const palabra of palabras) {
        if (!normalizado.includes(palabra)) continue;
        acierta = true;
        vistas.add(palabra);
        if (palabra === primera && fragmento === null) fragmento = fragmentoDe(texto, primera);
      }
    }
    if (acierta) coincidencias++;
  }
  if (vistas.size < palabras.length) return { coincidencias: 0, fragmento: null, parcial };
  return { coincidencias, fragmento, parcial };
}

/**
 * Searches the Claude transcripts of the sessions for the query: every word (case and accents ignored) has to appear in the
 * session. At most `concurrencia` files are read at once, each up to `maxBytes`, and the whole call stops at `presupuestoMs`;
 * a session cut short (or never reached) is `parcial`. Other providers are not `buscable`, nor a transcript that is gone.
 * One result per session, in the order asked.
 */
export async function buscarEnTranscripts(
  disco: DiscoBusqueda,
  consulta: string,
  sesiones: readonly TranscriptIn[],
  limites: Limites = LIMITES,
  ahora: () => number = Date.now,
): Promise<BusquedaOut[]> {
  const palabras = [...new Set(palabrasDe(consulta))];
  const vence = ahora() + limites.presupuestoMs;
  const localiza = localizaTranscripts(disco);
  const resultados: BusquedaOut[] = sesiones.map(({ provider, sessionId }) => ({
    provider,
    sessionId,
    buscable: provider === "claude",
    coincidencias: 0,
    fragmento: null,
    parcial: false,
  }));
  let siguiente = 0;
  const trabaja = async () => {
    for (let i = siguiente++; i < sesiones.length; i = siguiente++) {
      const resultado = resultados[i] as BusquedaOut;
      const { provider, sessionId, cwd } = sesiones[i] as TranscriptIn;
      if (provider !== "claude") continue;
      if (palabras.length === 0) continue;
      if (ahora() > vence) {
        resultado.parcial = true;
        continue;
      }
      try {
        const ruta = await localiza(sessionId, cwd);
        if (ruta === null) {
          resultado.buscable = false;
          continue;
        }
        Object.assign(resultado, await buscaEnFichero(disco, ruta, palabras, limites, vence, ahora));
      } catch {
        // A file that vanished or cannot be read mid-way: what was not read proves nothing. The error may quote the path, which
        // names the user's directories: it is not logged.
        resultado.parcial = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limites.concurrencia, sesiones.length)) }, trabaja));
  return resultados;
}
