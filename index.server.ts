import type { PluginServerContext } from "@getpaseo/plugin/server";
import { archivadasList, archivadasRestore, transcriptsBuscar, transcriptsCheck } from "./shared/contract.ts";
import { historialCompartido, listaSesiones, restauraSesion } from "./server/archivadas.ts";
import { buscarEnTranscripts, discoBusquedaReal, LIMITES, LIMITES_COMPLETO } from "./server/busqueda.ts";
import { abreDaemonReal } from "./server/daemon.ts";
import { comprobarTranscripts, discoReal } from "./server/transcripts.ts";

// The bundle gets Node's `require` from the host at run time: the daemon's own client is resolved there, not bundled.
declare const require: (nombre: string) => unknown;

// The client lists a host one directory per call: the calls of one opening share one read of the agent history.
const HISTORIAL_MS = 30_000;

// Paseo refuses a contribution that returns no cleanup; every daemon connection is opened and closed inside its request.
export default function contribute(server: PluginServerContext) {
  const abre = abreDaemonReal((nombre) => require(nombre));
  const historial = historialCompartido(HISTORIAL_MS);
  server.handle(archivadasList, ({ workspaces }) => listaSesiones(abre, workspaces, undefined, historial.lee));
  server.handle(transcriptsCheck, async ({ sesiones }) => ({ resultados: await comprobarTranscripts(discoReal, sesiones) }));
  server.handle(transcriptsBuscar, async ({ query, sesiones, completo }) => ({
    resultados: await buscarEnTranscripts(discoBusquedaReal, query, sesiones, completo ? LIMITES_COMPLETO : LIMITES),
  }));
  server.handle(archivadasRestore, (entrada) => {
    historial.olvida();
    return restauraSesion(abre, entrada);
  });
  return () => {};
}
