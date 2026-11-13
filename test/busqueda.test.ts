import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import {
  buscarEnTranscripts,
  type DiscoBusqueda,
  discoBusquedaReal,
  fragmentoDe,
  LIMITES,
  type Limites,
  puedeTenerTexto,
  textosDe,
} from "../server/busqueda.ts";

const ID = "1effac8a-1142-48b6-b7eb-24d3fa60013d";
const PROYECTOS = "/home/u/.claude/projects";
const ruta = (carpeta: string, id = ID) => `${PROYECTOS}/${carpeta}/${id}.jsonl`;

/** A fake disk holding transcripts as their lines: `lineas` honours the byte limit like the real one. */
function discoFalso(ficheros: Record<string, readonly string[]>): DiscoBusqueda & { leidos: string[] } {
  const leidos: string[] = [];
  const texto = (r: string) => (ficheros[r] ?? []).join("\n");
  return {
    env: {},
    home: "/home/u",
    leidos,
    lee: () => null,
    existe: async (r) => r in ficheros,
    lista: async (r) => [...new Set(Object.keys(ficheros).filter((f) => f.startsWith(`${r}/`)).map((f) => f.slice(r.length + 1).split("/")[0] as string))],
    tamano: async (r) => (r in ficheros ? Buffer.byteLength(texto(r)) : null),
    async *lineas(r, maxBytes, maxLinea, sirve) {
      leidos.push(r);
      const cortado = Buffer.from(texto(r)).subarray(0, maxBytes).toString("utf8");
      for (const linea of cortado.split("\n")) {
        if (Buffer.byteLength(linea) <= maxLinea && (!sirve || sirve(Buffer.from(linea)))) yield linea;
      }
    },
  };
}

const usuario = (content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "user", message: { role: "user", content }, ...extra });
const asistente = (content: unknown) => JSON.stringify({ type: "assistant", message: { role: "assistant", content } });
const sesion = (sessionId = ID, provider = "claude", cwd = "/work/proyecto") => ({ provider, sessionId, cwd });

test("textosDe: string content and text blocks of user and assistant entries, nothing else", () => {
  assert.deepEqual(textosDe(JSON.parse(usuario("hola mundo"))), ["hola mundo"]);
  assert.deepEqual(
    textosDe(JSON.parse(asistente([{ type: "thinking", thinking: "pienso SECRETO" }, { type: "text", text: "respuesta" }, { type: "tool_use", name: "Bash", input: { command: "rm -rf" } }]))),
    ["respuesta"],
  );
  assert.deepEqual(textosDe(JSON.parse(usuario([{ type: "tool_result", tool_use_id: "t", content: "salida de herramienta" }]))), [], "a user entry that is only tool results");
  assert.deepEqual(textosDe(JSON.parse(usuario([{ type: "image", source: {} }, { type: "text", text: "mira esto" }]))), ["mira esto"]);
  assert.deepEqual(textosDe(JSON.parse(usuario("caveat inyectado", { isMeta: true }))), [], "meta entries Claude Code injects");
  for (const otro of [{ type: "system", content: "x" }, { type: "attachment", message: { content: "x" } }, { type: "summary", summary: "x" }, null, "x", [1]]) {
    assert.deepEqual(textosDe(otro), [], JSON.stringify(otro));
  }
});

test("puedeTenerTexto prunes only lines that cannot hold message text", () => {
  const puede = (linea: string) => puedeTenerTexto(Buffer.from(linea));
  assert.equal(puede(usuario("hola")), true);
  assert.equal(puede(asistente([{ type: "tool_use", name: "x", input: {} }])), true, "assistant lines are parsed");
  assert.equal(puede(usuario([{ type: "tool_result", tool_use_id: "t", content: "salida" }])), false, "only tool output");
  assert.equal(puede(usuario([{ type: "tool_result", tool_use_id: "t", content: "x" }, { type: "text", text: "y" }])), true, "tool output plus text");
  assert.equal(puede(usuario('dice "type":"tool_result" en el texto')), true, "the token inside a string has its quotes escaped");
  for (const otra of [JSON.stringify({ type: "attachment", attachment: { role: "user" } }), JSON.stringify({ type: "system", content: "assistant" }), "{roto"]) {
    assert.equal(puede(otra), false, otra);
  }
});

test("fragmentoDe: ~120 characters around the first hit, one line, with ellipses and the original accents", () => {
  const largo = `${"a".repeat(200)} Configuración\n\n  del   clúster ${"b".repeat(200)}`;
  const fragmento = fragmentoDe(largo, "configuracion");
  assert.ok(fragmento.startsWith("…") && fragmento.endsWith("…"), fragmento);
  assert.ok(fragmento.includes("Configuración del clúster"), fragmento);
  assert.ok(!fragmento.includes("\n"));
  assert.ok(fragmento.length <= 122, `${fragmento.length}`);
  assert.equal(fragmentoDe("corto con hit", "hit"), "corto con hit", "no ellipses when nothing was cut");
  assert.equal(fragmentoDe("😀".repeat(100) + " ÁRBOL", "arbol").endsWith("ÁRBOL"), true, "emoji before the hit do not split surrogate pairs");
});

test("matches ignore case and accents, and count the messages with a hit", async () => {
  const disco = discoFalso({
    [ruta("-work-proyecto")]: [usuario("¿Cómo va la MIGRACIÓN?"), asistente([{ type: "text", text: "La migracion va bien" }]), asistente([{ type: "text", text: "otra cosa" }])],
  });
  const [r] = await buscarEnTranscripts(disco, "migración", [sesion()]);
  assert.deepEqual(r, { provider: "claude", sessionId: ID, buscable: true, coincidencias: 2, fragmento: "¿Cómo va la MIGRACIÓN?", parcial: false });
  const [sinAcento] = await buscarEnTranscripts(disco, "MIGRACION", [sesion()]);
  assert.equal(sinAcento?.coincidencias, 2);
});

test("every word must appear in the session (not necessarily in one message)", async () => {
  const disco = discoFalso({ [ruta("-work-proyecto")]: [usuario("despliegue en flux"), asistente("revisa el helmfile")] });
  const [ambas] = await buscarEnTranscripts(disco, "flux helmfile", [sesion()]);
  assert.equal(ambas?.coincidencias, 2);
  assert.equal(ambas?.fragmento, "despliegue en flux", "around the first word");
  const [falta] = await buscarEnTranscripts(disco, "flux terraform", [sesion()]);
  assert.deepEqual(falta, { provider: "claude", sessionId: ID, buscable: true, coincidencias: 0, fragmento: null, parcial: false });
});

test("tool calls, tool results and thinking are never searched", async () => {
  const disco = discoFalso({
    [ruta("-work-proyecto")]: [
      asistente([{ type: "tool_use", id: "t", name: "Bash", input: { command: "kubectl get secretos" } }]),
      usuario([{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "secretos listados" }] }]),
      asistente([{ type: "thinking", thinking: "los secretos" }]),
    ],
  });
  const [r] = await buscarEnTranscripts(disco, "secretos", [sesion()]);
  assert.equal(r?.coincidencias, 0);
});

test("malformed lines are skipped and the rest is still searched", async () => {
  const disco = discoFalso({ [ruta("-work-proyecto")]: ["{no es json", '{"type":"user","message":', "", usuario("aguja en el pajar")] });
  const [r] = await buscarEnTranscripts(disco, "aguja", [sesion()]);
  assert.equal(r?.coincidencias, 1);
  assert.equal(r?.parcial, false);
});

test("a transcript past the byte limit is read up to it and marked parcial", async () => {
  const lineas = [usuario("al principio aguja"), ...Array.from({ length: 50 }, () => asistente("relleno")), usuario("al final aguja")];
  const disco = discoFalso({ [ruta("-work-proyecto")]: lineas });
  const limites: Limites = { ...LIMITES, maxBytes: 400 };
  const [r] = await buscarEnTranscripts(disco, "aguja", [sesion()], limites);
  assert.equal(r?.parcial, true);
  assert.equal(r?.coincidencias, 1, "only the hit inside the first 400 bytes");
  const [entero] = await buscarEnTranscripts(disco, "aguja", [sesion()]);
  assert.deepEqual([entero?.parcial, entero?.coincidencias], [false, 2]);
});

test("the time budget stops the search: what was not read is parcial", async () => {
  const disco = discoFalso({ [ruta("-a", "uno")]: [usuario("aguja")], [ruta("-a", "dos")]: [usuario("aguja")] });
  let reloj = 0;
  // Each call to the clock advances it a second, against a one-second budget: the first file starts, nothing else does.
  const ahora = () => (reloj += 1_000);
  const resultados = await buscarEnTranscripts(disco, "aguja", [sesion("uno"), sesion("dos")], { ...LIMITES, presupuestoMs: 1_500, concurrencia: 1 }, ahora);
  assert.deepEqual(resultados.map((r) => r.parcial), [true, true]);
  assert.ok(disco.leidos.length <= 1);
});

test("other providers are not searchable and nothing is read for them", async () => {
  const disco = discoFalso({});
  const [r] = await buscarEnTranscripts(disco, "aguja", [sesion("abc", "codex")]);
  assert.deepEqual(r, { provider: "codex", sessionId: "abc", buscable: false, coincidencias: 0, fragmento: null, parcial: false });
  assert.deepEqual(disco.leidos, []);
});

test("an invalid session id or a missing transcript is not searchable, and nothing outside the projects folder is read", async () => {
  const disco = discoFalso({ "/home/u/.claude/secreto.jsonl": [usuario("aguja")] });
  for (const sessionId of ["../../secreto", "a/b", ".hidden", "no-existe"]) {
    const [r] = await buscarEnTranscripts(disco, "aguja", [sesion(sessionId)]);
    assert.deepEqual([r?.buscable, r?.coincidencias], [false, 0], sessionId);
  }
  assert.deepEqual(disco.leidos, []);
});

test("the transcript is found in another project folder, results keep the input order, and nothing is logged", async () => {
  const disco = discoFalso({
    [ruta("-otro-nombre", "uno")]: [usuario("aguja SECRETO")],
    [ruta("-work-proyecto", "dos")]: [usuario("nada")],
    [ruta("-work-proyecto", "tres")]: [asistente([{ type: "text", text: "aguja" }])],
  });
  const consola = (["log", "info", "warn", "error", "debug"] as const).map((nivel) => mock.method(console, nivel, () => undefined));
  try {
    const resultados = await buscarEnTranscripts(disco, "aguja", [sesion("uno"), sesion("dos"), sesion("x", "codex"), sesion("tres")]);
    assert.deepEqual(
      resultados.map((r) => [r.sessionId, r.buscable, r.coincidencias]),
      [["uno", true, 1], ["dos", true, 0], ["x", false, 0], ["tres", true, 1]],
    );
    assert.deepEqual(consola.map((m) => m.mock.callCount()), [0, 0, 0, 0, 0]);
  } finally {
    for (const m of consola) m.mock.restore();
  }
});

test("the real disk: streams the file, honours the byte and line limits, skips a cut last line", async () => {
  const raiz = await mkdtemp(join(tmpdir(), "archivadas-busqueda-"));
  try {
    const paseo = join(raiz, "paseo-home");
    await mkdir(paseo);
    await mkdir(join(raiz, "projects", "-work-proyecto"), { recursive: true });
    const enorme = usuario("x".repeat(5_000));
    const lineas = [usuario("Búsqueda número uno"), enorme, "{roto", asistente([{ type: "text", text: "busqueda dos" }]), usuario("busqueda tres")];
    await writeFile(join(raiz, "projects", "-work-proyecto", `${ID}.jsonl`), `${lineas.join("\n")}\n`);
    const disco: DiscoBusqueda = { ...discoBusquedaReal, env: { CLAUDE_CONFIG_DIR: raiz, PASEO_HOME: paseo } };

    const [entero] = await buscarEnTranscripts(disco, "BUSQUEDA", [sesion()]);
    assert.deepEqual([entero?.coincidencias, entero?.parcial, entero?.fragmento], [3, false, "Búsqueda número uno"]);

    const leidas: string[] = [];
    for await (const linea of discoBusquedaReal.lineas(join(raiz, "projects", "-work-proyecto", `${ID}.jsonl`), 1_000_000, 1_000)) leidas.push(linea);
    assert.equal(leidas.length, 4, "the 5 kB line is skipped by the 1 kB line limit");
    assert.ok(!leidas.includes(enorme));
    const fichero = join(raiz, "projects", "-work-proyecto", `${ID}.jsonl`);
    const soloAsistente: string[] = [];
    for await (const linea of discoBusquedaReal.lineas(fichero, 1_000_000, 1_000_000, (l) => l.includes('"type":"assistant"'))) soloAsistente.push(linea);
    assert.deepEqual(soloAsistente, [lineas[3]], "only the lines holding a marker are returned");
    // Lines that span several read chunks come back whole.
    const largas = Array.from({ length: 3 }, (_, n) => usuario(`${n} ${"ñ".repeat(800_000)}`));
    const grande = join(raiz, "grande.jsonl");
    await writeFile(grande, largas.join("\n"));
    const leidasGrandes: string[] = [];
    for await (const linea of discoBusquedaReal.lineas(grande, 64 * 1024 * 1024, 16 * 1024 * 1024)) leidasGrandes.push(linea);
    assert.deepEqual(leidasGrandes, largas, "no trailing newline: the last line still counts");

    // The first line and part of the second fit: the second is cut, does not parse, and is skipped.
    const corte = Buffer.byteLength(lineas[0] as string) + 20;
    const [cortado] = await buscarEnTranscripts(disco, "busqueda", [sesion()], { ...LIMITES, maxBytes: corte });
    assert.deepEqual([cortado?.coincidencias, cortado?.parcial], [1, true]);
  } finally {
    await rm(raiz, { recursive: true, force: true });
  }
});
