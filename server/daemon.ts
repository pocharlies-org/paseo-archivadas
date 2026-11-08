import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgenteHistorial, Reciente } from "../shared/sesiones.ts";

/**
 * The three daemon calls this plugin needs. Paseo's plugin API (`PaseoApi`) has none of them: the listing of importable
 * sessions, the agent history with archived agents and the import are only on the daemon's own client, so the plugin
 * opens a short connection of its own, like the `paseo` CLI does (`paseo import` is the same `importAgent` call).
 *
 * The shape is declared here, not imported from `@getpaseo/client`: Paseo compiles a plugin from a bare git checkout, with
 * no `node_modules`, and refuses one whose imports (types included) it cannot resolve. `test/conformidad.test.ts` checks at
 * typecheck time that the daemon's own client still fits it.
 */
export interface Daemon {
  fetchRecentProviderSessions(options: { cwd?: string; limit?: number }): Promise<{
    entries: Reciente[];
    providerErrors?: { provider: string; message: string }[];
  }>;
  fetchAgentHistory(options: {
    filter?: { includeArchived?: boolean; projectKeys?: string[] };
    sort?: { key: "status_priority" | "created_at" | "updated_at" | "title"; direction: "asc" | "desc" }[];
    page?: { limit: number; cursor?: string };
  }): Promise<{
    entries: { agent: AgenteHistorial }[];
    pageInfo: { hasMore: boolean; nextCursor: string | null };
  }>;
  importAgent(input: { providerId: string; providerHandleId: string; cwd?: string; workspaceId?: string }): Promise<{ id: string }>;
  close(): Promise<void>;
}
export type AbreDaemon = () => Promise<Daemon>;

/** What the daemon's client takes to connect (the fields this plugin sets). */
export interface ConfigCliente {
  url: string;
  clientId: string;
  clientType: "cli";
  password?: string;
  localCredential?: () => string | undefined;
  connectTimeoutMs?: number;
  reconnect?: { enabled: boolean };
}
export type ConexionDaemon = Daemon & { connect(): Promise<void> };
export type ClaseCliente = new (config: ConfigCliente) => ConexionDaemon;

export interface EntornoDaemon {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  /** The contents of a file under the Paseo home, or null when it is not there. */
  lee(ruta: string): string | null;
}

export const entornoReal: EntornoDaemon = {
  env: process.env,
  home: homedir(),
  lee: (ruta) => {
    try {
      return readFileSync(ruta, "utf8");
    } catch {
      return null;
    }
  },
};

export function carpetaPaseo(entorno: Pick<EntornoDaemon, "env" | "home">): string {
  const cruda = entorno.env.PASEO_HOME?.trim() || "~/.paseo";
  const expandida = cruda === "~" ? entorno.home : cruda.startsWith("~/") ? join(entorno.home, cruda.slice(2)) : cruda;
  return resolve(expandida);
}

/** `0.0.0.0:6767`, `127.0.0.1:6767`, `localhost:6767` or `[::]:6767` → the loopback websocket of that port. */
export function urlDelDaemon(listen: string): string {
  const puerto = /^(?:\[[^\]]*\]|[^:\s]+):(\d{1,5})$/.exec(listen.trim())?.[1];
  if (!puerto) throw new Error(`El daemon escucha en «${listen}»: este plugin solo sabe conectar por TCP local`);
  return `ws://127.0.0.1:${puerto}/ws`;
}

/** Where the local daemon listens: the env the daemon itself was started with, else the lock file it writes. */
export function escuchaDelDaemon(entorno: EntornoDaemon): string {
  const delEntorno = entorno.env.PASEO_LISTEN?.trim();
  if (delEntorno) return delEntorno;
  const lock = entorno.lee(join(carpetaPaseo(entorno), "paseo.pid"));
  try {
    const listen = lock ? (JSON.parse(lock) as { listen?: unknown }).listen : null;
    if (typeof listen === "string" && listen) return listen;
  } catch {
    // A lock file that does not parse says the same as a missing one.
  }
  throw new Error("No encuentro el daemon de Paseo: ni PASEO_LISTEN ni paseo.pid dicen dónde escucha");
}

// A host module the daemon already ships and the plugin process can resolve: the daemon's own client, so it always speaks
// the protocol of the daemon it runs in. The name is not a literal on purpose: the plugin compiler would try to bundle it.
const MODULO_CLIENTE = "@getpaseo/client/internal/daemon-client";

type Cargador = (nombre: string) => unknown;

function cargaCliente(carga: Cargador): ClaseCliente {
  let modulo: { DaemonClient?: unknown };
  try {
    modulo = carga(MODULO_CLIENTE) as { DaemonClient?: unknown };
  } catch (error) {
    throw new Error(`Este Paseo no deja cargar el cliente del daemon desde un plugin: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof modulo.DaemonClient !== "function") throw new Error("El cliente del daemon de este Paseo no tiene la forma esperada");
  return modulo.DaemonClient as ClaseCliente;
}

/**
 * A connected client, one per request: it is closed right after, so the plugin never shows up as a standing client of the
 * daemon. Authenticates like the CLI: the daemon password when the environment has it, else the local credential file.
 */
export function abreDaemonReal(carga: Cargador, entorno: EntornoDaemon = entornoReal): AbreDaemon {
  return async () => {
    const Cliente = cargaCliente(carga);
    const home = carpetaPaseo(entorno);
    const password = entorno.env.PASEO_PASSWORD;
    const cliente = new Cliente({
      url: urlDelDaemon(escuchaDelDaemon(entorno)),
      clientId: `paseo-archivadas-${randomUUID()}`,
      clientType: "cli",
      ...(password ? { password } : {}),
      localCredential: () => entorno.lee(join(home, "local-credential"))?.trim() || undefined,
      connectTimeoutMs: 10_000,
      reconnect: { enabled: false },
    });
    try {
      await cliente.connect();
    } catch (error) {
      await cliente.close().catch(() => undefined);
      throw error;
    }
    return cliente;
  };
}
