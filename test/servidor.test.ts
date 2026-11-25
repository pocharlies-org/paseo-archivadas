import assert from "node:assert/strict";
import { test } from "node:test";
import { historialCompartido, listaSesiones, restauraSesion } from "../server/archivadas.ts";
import { abreDaemonReal, carpetaPaseo, type Daemon, type EntornoDaemon, escuchaDelDaemon, urlDelDaemon } from "../server/daemon.ts";

type Pagina = { entries: { agent: Record<string, unknown> }[]; pageInfo: { hasMore: boolean; nextCursor: string | null } };

/** A fake daemon client that records what it was asked and whether it was closed. */
function daemonFalso(opciones: {
  recientes?: unknown;
  paginas?: Pagina[];
  fallaEn?: "recientes" | "historial" | "import";
  agente?: { id: string };
}) {
  const llamadas = { recientes: [] as unknown[], historial: [] as unknown[], importa: [] as unknown[], cerrado: 0 };
  let pagina = 0;
  const daemon = {
    fetchRecentProviderSessions: async (o: unknown) => {
      llamadas.recientes.push(o);
      if (opciones.fallaEn === "recientes") throw new Error("falla recientes");
      return opciones.recientes ?? { entries: [] };
    },
    fetchAgentHistory: async (o: unknown) => {
      llamadas.historial.push(o);
      if (opciones.fallaEn === "historial") throw new Error("falla historial");
      return opciones.paginas?.[pagina++] ?? { entries: [], pageInfo: { hasMore: false, nextCursor: null } };
    },
    importAgent: async (o: unknown) => {
      llamadas.importa.push(o);
      if (opciones.fallaEn === "import") throw new Error("Provider session cwd does not match import cwd");
      return opciones.agente ?? { id: "agente-1" };
    },
    close: async () => void (llamadas.cerrado += 1),
  } as unknown as Daemon;
  return { daemon, llamadas };
}

const archivado = (id: string, extra: Record<string, unknown> = {}) => ({
  agent: {
    id,
    provider: "claude",
    cwd: "/work/proyecto",
    workspaceId: "wks_a",
    title: `agente ${id}`,
    archivedAt: "2026-11-06T10:00:00.000Z",
    updatedAt: "2026-11-05T10:00:00.000Z",
    persistence: { sessionId: `s-${id}`, nativeHandle: `s-${id}` },
    ...extra,
  },
});

const entrada = { workspaceId: "wks_a", cwd: "/work/proyecto" };
const canon = (ruta: string) => ruta;

test("listaSesiones asks for what the native sheet asks (200 sessions of the directory) and the whole archived history", async () => {
  const { daemon, llamadas } = daemonFalso({
    recientes: {
      entries: [
        {
          providerId: "claude",
          providerLabel: "Claude CLI",
          providerHandleId: "r1",
          cwd: "/work/proyecto",
          title: "una sesión",
          firstPromptPreview: "hola",
          lastPromptPreview: null,
          lastActivityAt: "2026-11-07T10:00:00.000Z",
        },
      ],
    },
    paginas: [{ entries: [archivado("a1")], pageInfo: { hasMore: false, nextCursor: null } }],
  });
  const { sesiones, avisos } = await listaSesiones(async () => daemon, [entrada], canon);
  assert.deepEqual(llamadas.recientes, [{ cwd: "/work/proyecto", limit: 200 }]);
  assert.deepEqual((llamadas.historial[0] as { filter: unknown }).filter, { includeArchived: true }, "the history is read once for every workspace, without narrowing by project");
  assert.deepEqual(
    sesiones.map((s) => [s.providerHandleId, s.archivada?.agentId ?? null]),
    [
      ["r1", null],
      ["s-a1", "a1"],
    ],
  );
  assert.deepEqual(avisos, []);
  assert.equal(llamadas.cerrado, 1, "the connection is closed after the read");
});

test("listaSesiones follows the history cursor to the end and never narrows it by project", async () => {
  const { daemon, llamadas } = daemonFalso({
    paginas: [
      { entries: [archivado("a1")], pageInfo: { hasMore: true, nextCursor: "c1" } },
      { entries: [archivado("a2")], pageInfo: { hasMore: true, nextCursor: "c2" } },
      { entries: [archivado("a3")], pageInfo: { hasMore: false, nextCursor: null } },
    ],
  });
  const { sesiones } = await listaSesiones(async () => daemon, [entrada], canon);
  assert.equal(sesiones.length, 3);
  assert.equal(llamadas.historial.length, 3);
  assert.equal((llamadas.historial[0] as { page: { cursor?: string } }).page.cursor, undefined);
  assert.equal((llamadas.historial[1] as { page: { cursor?: string } }).page.cursor, "c1");
  assert.equal((llamadas.historial[2] as { page: { cursor?: string } }).page.cursor, "c2");
  assert.equal("projectKeys" in (llamadas.historial[0] as { filter: object }).filter, false);
});

test("listaSesiones stops a cursor that never ends", async () => {
  const siempre: Pagina = { entries: [archivado("a1")], pageInfo: { hasMore: true, nextCursor: "mismo" } };
  const { daemon, llamadas } = daemonFalso({ paginas: Array.from({ length: 500 }, () => siempre) });
  await listaSesiones(async () => daemon, [entrada], canon);
  assert.ok(llamadas.historial.length <= 50, `${llamadas.historial.length} pages`);
});

test("listaSesiones reports the providers whose listing failed, and still lists the archived agents", async () => {
  const { daemon } = daemonFalso({
    recientes: { entries: [], providerErrors: [{ provider: "codex", message: "no está instalado" }] },
    paginas: [{ entries: [archivado("a1")], pageInfo: { hasMore: false, nextCursor: null } }],
  });
  const { sesiones, avisos } = await listaSesiones(async () => daemon, [entrada], canon);
  assert.equal(sesiones.length, 1);
  assert.deepEqual(avisos, ["codex: no está instalado"]);
});

test("listaSesiones lee el historial una vez para todos los workspaces y los recientes por directorio distinto", async () => {
  const { daemon, llamadas } = daemonFalso({
    paginas: [{ entries: [archivado("a1")], pageInfo: { hasMore: false, nextCursor: null } }],
  });
  const { sesiones } = await listaSesiones(
    async () => daemon,
    [entrada, { workspaceId: "wks_b", cwd: "/otro/sitio" }, { workspaceId: "wks_c", cwd: "/work/proyecto" }],
    canon,
  );
  assert.equal(llamadas.historial.length, 1, "one history read for all workspaces");
  assert.deepEqual(llamadas.recientes.map((l) => (l as { cwd: string }).cwd), ["/work/proyecto", "/otro/sitio"], "one read per distinct cwd");
  assert.equal(llamadas.cerrado, 1, "one connection for the whole call");
  assert.deepEqual(
    sesiones.filter((f) => f.archivada).map((f) => f.workspaceId),
    ["wks_a"],
    "an archived agent is listed once, in its own workspace, though wks_c shares its directory",
  );
});

test("listaSesiones closes the connection and passes the error on when a read fails", async () => {
  for (const fallaEn of ["recientes", "historial"] as const) {
    const { daemon, llamadas } = daemonFalso({ fallaEn });
    await assert.rejects(() => listaSesiones(async () => daemon, [entrada], canon), new RegExp(`falla ${fallaEn}`));
    assert.equal(llamadas.cerrado, 1, fallaEn);
  }
});

test("restauraSesion imports into the workspace with the session's own directory and returns the agent to open", async () => {
  const { daemon, llamadas } = daemonFalso({ agente: { id: "agente-9" } });
  const salida = await restauraSesion(async () => daemon, { providerId: "claude", providerHandleId: "s-a1", cwd: "/work/proyecto", workspaceId: "wks_a" });
  assert.deepEqual(salida, { agentId: "agente-9" });
  assert.deepEqual(llamadas.importa, [{ providerId: "claude", providerHandleId: "s-a1", cwd: "/work/proyecto", workspaceId: "wks_a" }]);
  assert.equal(llamadas.cerrado, 1);
});

test("restauraSesion passes the daemon's refusal on and still closes the connection", async () => {
  const { daemon, llamadas } = daemonFalso({ fallaEn: "import" });
  await assert.rejects(
    () => restauraSesion(async () => daemon, { providerId: "claude", providerHandleId: "x", cwd: "/otro", workspaceId: "wks_a" }),
    /does not match import cwd/,
  );
  assert.equal(llamadas.cerrado, 1);
});

test("urlDelDaemon: any TCP listen address becomes the loopback websocket of its port", () => {
  assert.equal(urlDelDaemon("0.0.0.0:6767"), "ws://127.0.0.1:6767/ws");
  assert.equal(urlDelDaemon("127.0.0.1:7000"), "ws://127.0.0.1:7000/ws");
  assert.equal(urlDelDaemon("localhost:6767"), "ws://127.0.0.1:6767/ws");
  assert.equal(urlDelDaemon("[::]:6767"), "ws://127.0.0.1:6767/ws");
  assert.throws(() => urlDelDaemon("/tmp/paseo.sock"), /solo sabe conectar por TCP/);
  assert.throws(() => urlDelDaemon("unix:///tmp/paseo.sock"), /solo sabe conectar por TCP/);
});

const entorno = (env: Record<string, string>, ficheros: Record<string, string> = {}): EntornoDaemon => ({
  env,
  home: "/home/u",
  lee: (ruta) => ficheros[ruta] ?? null,
});

test("carpetaPaseo: PASEO_HOME with ~ expanded, else ~/.paseo", () => {
  assert.equal(carpetaPaseo({ env: {}, home: "/home/u" }), "/home/u/.paseo");
  assert.equal(carpetaPaseo({ env: { PASEO_HOME: "~/otro" }, home: "/home/u" }), "/home/u/otro");
  assert.equal(carpetaPaseo({ env: { PASEO_HOME: "/srv/paseo" }, home: "/home/u" }), "/srv/paseo");
});

test("escuchaDelDaemon: PASEO_LISTEN first, then the lock file, else a clear error", () => {
  assert.equal(escuchaDelDaemon(entorno({ PASEO_LISTEN: "0.0.0.0:6767" })), "0.0.0.0:6767");
  assert.equal(escuchaDelDaemon(entorno({}, { "/home/u/.paseo/paseo.pid": '{"pid":1,"listen":"127.0.0.1:6800"}' })), "127.0.0.1:6800");
  assert.throws(() => escuchaDelDaemon(entorno({}, { "/home/u/.paseo/paseo.pid": "no es json" })), /No encuentro el daemon/);
  assert.throws(() => escuchaDelDaemon(entorno({})), /No encuentro el daemon/);
});

class ClienteFalso {
  static ultimo: ClienteFalso | null = null;
  static falla = false;
  cerrado = false;
  readonly config: Record<string, unknown>;
  constructor(config: Record<string, unknown>) {
    this.config = config;
    ClienteFalso.ultimo = this;
  }
  async connect() {
    if (ClienteFalso.falla) throw new Error("rechazado");
  }
  async close() {
    this.cerrado = true;
  }
}

test("abreDaemonReal connects to the local daemon like the CLI: local credential and the daemon password, a fresh client id per connection", async () => {
  ClienteFalso.falla = false;
  const env = entorno({ PASEO_LISTEN: "0.0.0.0:6767", PASEO_PASSWORD: "pw" }, { "/home/u/.paseo/local-credential": "token-local\n" });
  const abre = abreDaemonReal(() => ({ DaemonClient: ClienteFalso }), env);
  await abre();
  const primero = ClienteFalso.ultimo as ClienteFalso;
  assert.equal(primero.config.url, "ws://127.0.0.1:6767/ws");
  assert.equal(primero.config.clientType, "cli");
  assert.equal(primero.config.password, "pw");
  assert.equal((primero.config.localCredential as () => string | undefined)(), "token-local");
  assert.deepEqual(primero.config.reconnect, { enabled: false });
  await abre();
  assert.notEqual((ClienteFalso.ultimo as ClienteFalso).config.clientId, primero.config.clientId);
  assert.match(String(primero.config.clientId), /^paseo-archivadas-/);
});

test("abreDaemonReal sends no password when the environment has none, and no credential when the file is missing", async () => {
  ClienteFalso.falla = false;
  await abreDaemonReal(() => ({ DaemonClient: ClienteFalso }), entorno({ PASEO_LISTEN: "0.0.0.0:6767" }))();
  const config = (ClienteFalso.ultimo as ClienteFalso).config;
  assert.equal("password" in config, false);
  assert.equal((config.localCredential as () => string | undefined)(), undefined);
});

test("abreDaemonReal closes the client when it cannot connect, and explains a host that does not give the client module", async () => {
  ClienteFalso.falla = true;
  await assert.rejects(() => abreDaemonReal(() => ({ DaemonClient: ClienteFalso }), entorno({ PASEO_LISTEN: "0.0.0.0:6767" }))(), /rechazado/);
  assert.equal((ClienteFalso.ultimo as ClienteFalso).cerrado, true);
  const sinModulo = abreDaemonReal(() => {
    throw new Error("Cannot find module");
  }, entorno({ PASEO_LISTEN: "0.0.0.0:6767" }));
  await assert.rejects(sinModulo, /no deja cargar el cliente del daemon.*Cannot find module/);
  const malFormado = abreDaemonReal(() => ({}), entorno({ PASEO_LISTEN: "0.0.0.0:6767" }));
  await assert.rejects(malFormado, /no tiene la forma esperada/);
});

test("listaSesiones lists a directory's sessions once, in the first workspace asked, when several workspaces share it", async () => {
  const reciente = { providerId: "claude", providerLabel: "Claude", providerHandleId: "s-x", cwd: "/work/proyecto", title: "x", firstPromptPreview: null, lastPromptPreview: null, lastActivityAt: "2026-11-06T10:00:00.000Z" };
  const { daemon } = daemonFalso({
    recientes: { entries: [reciente] },
    paginas: [{ entries: [archivado("a1", { workspaceId: "wks_c" })], pageInfo: { hasMore: false, nextCursor: null } }],
  });
  const { sesiones } = await listaSesiones(async () => daemon, [entrada, { workspaceId: "wks_c", cwd: "/work/proyecto" }], canon);
  assert.deepEqual(
    sesiones.map((f) => [f.providerHandleId, f.workspaceId]).sort(),
    [["s-a1", "wks_c"], ["s-x", "wks_a"]],
    "the archived one in its agent's workspace, the never-imported one in the first asked",
  );
});

test("historialCompartido: the calls of one opening share one read; a failed read, the window's end or a restore read again", async () => {
  let ahora = 0;
  const historial = historialCompartido(30_000, () => ahora);
  const { daemon, llamadas } = daemonFalso({ paginas: [{ entries: [archivado("a")], pageInfo: { hasMore: false, nextCursor: null } }] });
  await listaSesiones(async () => daemon, [entrada], canon, historial.lee);
  await listaSesiones(async () => daemon, [{ workspaceId: "wks_b", cwd: "/work/otro" }], canon, historial.lee);
  assert.equal(llamadas.historial.length, 1, "the second workspace reuses the first read");
  ahora = 30_001;
  await listaSesiones(async () => daemon, [entrada], canon, historial.lee);
  assert.equal(llamadas.historial.length, 2, "past the window the history is read again");
  historial.olvida();
  await listaSesiones(async () => daemon, [entrada], canon, historial.lee);
  assert.equal(llamadas.historial.length, 3, "a restore forgets it");

  const roto = daemonFalso({ fallaEn: "historial" });
  const otro = historialCompartido(30_000, () => 0);
  await assert.rejects(listaSesiones(async () => roto.daemon, [entrada], canon, otro.lee));
  await assert.rejects(listaSesiones(async () => roto.daemon, [entrada], canon, otro.lee));
  assert.equal(roto.llamadas.historial.length, 2, "a failed read is not kept");
});
