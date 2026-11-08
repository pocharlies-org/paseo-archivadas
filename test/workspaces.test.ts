import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { type DatosWorkspace, type Descriptor, destinoDe, vigilaWorkspaces } from "../client/workspaces.ts";

type Pagina = { entries: Descriptor[]; pageInfo: { hasMore: boolean; nextCursor: string | null } };
type Observador = {
  snapshot(valor: Pagina): void;
  update(mensaje: { type: string; payload: { kind: "upsert"; workspace: Descriptor } | { kind: "remove"; id: string } }): void;
};

const w = (id: string, extra: Partial<Descriptor> = {}): Descriptor => ({ id, projectId: "prj_1", projectRootPath: `/root/${id}`, ...extra });
const ids = (cantidad: number, desde = 0) => Array.from({ length: cantidad }, (_, n) => w(`w${desde + n}`));
const tick = () => new Promise<void>((resolver) => setTimeout(resolver, 0));

/** A promise a test resolves by hand: the page a fake host has not answered yet. */
function diferida<T>() {
  let resolver!: (valor: T) => void;
  let rechazar!: (error: unknown) => void;
  const promesa = new Promise<T>((ok, ko) => {
    resolver = ok;
    rechazar = ko;
  });
  return { promesa, resolver, rechazar };
}

/**
 * A fake host: the first `list` is the subscription (first page), the others read the page of their cursor from `paginas`
 * (a value, or a promise for a page the test answers later). `snapshot` and `update` are what the subscription would push.
 */
function hostFalso(inicial: Pagina, paginas: Record<string, Pagina | Promise<Pagina>> = {}) {
  let observador: Observador | null = null;
  const llamadas: { cursor?: string }[] = [];
  const estado = { liberada: 0, soltada: 0 };
  const subscription = {
    subscriptionId: "sub-1",
    ready: Promise.resolve(inicial),
    subscribe: (o: Observador) => {
      observador = o;
      return () => void (estado.soltada += 1);
    },
    release: async () => void (estado.liberada += 1),
  };
  const client = {
    paseo: {
      workspaces: {
        list: async (opciones: { subscribe?: object; page?: { limit: number; cursor?: string } }) => {
          if (opciones.subscribe) return { requestId: "r", subscriptionId: "sub-1", subscription, ...inicial };
          llamadas.push({ cursor: opciones.page?.cursor });
          const pagina = paginas[opciones.page?.cursor ?? ""];
          if (!pagina) throw new Error(`página sin preparar: ${opciones.page?.cursor}`);
          return { requestId: "r", ...(await pagina) };
        },
      },
    },
  } as unknown as Parameters<typeof vigilaWorkspaces>[0];
  return {
    client,
    llamadas,
    estado,
    snapshot: (pagina: Pagina) => (observador as Observador).snapshot(pagina),
    upsert: (workspace: Descriptor) => (observador as Observador).update({ type: "workspace_update", payload: { kind: "upsert", workspace } }),
    quita: (id: string) => (observador as Observador).update({ type: "workspace_update", payload: { kind: "remove", id } }),
  };
}

/** What the real caller does on each `cambio`: one button per workspace in `datos`, added when it appears, removed when it goes. */
function botonesFalsos(datos: Map<string, DatosWorkspace>) {
  const botones = new Set<string>();
  const registro = { añadidos: 0, quitados: 0, cambios: 0 };
  const sincroniza = () => {
    registro.cambios += 1;
    for (const id of datos.keys()) {
      if (botones.has(id)) continue;
      botones.add(id);
      registro.añadidos += 1;
    }
    for (const id of [...botones]) {
      if (datos.has(id)) continue;
      botones.delete(id);
      registro.quitados += 1;
    }
  };
  return { botones, registro, sincroniza };
}

test("destinoDe: the workspace directory, else the project root; the project key is null without a project", () => {
  assert.deepEqual(destinoDe(w("a")), { cwd: "/root/a", projectKey: "prj_1" });
  assert.deepEqual(destinoDe(w("a", { workspaceDirectory: "/work/a" })), { cwd: "/work/a", projectKey: "prj_1" });
  assert.deepEqual(destinoDe(w("a", { projectId: "" })), { cwd: "/root/a", projectKey: null });
});

test("the first snapshot of a host with several pages lists the first page at once and the rest when it has them", async () => {
  const datos = new Map<string, DatosWorkspace>();
  const { botones, registro, sincroniza } = botonesFalsos(datos);
  const segunda = diferida<Pagina>();
  const host = hostFalso(
    { entries: ids(200), pageInfo: { hasMore: true, nextCursor: "c1" } },
    { c1: segunda.promesa },
  );
  const suelta = vigilaWorkspaces(host.client, new AbortController().signal, datos, sincroniza);
  await tick();
  assert.equal(datos.size, 200, "the first page is on screen without waiting for the rest");
  segunda.resolver({ entries: ids(50, 200), pageInfo: { hasMore: false, nextCursor: null } });
  await tick();
  assert.equal(datos.size, 250);
  assert.equal(botones.size, 250);
  assert.equal(registro.quitados, 0);
  assert.deepEqual(host.llamadas, [{ cursor: "c1" }]);
  suelta();
  assert.equal(host.estado.soltada, 1);
  assert.equal(host.estado.liberada, 1);
});

test("a new snapshot of a host with more than 200 workspaces never removes the buttons of the later pages while it reads them", async () => {
  const datos = new Map<string, DatosWorkspace>();
  const { botones, registro, sincroniza } = botonesFalsos(datos);
  const c1 = diferida<Pagina>();
  const c2 = diferida<Pagina>();
  const host = hostFalso({ entries: ids(200), pageInfo: { hasMore: true, nextCursor: "a1" } }, {
    a1: { entries: ids(200, 200), pageInfo: { hasMore: true, nextCursor: "a2" } },
    a2: { entries: ids(50, 400), pageInfo: { hasMore: false, nextCursor: null } },
    c1: c1.promesa,
    c2: c2.promesa,
  });
  vigilaWorkspaces(host.client, new AbortController().signal, datos, sincroniza);
  await tick();
  assert.equal(datos.size, 450);
  assert.equal(botones.size, 450);
  const antes = { ...registro };

  // The host sends its snapshot again (a reconnect): the same 450 workspaces, three pages, the later ones slow to arrive.
  host.snapshot({ entries: ids(200), pageInfo: { hasMore: true, nextCursor: "c1" } });
  await tick();
  assert.equal(datos.size, 450, "page 1 alone does not replace the list");
  assert.equal(registro.cambios, antes.cambios, "nothing is announced until the whole list is known");
  c1.resolver({ entries: ids(200, 200), pageInfo: { hasMore: true, nextCursor: "c2" } });
  await tick();
  assert.equal(datos.size, 450);
  assert.equal(registro.cambios, antes.cambios, "still reading");
  c2.resolver({ entries: ids(50, 400), pageInfo: { hasMore: false, nextCursor: null } });
  await tick();

  assert.equal(datos.size, 450);
  assert.equal(registro.cambios, antes.cambios + 1, "one announcement, after the swap");
  assert.equal(registro.quitados, 0, "no button was taken down");
  assert.equal(registro.añadidos, 450, "and none was drawn again");
  assert.equal(botones.size, 450);
});

test("a snapshot swaps the list: workspaces that are gone leave, new ones arrive, one that is archiving is not listed", async () => {
  const datos = new Map<string, DatosWorkspace>();
  const { botones, registro, sincroniza } = botonesFalsos(datos);
  const c1 = diferida<Pagina>();
  const host = hostFalso({ entries: [w("a"), w("b"), w("c")], pageInfo: { hasMore: false, nextCursor: null } }, { c1: c1.promesa });
  vigilaWorkspaces(host.client, new AbortController().signal, datos, sincroniza);
  await tick();
  assert.deepEqual([...botones].sort(), ["a", "b", "c"]);

  host.snapshot({ entries: [w("a"), w("d")], pageInfo: { hasMore: true, nextCursor: "c1" } });
  await tick();
  assert.deepEqual([...datos.keys()].sort(), ["a", "b", "c"], "the old list stays until the new one is complete");
  c1.resolver({ entries: [w("e", { workspaceDirectory: "/work/e" }), w("f", { archivingAt: "2026-11-08T10:00:00.000Z" })], pageInfo: { hasMore: false, nextCursor: null } });
  await tick();
  assert.deepEqual([...datos.keys()].sort(), ["a", "d", "e"]);
  assert.deepEqual([...botones].sort(), ["a", "d", "e"]);
  assert.deepEqual(datos.get("e"), { cwd: "/work/e", projectKey: "prj_1" });
  assert.equal(registro.quitados, 2, "b and c left");
});

test("changes the host sends while the pages are being read are kept: applied now, and replayed over the new list", async () => {
  const datos = new Map<string, DatosWorkspace>();
  const { sincroniza } = botonesFalsos(datos);
  const c1 = diferida<Pagina>();
  const host = hostFalso({ entries: [w("a"), w("b")], pageInfo: { hasMore: false, nextCursor: null } }, { c1: c1.promesa });
  vigilaWorkspaces(host.client, new AbortController().signal, datos, sincroniza);
  await tick();

  host.snapshot({ entries: [w("a"), w("b")], pageInfo: { hasMore: true, nextCursor: "c1" } });
  await tick();
  host.upsert(w("nuevo"));
  host.quita("b");
  assert.deepEqual([...datos.keys()].sort(), ["a", "nuevo"], "an update shows at once, even mid-read");
  // The pages were read before those changes: the second one still lists b, and knows nothing of «nuevo».
  c1.resolver({ entries: [w("b"), w("c")], pageInfo: { hasMore: false, nextCursor: null } });
  await tick();
  assert.deepEqual([...datos.keys()].sort(), ["a", "c", "nuevo"], "b stays removed and «nuevo» stays listed");
});

test("a snapshot that a newer one overtook is dropped, however late its pages arrive", async () => {
  const datos = new Map<string, DatosWorkspace>();
  const { registro, sincroniza } = botonesFalsos(datos);
  const lenta = diferida<Pagina>();
  const host = hostFalso({ entries: [w("a")], pageInfo: { hasMore: false, nextCursor: null } }, {
    lenta: lenta.promesa,
    rapida: { entries: [w("r2")], pageInfo: { hasMore: false, nextCursor: null } },
  });
  vigilaWorkspaces(host.client, new AbortController().signal, datos, sincroniza);
  await tick();

  host.snapshot({ entries: [w("l1")], pageInfo: { hasMore: true, nextCursor: "lenta" } });
  host.snapshot({ entries: [w("r1")], pageInfo: { hasMore: true, nextCursor: "rapida" } });
  await tick();
  assert.deepEqual([...datos.keys()].sort(), ["r1", "r2"], "the newer snapshot won");
  const cambios = registro.cambios;
  lenta.resolver({ entries: [w("l2")], pageInfo: { hasMore: false, nextCursor: null } });
  await tick();
  assert.deepEqual([...datos.keys()].sort(), ["r1", "r2"], "the stale one did not swap in");
  assert.equal(registro.cambios, cambios);
});

test("nothing is swapped after the plugin is torn down, and a page that fails leaves the list as it was and logs", async () => {
  const datos = new Map<string, DatosWorkspace>();
  const { registro, sincroniza } = botonesFalsos(datos);
  const lenta = diferida<Pagina>();
  const rota = diferida<Pagina>();
  const control = new AbortController();
  const host = hostFalso({ entries: [w("a")], pageInfo: { hasMore: false, nextCursor: null } }, { lenta: lenta.promesa, rota: rota.promesa });
  const consola = mock.method(console, "error", () => undefined);
  try {
    vigilaWorkspaces(host.client, control.signal, datos, sincroniza);
    await tick();

    host.snapshot({ entries: [w("x")], pageInfo: { hasMore: true, nextCursor: "rota" } });
    await tick();
    rota.rechazar(new Error("la conexión se cayó"));
    await tick();
    assert.deepEqual([...datos.keys()], ["a"], "a half-read list is not swapped in");
    assert.equal(consola.mock.callCount(), 1, "the failure is reported");

    const cambios = registro.cambios;
    host.snapshot({ entries: [w("y")], pageInfo: { hasMore: true, nextCursor: "lenta" } });
    await tick();
    control.abort();
    lenta.resolver({ entries: [w("z")], pageInfo: { hasMore: false, nextCursor: null } });
    await tick();
    assert.deepEqual([...datos.keys()], ["a"], "aborted: no swap");
    assert.equal(registro.cambios, cambios);
  } finally {
    consola.mock.restore();
  }
});

test("a plugin torn down before the host answers releases the subscription it never used", async () => {
  const datos = new Map<string, DatosWorkspace>();
  const control = new AbortController();
  const host = hostFalso({ entries: [w("a")], pageInfo: { hasMore: false, nextCursor: null } });
  vigilaWorkspaces(host.client, control.signal, datos, () => undefined);
  control.abort();
  await tick();
  assert.equal(host.estado.liberada, 1);
  assert.equal(datos.size, 0);
});
