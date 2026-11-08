import type { PluginClientContext } from "@getpaseo/plugin/client";

/** What the list needs of a workspace: where its sessions live and which project its agents belong to. */
export interface DatosWorkspace {
  readonly cwd: string;
  readonly projectKey: string | null;
}

/** The part of a workspace descriptor the list needs. */
export interface Descriptor {
  readonly id: string;
  readonly projectId: string;
  readonly projectRootPath: string;
  readonly workspaceDirectory?: string;
  readonly archivingAt?: string | null;
}
export const destinoDe = (w: Descriptor): DatosWorkspace => ({ cwd: w.workspaceDirectory ?? w.projectRootPath, projectKey: w.projectId || null });

type Paginacion = { readonly hasMore: boolean; readonly nextCursor: string | null };
type Operacion = (mapa: Map<string, DatosWorkspace>) => void;

const TAMANO_PAGINA = 200;

/**
 * Keeps `datos` equal to the workspaces the host lists (directory and project key), and calls `cambio` when it changes.
 *
 * The subscription's snapshot is only the first page: a host with more workspaces than one page holds has to read the rest.
 * Whenever a snapshot arrives (the first one, and again after a reconnect) the whole new list is built off to the side from
 * every page and swapped into `datos` in one go, with one `cambio` call: the caller adds and removes one button per workspace
 * on each `cambio`, so clearing `datos` for the first page would drop the buttons of every later page and draw them again.
 * A change the host sends while the pages are still being read is newer than they are: it is applied to `datos` at once and
 * replayed on top of the new list, and a snapshot that a newer one has overtaken is dropped.
 */
export function vigilaWorkspaces(
  client: Pick<PluginClientContext, "paseo">,
  signal: AbortSignal,
  datos: Map<string, DatosWorkspace>,
  cambio: () => void,
): () => void {
  const anotaEn = (mapa: Map<string, DatosWorkspace>, w: Descriptor) => {
    if (w.archivingAt) mapa.delete(w.id);
    else mapa.set(w.id, destinoDe(w));
  };
  let soltar: (() => void) | null = null;
  let suscripcion: { release(): Promise<void> } | null = null;
  let generacion = 0;
  let pendientes: Operacion[] | null = null;

  const aplica = (operacion: Operacion) => {
    operacion(datos);
    pendientes?.push(operacion);
  };

  const reemplaza = async (primera: readonly Descriptor[], pageInfo: Paginacion) => {
    const mia = ++generacion;
    const cola: Operacion[] = [];
    pendientes = cola;
    try {
      const nuevos = new Map<string, DatosWorkspace>();
      for (const w of primera) anotaEn(nuevos, w);
      let siguiente = pageInfo.hasMore ? pageInfo.nextCursor : null;
      while (siguiente) {
        const pagina = await client.paseo.workspaces.list({ page: { limit: TAMANO_PAGINA, cursor: siguiente } });
        if (signal.aborted || mia !== generacion) return;
        for (const w of pagina.entries) anotaEn(nuevos, w);
        siguiente = pagina.pageInfo.hasMore ? pagina.pageInfo.nextCursor : null;
      }
      if (signal.aborted || mia !== generacion) return;
      for (const operacion of cola) operacion(nuevos);
      // No await from here to `cambio`: the caller never sees the list half swapped.
      datos.clear();
      for (const [id, destino] of nuevos) datos.set(id, destino);
      cambio();
    } finally {
      if (mia === generacion) pendientes = null;
    }
  };

  const falla = (error: unknown) => console.error("paseo-archivadas: no se pudo leer la lista de workspaces", error);
  void client.paseo.workspaces
    .list({ subscribe: {}, page: { limit: TAMANO_PAGINA } })
    .then(({ subscription, entries, pageInfo }) => {
      if (signal.aborted) return void subscription.release();
      suscripcion = subscription;
      soltar = subscription.subscribe({
        snapshot: ({ entries: todas, pageInfo: paginas }) => void reemplaza(todas, paginas).catch(falla),
        update: (mensaje) => {
          if (mensaje.type !== "workspace_update") return;
          const cambioDe = mensaje.payload;
          if (cambioDe.kind === "upsert") aplica((mapa) => anotaEn(mapa, cambioDe.workspace));
          else aplica((mapa) => void mapa.delete(cambioDe.id));
          cambio();
        },
      });
      // The first page goes on screen at once: nothing is listed yet, so nothing can disappear. The rest follows.
      for (const w of entries) anotaEn(datos, w);
      cambio();
      return pageInfo.hasMore ? reemplaza(entries, pageInfo) : undefined;
    })
    .catch(falla);
  return () => {
    soltar?.();
    void suscripcion?.release();
  };
}
