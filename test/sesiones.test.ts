import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sesion } from "../shared/contract.ts";
import {
  type AgenteHistorial,
  buscar,
  claveDe,
  clavesDe,
  conHistorial,
  desenvuelve,
  esDelWorkspace,
  etiquetaArchivada,
  fechaCorta,
  fusionar,
  hace,
  handleDe,
  handlesDe,
  ordenar,
  porComprobar,
  proveedorDe,
  type Reciente,
  restaurable,
  subtituloDe,
} from "../shared/sesiones.ts";

const canon = (ruta: string) => ruta.replace(/^\/private/, "");
const destino = { workspaceId: "wks_a", cwd: "/work/proyecto" };

const agente = (parcial: Partial<AgenteHistorial> & { id: string }): AgenteHistorial => ({
  provider: "claude",
  cwd: "/work/proyecto",
  workspaceId: "wks_a",
  title: `agente ${parcial.id}`,
  archivedAt: "2026-11-06T10:00:00.000Z",
  updatedAt: "2026-11-05T10:00:00.000Z",
  persistence: { sessionId: `s-${parcial.id}`, nativeHandle: `s-${parcial.id}` },
  ...parcial,
});

const reciente = (handle: string, parcial: Partial<Reciente> = {}): Reciente => ({
  providerId: "claude",
  providerLabel: "Claude CLI",
  providerHandleId: handle,
  cwd: "/work/proyecto",
  title: `sesión ${handle}`,
  firstPromptPreview: `primer prompt ${handle}`,
  lastPromptPreview: `último prompt ${handle}`,
  lastActivityAt: "2026-11-07T10:00:00.000Z",
  ...parcial,
});

test("handleDe prefers the native handle, then the session id; a handle only in runtimeInfo is not one", () => {
  assert.equal(handleDe(agente({ id: "1", persistence: { nativeHandle: "n", sessionId: "s" } })), "n");
  assert.equal(handleDe(agente({ id: "1", persistence: { nativeHandle: null, sessionId: "s" } })), "s");
  assert.equal(handleDe(agente({ id: "1", persistence: null, runtimeInfo: { sessionId: "r" } })), null, "the daemon would import it as a new agent");
  assert.equal(handleDe(agente({ id: "1", persistence: { nativeHandle: "", sessionId: "" }, runtimeInfo: { sessionId: "r" } })), null);
  assert.equal(handleDe(agente({ id: "1", persistence: null, runtimeInfo: null })), null);
});

test("handlesDe, proveedorDe and clavesDe: both keys the daemon matches on, under the persisted provider", () => {
  const dos = agente({ id: "1", provider: "claude", persistence: { provider: "codex", nativeHandle: "n", sessionId: "s" } });
  assert.deepEqual(handlesDe(dos), ["n", "s"]);
  assert.equal(proveedorDe(dos), "codex", "the persisted provider is the one the daemon matches");
  assert.deepEqual(clavesDe(dos), [claveDe("codex", "n"), claveDe("codex", "s")]);
  const igual = agente({ id: "1", persistence: { nativeHandle: "x", sessionId: "x" } });
  assert.deepEqual(handlesDe(igual), ["x"], "one handle under two names is one key");
  assert.equal(proveedorDe(igual), "claude", "no persisted provider: the agent's own");
  assert.deepEqual(clavesDe(agente({ id: "1", persistence: null, runtimeInfo: { sessionId: "r" } })), []);
});

test("esDelWorkspace: archived and (same workspace id or same directory after realpath)", () => {
  assert.equal(esDelWorkspace(agente({ id: "1" }), destino, canon), true);
  assert.equal(esDelWorkspace(agente({ id: "1", workspaceId: "wks_otro" }), destino, canon), true, "same cwd, other workspace");
  assert.equal(esDelWorkspace(agente({ id: "1", workspaceId: "wks_a", cwd: "/otro/sitio" }), destino, canon), true, "same workspace, other cwd");
  assert.equal(esDelWorkspace(agente({ id: "1", workspaceId: "wks_otro", cwd: "/otro/sitio" }), destino, canon), false);
  assert.equal(esDelWorkspace(agente({ id: "1", cwd: "/private/work/proyecto", workspaceId: "wks_otro" }), destino, canon), true, "realpath");
  assert.equal(esDelWorkspace(agente({ id: "1", archivedAt: null }), destino, canon), false, "live agents are not archived");
  assert.equal(esDelWorkspace(agente({ id: "1", workspaceId: null, archivedAt: "2026-11-01T00:00:00Z" }), destino, canon), true);
});

test("fusionar: importable sessions and archived agents become one list, newest first", () => {
  const filas = fusionar({
    recientes: [reciente("a", { lastActivityAt: "2026-11-07T10:00:00.000Z" }), reciente("b", { lastActivityAt: "2026-11-08T10:00:00.000Z" })],
    agentes: [agente({ id: "x", lastUserMessageAt: "2026-11-07T20:00:00.000Z" })],
    destino,
    canon,
  });
  assert.deepEqual(
    filas.map((f) => f.providerHandleId),
    ["b", "s-x", "a"],
  );
  assert.equal(filas[0]?.archivada, null);
  assert.equal(filas[0]?.historial, "si");
  assert.deepEqual(filas[1]?.archivada, { agentId: "x", archivadaEn: "2026-11-06T10:00:00.000Z" });
  assert.equal(filas[1]?.historial, "desconocido", "an archived-only row has to be checked on disk");
});

test("fusionar: a session that is importable and archived is one row, and the archived record wins", () => {
  const filas = fusionar({
    recientes: [reciente("s-x", { title: "título del proveedor", lastActivityAt: "2026-11-07T10:00:00.000Z" })],
    agentes: [agente({ id: "x", title: "título del agente" })],
    destino,
    canon,
  });
  assert.equal(filas.length, 1);
  const fila = filas[0] as Sesion;
  assert.equal(fila.archivada?.agentId, "x", "importing brings this very agent back");
  assert.equal(fila.titulo, "título del proveedor", "the provider listing has the richer text");
  assert.equal(fila.historial, "si", "the daemon lists it, so its transcript is there");
  assert.equal(fila.ultimaActividad, "2026-11-07T10:00:00.000Z");
});

test("fusionar: an archived agent whose session also runs as a live agent is dropped (the import would fail)", () => {
  const filas = fusionar({
    recientes: [],
    agentes: [agente({ id: "viejo" }), agente({ id: "vivo", archivedAt: null, persistence: { sessionId: "s-viejo", nativeHandle: "s-viejo" } })],
    destino,
    canon,
  });
  assert.deepEqual(filas, []);
});

test("fusionar: several archived records of one session keep the most recently archived", () => {
  const filas = fusionar({
    recientes: [],
    agentes: [
      agente({ id: "1", archivedAt: "2026-10-01T00:00:00.000Z", persistence: { sessionId: "mismo", nativeHandle: "mismo" } }),
      agente({ id: "2", archivedAt: "2026-11-01T00:00:00.000Z", persistence: { sessionId: "mismo", nativeHandle: "mismo" } }),
      agente({ id: "3", archivedAt: "2026-09-01T00:00:00.000Z", persistence: { sessionId: "mismo", nativeHandle: "mismo" } }),
    ],
    destino,
    canon,
  });
  assert.equal(filas.length, 1);
  assert.equal(filas[0]?.archivada?.agentId, "2");
});

test("fusionar: archived agents of other workspaces and directories stay out", () => {
  const filas = fusionar({
    recientes: [],
    agentes: [agente({ id: "ajeno", workspaceId: "wks_otro", cwd: "/otro" }), agente({ id: "mio", workspaceId: "wks_otro" })],
    destino,
    canon,
  });
  assert.deepEqual(
    filas.map((f) => f.archivada?.agentId),
    ["mio"],
  );
});

test("fusionar: an archived agent that never had a provider session is listed as a dead end with nothing to look up", () => {
  const filas = fusionar({
    recientes: [],
    agentes: [agente({ id: "sin-sesion", persistence: null, runtimeInfo: null, title: "Hermes keep-alive" }), agente({ id: "ajeno", persistence: null, workspaceId: "wks_otro", cwd: "/otro" })],
    destino,
    canon,
  });
  assert.equal(filas.length, 1);
  const fila = filas[0] as Sesion;
  assert.equal(fila.archivada?.agentId, "sin-sesion");
  assert.equal(fila.titulo, "Hermes keep-alive");
  assert.equal(fila.historial, "no");
  assert.equal(restaurable(fila), false);
  assert.deepEqual(porComprobar(filas), [], "no handle, so no transcript to look for");
  assert.equal(etiquetaArchivada(fila, new Date(2026, 10, 8)), "Archivada · 6 nov · sin historial");
});

test("fusionar: the same handle under two providers stays two rows", () => {
  const filas = fusionar({
    recientes: [reciente("h"), reciente("h", { providerId: "codex", providerLabel: "Codex" })],
    agentes: [],
    destino,
    canon,
  });
  assert.equal(filas.length, 2);
  assert.notEqual(filas[0]?.clave, filas[1]?.clave);
});

test("fusionar: titles and summaries fall back sensibly", () => {
  const [fila] = fusionar({
    recientes: [reciente("h", { title: null, firstPromptPreview: "  hola   mundo ", lastPromptPreview: "hola mundo" })],
    agentes: [],
    destino,
    canon,
  });
  assert.equal(fila?.titulo, "hola mundo", "no title: the first prompt, whitespace collapsed");
  assert.equal(fila?.resumen, "hola mundo", "equal previews are shown once, whitespace collapsed");
  const [vacia] = fusionar({ recientes: [reciente("h", { title: null, firstPromptPreview: null, lastPromptPreview: null })], agentes: [], destino, canon });
  assert.equal(vacia?.titulo, "Sin título");
  const [archivada] = fusionar({ recientes: [], agentes: [agente({ id: "1", title: null })], destino, canon });
  assert.equal(archivada?.titulo, "Sin título");
});

test("fusionar: a long title (Paseo's title of a session with none is its whole first prompt) is cut to two lines' worth", () => {
  const largo = `Comprobación diaria\n\n${"palabra ".repeat(500)}`;
  const [fila, archivada] = fusionar({
    recientes: [reciente("h", { title: largo })],
    agentes: [agente({ id: "x", title: largo })],
    destino,
    canon,
  }) as [Sesion, Sesion];
  assert.ok(fila.titulo.length <= 160, `${fila.titulo.length} chars`);
  assert.ok(fila.titulo.startsWith("Comprobación diaria palabra palabra"));
  assert.ok(fila.titulo.endsWith("…"));
  assert.ok(archivada.titulo.length <= 160);
});

test("ordenar: newest first, no date last, ties by key", () => {
  const base = { providerId: "claude", providerLabel: "c", providerHandleId: "", cwd: "/", titulo: "", resumen: "", ultimoPrompt: "", archivada: null, historial: "si" as const };
  const f = (clave: string, ultimaActividad: string | null): Sesion => ({ ...base, clave, ultimaActividad });
  const orden = ordenar([f("c", null), f("b", "2026-11-01T00:00:00Z"), f("a", "2026-11-01T00:00:00Z"), f("d", "2026-11-02T00:00:00Z"), f("e", "no es fecha")]);
  assert.deepEqual(
    orden.map((x) => x.clave),
    ["d", "a", "b", "c", "e"],
  );
});

test("buscar: every word, accents and case ignored, over title, previews and provider; «archivada» finds archived rows", () => {
  const filas = fusionar({
    recientes: [
      reciente("a", { title: "Revisa el proyecto de CloudBlue", firstPromptPreview: "mira el código", lastPromptPreview: null }),
      reciente("b", { title: "Otra cosa", firstPromptPreview: "informe de métricas", lastPromptPreview: null, providerLabel: "Codex" }),
    ],
    agentes: [agente({ id: "x", title: "Reports de GCP" })],
    destino,
    canon,
  });
  const claves = (texto: string) => buscar(filas, texto).map((f) => f.providerHandleId);
  assert.deepEqual(claves(""), claves("   "), "an empty search keeps every row");
  assert.equal(claves("").length, 3);
  assert.deepEqual(claves("cloudblue proyecto"), ["a"]);
  assert.deepEqual(claves("CODIGO"), ["a"], "accents and case do not matter");
  assert.deepEqual(claves("metricas"), ["b"], "the typed word has no accent, the text has");
  assert.deepEqual(claves("codex"), ["b"], "the provider label counts");
  assert.deepEqual(claves("archivada"), ["s-x"]);
  assert.deepEqual(claves("proyecto zzz"), []);
});

test("conHistorial and porComprobar: only archived rows are checked, and the answer sets the three states", () => {
  const filas = fusionar({
    recientes: [reciente("vivo")],
    agentes: [agente({ id: "a" }), agente({ id: "b" }), agente({ id: "c", provider: "codex" })],
    destino,
    canon,
  });
  assert.deepEqual(
    porComprobar(filas).map((p) => p.sessionId).sort(),
    ["s-a", "s-b", "s-c"],
  );
  const resueltas = conHistorial(filas, [
    { provider: "claude", sessionId: "s-a", existe: true },
    { provider: "claude", sessionId: "s-b", existe: false },
    { provider: "codex", sessionId: "s-c", existe: null },
  ]);
  const estado = (handle: string) => resueltas.find((f) => f.providerHandleId === handle)?.historial;
  assert.equal(estado("s-a"), "si");
  assert.equal(estado("s-b"), "no");
  assert.equal(estado("s-c"), "desconocido");
  assert.equal(estado("vivo"), "si", "rows the lookup did not answer keep their state");
  assert.deepEqual(porComprobar(resueltas.filter((f) => f.providerHandleId !== "s-c")), [], "nothing is left to check once answered");
});

test("restaurable: archived without history is the only dead end", () => {
  const filas = conHistorial(
    fusionar({ recientes: [reciente("n")], agentes: [agente({ id: "a" }), agente({ id: "b" }), agente({ id: "c" })], destino, canon }),
    [
      { provider: "claude", sessionId: "s-a", existe: true },
      { provider: "claude", sessionId: "s-b", existe: false },
    ],
  );
  const de = (handle: string) => filas.find((f) => f.providerHandleId === handle) as Sesion;
  assert.equal(restaurable(de("n")), true, "a plain importable session");
  assert.equal(restaurable(de("s-a")), true, "archived with its history");
  assert.equal(restaurable(de("s-b")), false, "archived without history");
  assert.equal(restaurable(de("s-c")), true, "unknown history is tried: the daemon rolls back what it cannot resume");
});

test("claveDe keeps provider and handle apart", () => {
  assert.notEqual(claveDe("a", "b c"), claveDe("a b", "c"));
});

const AHORA = new Date(2026, 10, 8, 12, 0, 0); // 8 Nov 2026, local time

test("fechaCorta: day and month, plus the year when it is not this one", () => {
  assert.equal(fechaCorta(new Date(2026, 10, 6, 9).toISOString(), AHORA), "6 nov");
  assert.equal(fechaCorta(new Date(2026, 0, 12, 9).toISOString(), AHORA), "12 ene");
  assert.equal(fechaCorta(new Date(2025, 9, 12, 9).toISOString(), AHORA), "12 oct 2025");
  assert.equal(fechaCorta("no es fecha", AHORA), "");
});

test("hace: minutes, hours, days, then the date", () => {
  const antes = (ms: number) => new Date(AHORA.getTime() - ms).toISOString();
  assert.equal(hace(antes(10_000), AHORA), "ahora");
  assert.equal(hace(antes(5 * 60_000), AHORA), "hace 5 min");
  assert.equal(hace(antes(2 * 3_600_000), AHORA), "hace 2 h");
  assert.equal(hace(antes(3 * 86_400_000), AHORA), "hace 3 d");
  assert.equal(hace(new Date(2026, 8, 1, 9).toISOString(), AHORA), "1 sep");
  assert.equal(hace(null, AHORA), "");
  assert.equal(hace("no es fecha", AHORA), "");
});

test("etiquetaArchivada: «Archivada · 6 nov», plus «sin historial» when it cannot come back", () => {
  const [fila] = fusionar({ recientes: [], agentes: [agente({ id: "a", archivedAt: new Date(2026, 10, 6, 9).toISOString() })], destino, canon });
  assert.equal(etiquetaArchivada(fila as Sesion, AHORA), "Archivada · 6 nov");
  const sin = conHistorial([fila as Sesion], [{ provider: "claude", sessionId: "s-a", existe: false }])[0] as Sesion;
  assert.equal(etiquetaArchivada(sin, AHORA), "Archivada · 6 nov · sin historial");
  const [normal] = fusionar({ recientes: [reciente("n")], agentes: [], destino, canon });
  assert.equal(etiquetaArchivada(normal as Sesion, AHORA), null);
});

test("subtituloDe: the last prompt, unless it only repeats the title or is not something the user wrote", () => {
  const fila = (titulo: string, ultimoPrompt: string): Sesion => ({
    clave: "k", providerId: "claude", providerLabel: "c", providerHandleId: "h", cwd: "/", titulo, resumen: "", ultimoPrompt, ultimaActividad: null, archivada: null, historial: "si",
  });
  assert.equal(subtituloDe(fila("Revisa el proyecto", "ahora el segundo punto")), "ahora el segundo punto");
  assert.equal(subtituloDe(fila("Revisa el proyecto", "Revisa el proyecto")), "", "same as the title");
  assert.equal(subtituloDe(fila("crea un post  igual que… ", "crea un post igual que ha echo arnau")), "", "a truncated title is a prefix of its prompt, whitespace aside");
  assert.equal(subtituloDe(fila("Comprobación diaria de keep-alive de la sesión de Hermes y mucho más texto…", "Comprobación diaria de keep-alive de la sesión")), "", "a last prompt cut shorter than the title is a prefix of it");
  assert.equal(subtituloDe(fila("Título", "<task-notification>x</task-notification>")), "", "injected tags");
  assert.equal(subtituloDe(fila("Título", "This session is being continued from a previous conversation")), "", "continuation summary");
  assert.equal(subtituloDe(fila("Título", "")), "");
});

test("fusionar: an archived agent whose session id and native handle differ is the row of a listing that carries either one", () => {
  for (const handleListado of ["sesion-1", "nativo-1"]) {
    const filas = fusionar({
      recientes: [reciente(handleListado)],
      agentes: [agente({ id: "x", persistence: { sessionId: "sesion-1", nativeHandle: "nativo-1" } })],
      destino,
      canon,
    });
    assert.equal(filas.length, 1, `listed as ${handleListado}: one row, not the session plus a second archived one`);
    assert.equal(filas[0]?.providerHandleId, handleListado, "the row keeps the handle the daemon listed it under");
    assert.equal(filas[0]?.archivada?.agentId, "x");
    assert.equal(filas[0]?.historial, "si");
  }
});

test("fusionar: an archived-only row imports with the native handle, and a live agent hides it through either key", () => {
  const persistencia = { sessionId: "sesion-1", nativeHandle: "nativo-1" };
  const [fila] = fusionar({ recientes: [], agentes: [agente({ id: "x", persistence: persistencia })], destino, canon });
  assert.equal(fila?.providerHandleId, "nativo-1");
  for (const vivaConClave of [{ sessionId: "sesion-1", nativeHandle: null }, { sessionId: "otro", nativeHandle: "nativo-1" }]) {
    const filas = fusionar({
      recientes: [],
      agentes: [agente({ id: "x", persistence: persistencia }), agente({ id: "vivo", archivedAt: null, persistence: vivaConClave })],
      destino,
      canon,
    });
    assert.deepEqual(filas, [], `a live agent with ${JSON.stringify(vivaConClave)} is the same session: importing would fail`);
  }
});

test("fusionar: records of one session that share only one of their keys are one row, and the newest is the one that comes back", () => {
  const filas = fusionar({
    recientes: [],
    agentes: [
      agente({ id: "viejo", archivedAt: "2026-10-01T00:00:00.000Z", persistence: { sessionId: "sesion-1", nativeHandle: "nativo-1" } }),
      agente({ id: "nuevo", archivedAt: "2026-11-01T00:00:00.000Z", persistence: { sessionId: "sesion-1", nativeHandle: null } }),
    ],
    destino,
    canon,
  });
  assert.equal(filas.length, 1);
  assert.equal(filas[0]?.archivada?.agentId, "nuevo");
  const [conRecienteDelViejo] = fusionar({
    recientes: [reciente("nativo-1")],
    agentes: [
      agente({ id: "viejo", archivedAt: "2026-10-01T00:00:00.000Z", persistence: { sessionId: "sesion-1", nativeHandle: "nativo-1" } }),
      agente({ id: "nuevo", archivedAt: "2026-11-01T00:00:00.000Z", persistence: { sessionId: "sesion-1", nativeHandle: null } }),
    ],
    destino,
    canon,
  });
  assert.equal(conRecienteDelViejo?.archivada?.agentId, "nuevo", "the listing carries a key only the older record has: still the same session");
});

test("fusionar: the persisted provider, not the agent's top-level one, is what a session is matched under", () => {
  const filas = fusionar({
    recientes: [reciente("h", { providerId: "codex", providerLabel: "Codex" })],
    agentes: [agente({ id: "x", provider: "claude", persistence: { provider: "codex", sessionId: "h", nativeHandle: null } })],
    destino,
    canon,
  });
  assert.equal(filas.length, 1);
  assert.equal(filas[0]?.providerId, "codex");
  assert.equal(filas[0]?.archivada?.agentId, "x");
  const [sola] = fusionar({
    recientes: [],
    agentes: [agente({ id: "y", provider: "claude", persistence: { provider: "codex", sessionId: "h2", nativeHandle: null } })],
    destino,
    canon,
  });
  assert.equal(sola?.providerId, "codex", "the import is asked under the provider that holds the session");
  const vivo = fusionar({
    recientes: [],
    agentes: [
      agente({ id: "z", provider: "claude", persistence: { provider: "codex", sessionId: "h3", nativeHandle: null } }),
      agente({ id: "z-vivo", provider: "claude", archivedAt: null, persistence: { provider: "codex", sessionId: "h3", nativeHandle: null } }),
    ],
    destino,
    canon,
  });
  assert.deepEqual(vivo, []);
});

test("fusionar: a handle only the live process reports (no persistence) is not restorable: a dead end, and no live twin", () => {
  const filas = fusionar({
    recientes: [],
    agentes: [
      agente({ id: "solo-runtime", persistence: null, runtimeInfo: { sessionId: "r-1" }, title: "Sin persistencia" }),
      // A live agent known only by runtimeInfo is no live twin of the archived one: the daemon does not see it in `persistence`.
      agente({ id: "vivo-runtime", archivedAt: null, persistence: null, runtimeInfo: { sessionId: "s-guardada" } }),
      agente({ id: "guardada", persistence: { sessionId: "s-guardada", nativeHandle: null } }),
    ],
    destino,
    canon,
  });
  const de = (id: string) => filas.find((f) => f.archivada?.agentId === id) as Sesion;
  assert.equal(de("solo-runtime").historial, "no");
  assert.equal(de("solo-runtime").providerHandleId, "");
  assert.equal(restaurable(de("solo-runtime")), false);
  assert.deepEqual(porComprobar(filas).map((p) => p.sessionId), ["s-guardada"], "no handle, nothing to look for");
  assert.equal(de("guardada").historial, "desconocido", "still listed as restorable");
});

// What Paseo's `formatAgentMessage` builds for a message one agent sends another (escaped attributes and text).
const ID_AGENTE = "3d2f9c1e-7a52-4b0e-9d41-0c8d6f2e1a77";
const ID_MENSAJE = "b9a1f0c4-55d2-4d3c-8a10-2f7e9c6d4b88";
const envoltorio = (texto: string, titulo = "Plugin &amp; fixes") =>
  `<paseo-system version="1" kind="agent-message" source-agent-id="${ID_AGENTE}" message-id="${ID_MENSAJE}" source-agent-title="${titulo}">\n${texto}\n</paseo-system>`;

test("desenvuelve: the text of a real agent-message envelope, unescaped; anything else comes back as it was", () => {
  assert.equal(
    desenvuelve(envoltorio("Revisa el &lt;plugin&gt; &amp; dime si &quot;falla&quot; o &apos;no&apos;\n\nGracias")),
    `Revisa el <plugin> & dime si "falla" o 'no'\n\nGracias`,
  );
  assert.equal(desenvuelve("<paseo-system>\nComprobación programada\n</paseo-system>"), "Comprobación programada", "the legacy envelope of schedules");
  assert.equal(desenvuelve(envoltorio("&amp;lt; no es una etiqueta")), "&lt; no es una etiqueta", "one level of escaping, not two");
  assert.equal(desenvuelve("Usa &amp; y <b>negrita</b> tal cual"), "Usa &amp; y <b>negrita</b> tal cual", "plain text keeps its entities");
  assert.equal(desenvuelve("<paseo-systemico>x</paseo-systemico>"), "<paseo-systemico>x</paseo-systemico>", "another tag");
  assert.equal(desenvuelve("antes <paseo-system>x</paseo-system>"), "antes <paseo-system>x</paseo-system>", "only an envelope that opens the text");
});

test("desenvuelve: a truncated envelope still gives its text, and one cut inside the opening tag gives nothing", () => {
  assert.equal(desenvuelve(envoltorio("Hola mundo").replace("\n</paseo-system>", "")), "Hola mundo", "closing tag lost to the cut");
  // The daemon's preview collapses whitespace and keeps 160 characters: a short envelope comes out whole, without newlines.
  const corto = '<paseo-system version="1" kind="agent-message" source-agent-id="a1" message-id="m1">\nHola   mundo\n</paseo-system>';
  const preview = corto.replace(/\s+/g, " ").slice(0, 160);
  assert.equal(desenvuelve(preview), "Hola mundo");
  assert.equal(desenvuelve(preview.slice(0, preview.indexOf("Hola") + 4)), "Hola", "cut in the middle of the text");
  const cortada = envoltorio("Hola mundo").slice(0, 100);
  assert.ok(cortada.startsWith("<paseo-system ") && !cortada.includes(">"));
  assert.equal(desenvuelve(cortada), "", "nothing the user could read");
  assert.equal(desenvuelve("<paseo-system"), "");
  assert.equal(desenvuelve("<paseo-system "), "");
});

test("fusionar: titles and previews of agent-to-agent sessions show the message, not the envelope", () => {
  const mensaje = envoltorio("Arregla el título crudo de las sesiones & avísame");
  const [fila, archivada] = fusionar({
    recientes: [reciente("h", { title: mensaje, firstPromptPreview: mensaje.replace(/\s+/g, " "), lastPromptPreview: envoltorio("ahora el segundo punto") })],
    agentes: [agente({ id: "x", title: envoltorio("Agente archivado con mensaje") })],
    destino,
    canon,
  }) as [Sesion, Sesion];
  assert.equal(fila.titulo, "Arregla el título crudo de las sesiones & avísame");
  assert.equal(fila.resumen, "Arregla el título crudo de las sesiones & avísame · ahora el segundo punto");
  assert.equal(fila.ultimoPrompt, "ahora el segundo punto");
  assert.equal(subtituloDe(fila), "ahora el segundo punto", "the subtitle is the message too");
  assert.equal(archivada.titulo, "Agente archivado con mensaje");
  for (const texto of [fila.titulo, fila.resumen, fila.ultimoPrompt, archivada.titulo]) assert.ok(!texto.includes("<paseo-system"), texto);
});

test("fusionar: an envelope cut inside its opening tag leaves no half tag in the row", () => {
  const cortada = envoltorio("x").slice(0, 100);
  const [fila] = fusionar({
    recientes: [reciente("h", { title: cortada, firstPromptPreview: cortada, lastPromptPreview: cortada })],
    agentes: [],
    destino,
    canon,
  });
  assert.equal(fila?.titulo, "Sin título");
  assert.equal(fila?.resumen, "");
  assert.equal(fila?.ultimoPrompt, "");
});

test("fusionar: a long envelope title is unwrapped first and then cut to two lines' worth", () => {
  const [fila] = fusionar({ recientes: [reciente("h", { title: envoltorio(`palabra `.repeat(500)) })], agentes: [], destino, canon });
  assert.ok(fila?.titulo.startsWith("palabra palabra"));
  assert.ok((fila?.titulo.length ?? 999) <= 160);
  assert.ok(fila?.titulo.endsWith("…"));
});
