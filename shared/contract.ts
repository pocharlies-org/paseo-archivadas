import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Bounds of what the plugin's server accepts: it parses what comes over the RPC before it touches the disk or the daemon, so a
 * client that is not this plugin's own cannot make it walk an unbounded list or hold an unbounded string. Paths are PATH_MAX;
 * ids (workspace, project, provider, session handle) are far shorter than 200 in every provider. A lookup takes at most
 * `MAX_COMPROBACIONES` sessions: the client sends a longer list in batches (`enTandas`).
 */
export const MAX_ID = 200;
export const MAX_RUTA = 4096;
export const MAX_COMPROBACIONES = 500;

const Id = z.string().max(MAX_ID);
const Ruta = z.string().max(MAX_RUTA);

export const Historial = z.enum(["si", "no", "desconocido"]);
export type Historial = z.infer<typeof Historial>;

/**
 * One row of the list: a provider session the workspace could import, or an archived Paseo agent of the workspace.
 * `clave` is the provider plus the session handle, so a session that is both importable and archived is one row.
 */
export const SesionSchema = z.object({
  clave: z.string(),
  providerId: z.string(),
  providerLabel: z.string(),
  providerHandleId: z.string(),
  cwd: z.string(),
  titulo: z.string(),
  /** First and last prompt of the session, joined: what the search looks in. */
  resumen: z.string(),
  /** The last prompt of the session, when the provider says it: the line the row shows under its title. */
  ultimoPrompt: z.string(),
  ultimaActividad: z.string().nullable(),
  /** Set when a Paseo agent of this workspace was archived: importing the session brings that very agent back. */
  archivada: z.object({ agentId: z.string(), archivadaEn: z.string() }).nullable(),
  /** Whether the provider transcript still exists on the daemon host: the daemon cannot resume a session without it (nor an agent that never had one). */
  historial: Historial,
});
export type Sesion = z.infer<typeof SesionSchema>;

/** The importable sessions of a workspace merged with its archived agents, newest first. */
export const archivadasList = defineRpc({
  name: "archivadas.list",
  input: z.object({ workspaceId: Id, cwd: Ruta, projectKey: Id.nullable() }).strict(),
  output: z.object({ sesiones: z.array(SesionSchema), avisos: z.array(z.string()) }),
});

const TranscriptIn = z.object({ provider: Id, sessionId: Id, cwd: Ruta }).strict();
export type TranscriptIn = z.infer<typeof TranscriptIn>;

/** `existe` is null when the provider keeps its history somewhere this plugin cannot look: treat it as restorable. */
const TranscriptOut = z.object({ provider: z.string(), sessionId: z.string(), existe: z.boolean().nullable() });
export type TranscriptOut = z.infer<typeof TranscriptOut>;

export const transcriptsCheck = defineRpc({
  name: "archivadas.transcripts",
  input: z.object({ sesiones: z.array(TranscriptIn).max(MAX_COMPROBACIONES) }).strict(),
  // One answer per session asked, so no more than the question had.
  output: z.object({ resultados: z.array(TranscriptOut).max(MAX_COMPROBACIONES) }),
});

/** Brings a session back into a workspace (the daemon unarchives its agent when it has one) and returns the agent to open. */
export const archivadasRestore = defineRpc({
  name: "archivadas.restaurar",
  input: z.object({ providerId: Id, providerHandleId: Id, cwd: Ruta, workspaceId: Id }).strict(),
  output: z.object({ agentId: z.string() }),
});
