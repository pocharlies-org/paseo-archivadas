import { readFileSync } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TranscriptIn, TranscriptOut } from "../shared/contract.ts";
import { carpetaPaseo } from "./daemon.ts";

/** What the lookup needs from the host: kept apart so a test can run it against a fake disk. */
export interface DiscoTranscripts {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  /** The contents of a file on this host, or null when it is not there: the Paseo config says where the Claude provider keeps its sessions. */
  lee?(ruta: string): string | null;
  existe(ruta: string): Promise<boolean>;
  lista(ruta: string): Promise<string[]>;
}

export const discoReal: DiscoTranscripts = {
  env: process.env,
  home: homedir(),
  lee: (ruta) => {
    try {
      return readFileSync(ruta, "utf8");
    } catch {
      return null;
    }
  },
  existe: (ruta) =>
    access(ruta).then(
      () => true,
      () => false,
    ),
  lista: (ruta) => readdir(ruta).catch(() => []),
};

const esObjeto = (valor: unknown): valor is Record<string, unknown> => typeof valor === "object" && valor !== null && !Array.isArray(valor);

/**
 * The `CLAUDE_CONFIG_DIR` the Paseo config sets for the Claude provider (`agents.providers.claude.env`), which is the
 * environment the daemon starts Claude with. The file also holds credentials: it is only read for that one value, a file that
 * is missing or does not parse says nothing, and neither its contents nor the error are ever logged.
 */
export function configDelProveedor(disco: Pick<DiscoTranscripts, "env" | "home" | "lee">): string | undefined {
  const texto = disco.lee?.(join(carpetaPaseo(disco), "config.json"));
  if (!texto) return undefined;
  try {
    const config: unknown = JSON.parse(texto);
    const agentes = esObjeto(config) ? config.agents : undefined;
    const proveedores = esObjeto(agentes) ? agentes.providers : undefined;
    const claude = esObjeto(proveedores) ? proveedores.claude : undefined;
    const entorno = esObjeto(claude) ? claude.env : undefined;
    const carpeta = esObjeto(entorno) ? entorno.CLAUDE_CONFIG_DIR : undefined;
    return typeof carpeta === "string" && carpeta.trim() ? carpeta.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where Claude Code keeps its sessions: the `CLAUDE_CONFIG_DIR` of the Claude provider's env in the Paseo config (what the
 * daemon starts it with), else the one of this process, else `~/.claude`.
 */
export function carpetaProyectos(disco: Pick<DiscoTranscripts, "env" | "home" | "lee">): string {
  const configurada = configDelProveedor(disco) ?? disco.env.CLAUDE_CONFIG_DIR?.trim();
  return join(configurada || join(disco.home, ".claude"), "projects");
}

/** Claude names a project's folder after its directory with every character that is not a letter or a digit as «-». */
export const codificaCwd = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, "-");

// A session id names a file: anything that could climb out of the projects folder is not a session of this provider.
const ID_VALIDO = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Whether the Claude transcript `<sessionId>.jsonl` is still on this host: first in the folder of its directory, then in
 * any project folder (the directory may have been renamed or reached through a symlink). Other providers keep their
 * history in places this plugin does not read, so they answer null: the caller treats null as restorable.
 */
export async function comprobarTranscripts(disco: DiscoTranscripts, sesiones: readonly TranscriptIn[]): Promise<TranscriptOut[]> {
  const proyectos = carpetaProyectos(disco);
  let carpetas: string[] | null = null;
  const resultados: TranscriptOut[] = [];
  for (const { provider, sessionId, cwd } of sesiones) {
    if (provider !== "claude") {
      resultados.push({ provider, sessionId, existe: null });
      continue;
    }
    if (!ID_VALIDO.test(sessionId)) {
      resultados.push({ provider, sessionId, existe: false });
      continue;
    }
    const fichero = `${sessionId}.jsonl`;
    let existe = await disco.existe(join(proyectos, codificaCwd(cwd), fichero));
    if (!existe) {
      carpetas ??= await disco.lista(proyectos);
      for (const carpeta of carpetas) {
        if (await disco.existe(join(proyectos, carpeta, fichero))) {
          existe = true;
          break;
        }
      }
    }
    resultados.push({ provider, sessionId, existe });
  }
  return resultados;
}
