import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sesion } from "../shared/contract.ts";
import {
  type AgenteHistorial,
  buscar,
  claveDe,
  conHistorial,
  esDelWorkspace,
  etiquetaArchivada,
  fechaCorta,
  fusionar,
  hace,
  handleDe,
  ordenar,
  porComprobar,
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

test("handleDe prefers the native handle, then the session id, then the runtime session", () => {
  assert.equal(handleDe(agente({ id: "1", persistence: { nativeHandle: "n", sessionId: "s" } })), "n");
  assert.equal(handleDe(agente({ id: "1", persistence: { nativeHandle: null, sessionId: "s" } })), "s");
  assert.equal(handleDe(agente({ id: "1", persistence: null, runtimeInfo: { sessionId: "r" } })), "r");
  assert.equal(handleDe(agente({ id: "1", persistence: null, runtimeInfo: null })), null);
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
