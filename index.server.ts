import type { PluginServerContext } from "@getpaseo/plugin/server";
import { archivadasList, archivadasRestore, transcriptsCheck } from "./shared/contract.ts";
import { listaSesiones, restauraSesion } from "./server/archivadas.ts";
import { abreDaemonReal } from "./server/daemon.ts";
import { comprobarTranscripts, discoReal } from "./server/transcripts.ts";

// The bundle gets Node's `require` from the host at run time: the daemon's own client is resolved there, not bundled.
declare const require: (nombre: string) => unknown;

// Paseo refuses a contribution that returns no cleanup; every daemon connection is opened and closed inside its request.
export default function contribute(server: PluginServerContext) {
  const abre = abreDaemonReal((nombre) => require(nombre));
  server.handle(archivadasList, (entrada) => listaSesiones(abre, entrada));
  server.handle(transcriptsCheck, async ({ sesiones }) => ({ resultados: await comprobarTranscripts(discoReal, sesiones) }));
  server.handle(archivadasRestore, (entrada) => restauraSesion(abre, entrada));
  return () => {};
}
