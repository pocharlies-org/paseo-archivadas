import type { Historial, Sesion } from "./contract.ts";

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
  readonly persistence?: { readonly sessionId?: string | null; readonly nativeHandle?: string | null } | null;
  readonly runtimeInfo?: { readonly sessionId?: string | null } | null;
}

export interface Destino {
  readonly workspaceId: string;
  readonly cwd: string;
}

/** The provider session an agent runs: the key the daemon matches on when it imports. */
export function handleDe(agente: AgenteHistorial): string | null {
  return agente.persistence?.nativeHandle ?? agente.persistence?.sessionId ?? agente.runtimeInfo?.sessionId ?? null;
}

export const claveDe = (providerId: string, handle: string) => `${providerId}\u0000${handle}`;

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

function unico(...partes: readonly (string | null | undefined)[]): string {
  const vistas: string[] = [];
  for (const parte of partes) {
    const limpia = parte ? compacta(parte) : "";
    if (limpia && !vistas.includes(limpia)) vistas.push(limpia);
  }
  return vistas.join(" · ");
}

/** The row shows two lines of title: Paseo's title of a session with none is its whole first prompt, which can be kilobytes. */
const MAX_TITULO = 160;
function titulo(texto: string | null | undefined): string {
  const limpio = texto ? compacta(texto) : "";
  return limpio.length > MAX_TITULO ? `${limpio.slice(0, MAX_TITULO - 1).trimEnd()}…` : limpio;
}

/**
 * The importable sessions plus the archived agents of the destination workspace, one row per provider session.
 * - The archived record wins: its id is what the daemon brings back, and the row is marked.
 * - An archived record whose session is also running as a live agent is dropped: importing it fails («already imported»).
 * - With several archived records of one session, the most recently archived one stays (the daemon picks the same kind of match).
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
    const handle = handleDe(agente);
    if (handle && !agente.archivedAt) vivos.add(claveDe(agente.provider, handle));
  }
  const archivadas = new Map<string, AgenteHistorial>();
  const sinSesion: AgenteHistorial[] = [];
  for (const agente of agentes) {
    if (!esDelWorkspace(agente, destino, canon)) continue;
    const handle = handleDe(agente);
    if (!handle) {
      sinSesion.push(agente);
      continue;
    }
    const clave = claveDe(agente.provider, handle);
    if (vivos.has(clave)) continue;
    const previa = archivadas.get(clave);
    if (!previa || msDe(agente.archivedAt) > msDe(previa.archivedAt)) archivadas.set(clave, agente);
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
  for (const [clave, agente] of archivadas) {
    const handle = handleDe(agente) ?? "";
    const marca = { agentId: agente.id, archivadaEn: agente.archivedAt ?? "" };
    const fila = filas.get(clave);
    if (fila) {
      filas.set(clave, { ...fila, archivada: marca });
      continue;
    }
    filas.set(clave, {
      clave,
      providerId: agente.provider,
      providerLabel: agente.provider,
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
    const clave = `${agente.provider}\u0000agente:${agente.id}`;
    filas.set(clave, {
      clave,
      providerId: agente.provider,
      providerLabel: agente.provider,
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

/** A session can be brought back unless it is archived and its history is gone. */
export const restaurable = (sesion: Sesion): boolean => !(sesion.archivada && sesion.historial === "no");

const sinAcentos = (texto: string) => texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Every word typed has to appear in the title, the prompts or the provider; «archivada» finds the archived ones. */
export function buscar(sesiones: readonly Sesion[], texto: string): Sesion[] {
  const palabras = sinAcentos(texto).split(/\s+/).filter(Boolean);
  if (palabras.length === 0) return [...sesiones];
  return sesiones.filter((sesion) => {
    const pajar = sinAcentos(`${sesion.titulo} ${sesion.resumen} ${sesion.providerLabel}${sesion.archivada ? " archivada" : ""}`);
    return palabras.every((palabra) => pajar.includes(palabra));
  });
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
