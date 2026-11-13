import type { BusquedaOut, Historial, Sesion, TranscriptIn } from "./contract.ts";

/** What the daemon's «Importar sesión» listing returns for a directory (the fields this plugin reads). */
export interface Reciente {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly providerHandleId: string;
  readonly cwd: string;
  readonly title: string | null;
  readonly firstPromptPreview: string | null;
  readonly lastPromptPreview: string | null;
  readonly lastActivityAt: string;
}

/** A Paseo agent as the agent history returns it (the fields this plugin reads). */
export interface AgenteHistorial {
  readonly id: string;
  readonly provider: string;
  readonly cwd: string;
  readonly workspaceId?: string | null;
  readonly title?: string | null;
  readonly archivedAt?: string | null;
  readonly updatedAt?: string | null;
  readonly lastUserMessageAt?: string | null;
  readonly persistence?: {
    readonly provider?: string | null;
    readonly sessionId?: string | null;
    readonly nativeHandle?: string | null;
  } | null;
  /**
   * What the live provider process reports. Deliberately not a handle: the daemon matches an import on `persistence` only, so
   * a session known just from here is not restorable (`importAgent` would create a new agent instead of bringing this one back).
   */
  readonly runtimeInfo?: { readonly sessionId?: string | null } | null;
}

export interface Destino {
  readonly workspaceId: string;
  readonly cwd: string;
}

/**
 * The handles of the provider session an agent runs, the native one first. The daemon matches an import against BOTH
 * `persistence.sessionId` and `persistence.nativeHandle` (it keeps the two keys of every agent it has), so either names the
 * agent. Only `persistence` counts: a handle that is just in `runtimeInfo` is not one the daemon can restore.
 */
export function handlesDe(agente: AgenteHistorial): string[] {
  const handles = [agente.persistence?.nativeHandle, agente.persistence?.sessionId].filter((h): h is string => typeof h === "string" && h !== "");
  return [...new Set(handles)];
}

/** The handle a row of this agent imports with: the native one, else the session id; null when it never had a provider session. */
export function handleDe(agente: AgenteHistorial): string | null {
  return handlesDe(agente)[0] ?? null;
}

/** The provider the daemon matches on: the one of the persisted session, which is the agent's own unless the record says otherwise. */
export const proveedorDe = (agente: AgenteHistorial): string => agente.persistence?.provider || agente.provider;

export const claveDe = (providerId: string, handle: string) => `${providerId}\u0000${handle}`;

/** Every key (provider plus handle) the daemon would match this agent on. */
export const clavesDe = (agente: AgenteHistorial): string[] => handlesDe(agente).map((handle) => claveDe(proveedorDe(agente), handle));

/** An archived agent belongs to the list of a workspace when it lived there or in the same directory (realpath-resolved). */
export function esDelWorkspace(agente: AgenteHistorial, destino: Destino, canon: (ruta: string) => string): boolean {
  if (!agente.archivedAt) return false;
  if (agente.workspaceId && agente.workspaceId === destino.workspaceId) return true;
  return canon(agente.cwd) === canon(destino.cwd);
}

const msDe = (iso: string | null | undefined): number => {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
};

/** Newest first; a row without a date goes last, and ties keep the key order so the list never jumps between reloads. */
export function ordenar(sesiones: readonly Sesion[]): Sesion[] {
  return [...sesiones].sort((a, b) => msDe(b.ultimaActividad) - msDe(a.ultimaActividad) || a.clave.localeCompare(b.clave));
}

const compacta = (texto: string): string => texto.replace(/\s+/g, " ").trim();

const ENTIDADES_XML: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
// `<paseo-system version="1" kind="agent-message" source-agent-id="…" …>`, the text, `</paseo-system>`: what Paseo's
// `formatAgentMessage` writes, attribute values and text escaped, and the legacy `<paseo-system>` of the schedules.
const APERTURA_PASEO = /^<paseo-system(?=[\s>])[^>]*>/;
const CIERRE_PASEO = "</paseo-system>";

/**
 * The text of a prompt an agent sent to another one: Paseo wraps it in a `<paseo-system …>` envelope, and a session whose first
 * prompt is such a message gets that envelope as its title. Anything else is returned as it came. The closing tag may be
 * missing (a preview is cut at a fixed length), and an envelope cut inside its own opening tag has no text to show: that is
 * the empty string, not the half tag. Linear in the text (no regex over it): a title can be kilobytes.
 */
export function desenvuelve(texto: string): string {
  const limpio = texto.trim();
  if (!/^<paseo-system(?=[\s>]|$)/.test(limpio)) return texto;
  const apertura = APERTURA_PASEO.exec(limpio);
  if (!apertura) return "";
  let interior = limpio.slice(apertura[0].length).trim();
  if (interior.endsWith(CIERRE_PASEO)) interior = interior.slice(0, -CIERRE_PASEO.length).trimEnd();
  return interior.replace(/&(amp|lt|gt|quot|apos);/g, (_, entidad: string) => ENTIDADES_XML[entidad] ?? "");
}

function unico(...partes: readonly (string | null | undefined)[]): string {
  const vistas: string[] = [];
  for (const parte of partes) {
    const limpia = parte ? compacta(desenvuelve(parte)) : "";
    if (limpia && !vistas.includes(limpia)) vistas.push(limpia);
  }
  return vistas.join(" · ");
}

/** The row shows two lines of title: Paseo's title of a session with none is its whole first prompt, which can be kilobytes. */
const MAX_TITULO = 160;
function titulo(texto: string | null | undefined): string {
  const limpio = texto ? compacta(desenvuelve(texto)) : "";
  return limpio.length > MAX_TITULO ? `${limpio.slice(0, MAX_TITULO - 1).trimEnd()}…` : limpio;
}

/**
 * The importable sessions plus the archived agents of the destination workspace, one row per provider session.
 * - An agent is known by every handle the daemon matches it on (its session id and its native handle, under the provider of
 *   its persisted session), so a record that carries one of them is the same session as a listing that carries the other.
 * - The archived record wins: its id is what the daemon brings back, and the row is marked.
 * - An archived record whose session is also running as a live agent is dropped: importing it fails («already imported»).
 * - With several archived records of one session, the most recently archived one stays (the daemon picks the same kind of match).
 * - An archived agent with no persisted session (even if its live process once reported one) cannot be restored: the import
 *   would start a new agent. It is a dead end from the start.
 * - Rows are born with `historial` set from what is known without touching disk: a session the daemon lists has its history,
 *   an archived agent that never had a provider session has none, and any other archived one is still to be checked.
 */
export function fusionar(input: {
  readonly recientes: readonly Reciente[];
  readonly agentes: readonly AgenteHistorial[];
  readonly destino: Destino;
  readonly canon: (ruta: string) => string;
}): Sesion[] {
  const { recientes, agentes, destino, canon } = input;
  const vivos = new Set<string>();
  for (const agente of agentes) {
    if (agente.archivedAt) continue;
    for (const clave of clavesDe(agente)) vivos.add(clave);
  }
  // One entry per archived session: `grupos` keeps its newest record and every key any of its records carries, `grupoDe` finds
  // the group from one of those keys.
  const grupos = new Map<string, { agente: AgenteHistorial; claves: Set<string> }>();
  const grupoDe = new Map<string, string>();
  const sinSesion: AgenteHistorial[] = [];
  for (const agente of agentes) {
    if (!esDelWorkspace(agente, destino, canon)) continue;
    const claves = clavesDe(agente);
    if (claves.length === 0) {
      sinSesion.push(agente);
      continue;
    }
    if (claves.some((clave) => vivos.has(clave))) continue;
    const nombre = claves.map((clave) => grupoDe.get(clave)).find((grupo) => grupo !== undefined) ?? (claves[0] as string);
    const grupo = grupos.get(nombre) ?? { agente, claves: new Set<string>() };
    if (msDe(agente.archivedAt) > msDe(grupo.agente.archivedAt)) grupo.agente = agente;
    for (const clave of claves) {
      grupo.claves.add(clave);
      grupoDe.set(clave, nombre);
    }
    grupos.set(nombre, grupo);
  }

  const filas = new Map<string, Sesion>();
  for (const reciente of recientes) {
    const clave = claveDe(reciente.providerId, reciente.providerHandleId);
    filas.set(clave, {
      clave,
      providerId: reciente.providerId,
      providerLabel: reciente.providerLabel,
      providerHandleId: reciente.providerHandleId,
      cwd: reciente.cwd,
      titulo: titulo(reciente.title) || titulo(reciente.firstPromptPreview) || "Sin título",
      resumen: unico(reciente.firstPromptPreview, reciente.lastPromptPreview),
      ultimoPrompt: unico(reciente.lastPromptPreview),
      ultimaActividad: reciente.lastActivityAt,
      archivada: null,
      historial: "si",
    });
  }
  for (const { agente, claves } of grupos.values()) {
    const marca = { agentId: agente.id, archivadaEn: agente.archivedAt ?? "" };
    const coincidentes = [...claves].filter((clave) => filas.has(clave));
    if (coincidentes.length > 0) {
      for (const clave of coincidentes) filas.set(clave, { ...(filas.get(clave) as Sesion), archivada: marca });
      continue;
    }
    const handle = handleDe(agente) ?? "";
    const proveedor = proveedorDe(agente);
    const clave = claveDe(proveedor, handle);
    filas.set(clave, {
      clave,
      providerId: proveedor,
      providerLabel: proveedor,
      providerHandleId: handle,
      cwd: agente.cwd,
      titulo: titulo(agente.title) || "Sin título",
      resumen: "",
      ultimoPrompt: "",
      ultimaActividad: ultimaActividadDe(agente),
      archivada: marca,
      // Nothing proves the transcript is still there: the client asks the daemon host for it.
      historial: "desconocido",
    });
  }
  // An agent archived before it ever had a provider session has nothing to resume: it is listed (it is archived and of this
  // workspace) but it is a dead end from the start, with no handle to look up.
  for (const agente of sinSesion) {
    const proveedor = proveedorDe(agente);
    const clave = `${proveedor}\u0000agente:${agente.id}`;
    filas.set(clave, {
      clave,
      providerId: proveedor,
      providerLabel: proveedor,
      providerHandleId: "",
      cwd: agente.cwd,
      titulo: titulo(agente.title) || "Sin título",
      resumen: "",
      ultimoPrompt: "",
      ultimaActividad: ultimaActividadDe(agente),
      archivada: { agentId: agente.id, archivadaEn: agente.archivedAt ?? "" },
      historial: "no",
    });
  }
  return ordenar([...filas.values()]);
}

const ultimaActividadDe = (agente: AgenteHistorial): string | null =>
  agente.lastUserMessageAt ?? agente.updatedAt ?? agente.archivedAt ?? null;

/** Applies the transcript lookups to the rows they answer (by provider and session). */
export function conHistorial(
  sesiones: readonly Sesion[],
  resultados: readonly { readonly provider: string; readonly sessionId: string; readonly existe: boolean | null }[],
): Sesion[] {
  const porClave = new Map(resultados.map((r) => [claveDe(r.provider, r.sessionId), r.existe]));
  return sesiones.map((sesion) => {
    const existe = porClave.get(sesion.clave);
    if (existe === undefined) return sesion;
    const historial: Historial = existe === null ? "desconocido" : existe ? "si" : "no";
    return { ...sesion, historial };
  });
}

/** The archived rows whose transcript is still to be checked: the rest already come from the daemon's own listing. */
export function porComprobar(sesiones: readonly Sesion[]): { provider: string; sessionId: string; cwd: string }[] {
  return sesiones
    .filter((s) => s.archivada && s.historial === "desconocido")
    .map((s) => ({ provider: s.providerId, sessionId: s.providerHandleId, cwd: s.cwd }));
}

/** The list cut into batches of at most `tamano`, in order: the transcript lookup takes a bounded number of sessions per call. */
export function enTandas<T>(lista: readonly T[], tamano: number): T[][] {
  const tandas: T[][] = [];
  for (let desde = 0; desde < lista.length; desde += tamano) tandas.push(lista.slice(desde, desde + tamano));
  return tandas;
}

/** A session can be brought back unless it is archived and its history is gone. */
export const restaurable = (sesion: Sesion): boolean => !(sesion.archivada && sesion.historial === "no");

/** Lowercase and without accents: what every search compares, here and in the transcripts on the server. */
export const sinAcentos = (texto: string) => texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** The words of a query, normalised: a search matches when every one of them appears. */
export const palabrasDe = (texto: string): string[] => sinAcentos(texto).split(/\s+/).filter(Boolean);

/** Every word typed has to appear in the title, the prompts or the provider; «archivada» finds the archived ones. */
export function buscar(sesiones: readonly Sesion[], texto: string): Sesion[] {
  const palabras = palabrasDe(texto);
  if (palabras.length === 0) return [...sesiones];
  return sesiones.filter((sesion) => {
    const pajar = sinAcentos(`${sesion.titulo} ${sesion.resumen} ${sesion.providerLabel}${sesion.archivada ? " archivada" : ""}`);
    return palabras.every((palabra) => pajar.includes(palabra));
  });
}

/** The rows a transcript search asks about: every one with a session handle whose history is not known to be gone. */
export function aBuscarEnTranscripts(sesiones: readonly Sesion[]): TranscriptIn[] {
  return sesiones
    .filter((s) => s.historial !== "no" && s.providerHandleId !== "")
    .map((s) => ({ provider: s.providerId, sessionId: s.providerHandleId, cwd: s.cwd }));
}

export interface Coincidencia {
  readonly coincidencias: number;
  readonly fragmento: string | null;
}

export interface ResultadoTranscripts {
  /** The rows with a hit, in the list's order. */
  readonly filas: readonly Sesion[];
  /** By row key: how many messages matched and the context of the first hit. */
  readonly coincidencias: ReadonlyMap<string, Coincidencia>;
  /** Rows of providers whose transcripts this plugin cannot read: hidden, and counted for the note. */
  readonly noBuscables: number;
  /** Some transcript was not read to the end: a row missing from the list may still match. */
  readonly parcial: boolean;
}

/** Applies a transcript search's answers to the rows (by provider and session). */
export function conTranscripts(sesiones: readonly Sesion[], resultados: readonly BusquedaOut[]): ResultadoTranscripts {
  const porClave = new Map(resultados.map((r) => [claveDe(r.provider, r.sessionId), r]));
  const filas: Sesion[] = [];
  const coincidencias = new Map<string, Coincidencia>();
  let noBuscables = 0;
  for (const sesion of sesiones) {
    const resultado = porClave.get(sesion.clave);
    if (!resultado) continue;
    if (!resultado.buscable) {
      if (resultado.provider !== "claude") noBuscables++;
      continue;
    }
    if (resultado.coincidencias <= 0) continue;
    filas.push(sesion);
    coincidencias.set(sesion.clave, { coincidencias: resultado.coincidencias, fragmento: resultado.fragmento });
  }
  return { filas, coincidencias, noBuscables, parcial: resultados.some((r) => r.parcial) };
}

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"] as const;

/** «6 nov», or «6 nov 2025» when it is not this year. Local time, like the rest of Paseo. */
export function fechaCorta(iso: string, ahora: Date = new Date()): string {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return "";
  const dia = `${fecha.getDate()} ${MESES[fecha.getMonth()]}`;
  return fecha.getFullYear() === ahora.getFullYear() ? dia : `${dia} ${fecha.getFullYear()}`;
}

/** «hace 5 min», «hace 2 h», «hace 3 d», and the date past a month. */
export function hace(iso: string | null, ahora: Date = new Date()): string {
  if (!iso) return "";
  const ms = ahora.getTime() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const minutos = Math.floor(ms / 60_000);
  if (minutos < 1) return "ahora";
  if (minutos < 60) return `hace ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `hace ${horas} h`;
  const dias = Math.floor(horas / 24);
  if (dias < 31) return `hace ${dias} d`;
  return fechaCorta(iso, ahora);
}

/** The line above an archived row's title: «Archivada · 6 nov», plus «· sin historial» when it cannot come back. */
export function etiquetaArchivada(sesion: Sesion, ahora: Date = new Date()): string | null {
  if (!sesion.archivada) return null;
  const fecha = fechaCorta(sesion.archivada.archivadaEn, ahora);
  return ["Archivada", fecha, sesion.historial === "no" ? "sin historial" : ""].filter(Boolean).join(" · ");
}

/**
 * The line under a row's title: the last prompt of the session, unless it says nothing the title does not. Skipped when one
 * starts the same as the other (a title is the first prompt cut short), and when it is not something the user wrote (the
 * tags Claude Code injects, the summary it writes when a conversation continues in a new session).
 */
export function subtituloDe(sesion: Sesion): string {
  const ultimo = compacta(sesion.ultimoPrompt);
  if (!ultimo || ultimo.startsWith("<") || ultimo.startsWith("This session is being continued")) return "";
  const cabeza = (texto: string) => texto.replace(/…$/, "").trimEnd();
  const principio = cabeza(compacta(sesion.titulo));
  if (!principio) return ultimo;
  return ultimo.startsWith(principio) || principio.startsWith(cabeza(ultimo)) ? "" : ultimo;
}
