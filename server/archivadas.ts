import { realpathSync } from "node:fs";
import type { Sesion } from "../shared/contract.ts";
import { type AgenteHistorial, fusionar, ordenar, type Reciente } from "../shared/sesiones.ts";
import type { AbreDaemon, Daemon } from "./daemon.ts";

/** The native «Importar sesión» sheet asks for up to 200 sessions per provider: this is the same question. */
const LIMITE_RECIENTES = 200;
const LIMITE_PAGINA = 200;
// A host with thousands of agents has no use for this list; the cap only keeps a misbehaving cursor from looping forever.
const MAX_PAGINAS = 50;

/** Resolves symlinks so `/tmp/x` and `/private/tmp/x` are one directory; a path that is gone stays as written. */
export function canonicaReal(ruta: string): string {
  try {
    return realpathSync.native(ruta);
  } catch {
    return ruta;
  }
}

async function todoElHistorial(daemon: Daemon): Promise<AgenteHistorial[]> {
  const agentes: AgenteHistorial[] = [];
  let cursor: string | undefined;
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina += 1) {
    const respuesta = await daemon.fetchAgentHistory({
      filter: { includeArchived: true },
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: LIMITE_PAGINA, ...(cursor ? { cursor } : {}) },
    });
    for (const { agent } of respuesta.entries) agentes.push(agent);
    if (!respuesta.pageInfo.hasMore || !respuesta.pageInfo.nextCursor) break;
    cursor = respuesta.pageInfo.nextCursor;
  }
  return agentes;
}

export interface ListaIn {
  readonly workspaceId: string;
  readonly cwd: string;
}

export interface ListaOut {
  readonly sesiones: Sesion[];
  /** Providers whose listing failed: the list is then partial, and says so. */
  readonly avisos: string[];
}

/**
 * The sessions the native sheet would show for each asked workspace, plus every archived agent of it (its id, or the same
 * directory), merged by provider session. One daemon connection for the whole call: the agent history is read once for all
 * workspaces (archived agents are matched to their destination by id or directory anyway), and the recent-session listing
 * once per distinct directory.
 */
export async function listaSesiones(
  abre: AbreDaemon,
  workspaces: readonly ListaIn[],
  canon: (ruta: string) => string = canonicaReal,
): Promise<ListaOut> {
  const daemon = await abre();
  try {
    const agentes = await todoElHistorial(daemon);
    const avisos: string[] = [];
    const sesiones: Sesion[] = [];
    // One read per distinct directory, shared by the workspaces that live in it.
    const recientesPorCwd = new Map<string, Reciente[]>();
    for (const { cwd } of workspaces) {
      if (recientesPorCwd.has(cwd)) continue;
      const recientes = await daemon.fetchRecentProviderSessions({ cwd, limit: LIMITE_RECIENTES });
      recientesPorCwd.set(cwd, recientes.entries);
      avisos.push(...(recientes.providerErrors ?? []).map((e) => `${e.provider}: ${e.message}`));
    }
    // The same directory under two workspaces lists the same sessions once per workspace: the row says which one it restores into.
    for (const entrada of workspaces) {
      sesiones.push(...fusionar({ recientes: recientesPorCwd.get(entrada.cwd) ?? [], agentes, destino: entrada, canon }));
    }
    return { sesiones: ordenar(sesiones), avisos: [...new Set(avisos)] };
  } finally {
    await daemon.close().catch(() => undefined);
  }
}

export interface RestauraIn {
  readonly providerId: string;
  readonly providerHandleId: string;
  readonly cwd: string;
  readonly workspaceId: string;
}

/**
 * Brings the session back into the workspace. The daemon does it atomically: an archived agent is unarchived into the
 * workspace (and archived again if its provider cannot resume it), a session never imported becomes a new agent.
 */
export async function restauraSesion(abre: AbreDaemon, entrada: RestauraIn): Promise<{ agentId: string }> {
  const daemon = await abre();
  try {
    const agente = await daemon.importAgent({
      providerId: entrada.providerId,
      providerHandleId: entrada.providerHandleId,
      cwd: entrada.cwd,
      workspaceId: entrada.workspaceId,
    });
    return { agentId: agente.id };
  } finally {
    await daemon.close().catch(() => undefined);
  }
}
