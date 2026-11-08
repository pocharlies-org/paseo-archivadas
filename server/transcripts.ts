import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TranscriptIn, TranscriptOut } from "../shared/contract.ts";

/** What the lookup needs from the host: kept apart so a test can run it against a fake disk. */
export interface DiscoTranscripts {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  existe(ruta: string): Promise<boolean>;
  lista(ruta: string): Promise<string[]>;
}

export const discoReal: DiscoTranscripts = {
  env: process.env,
  home: homedir(),
  existe: (ruta) =>
    access(ruta).then(
      () => true,
      () => false,
    ),
  lista: (ruta) => readdir(ruta).catch(() => []),
};

/** Where Claude Code keeps its sessions: `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. */
export function carpetaProyectos(disco: Pick<DiscoTranscripts, "env" | "home">): string {
  const configurada = disco.env.CLAUDE_CONFIG_DIR?.trim();
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
