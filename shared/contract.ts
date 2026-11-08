import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

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
  input: z.object({ workspaceId: z.string(), cwd: z.string(), projectKey: z.string().nullable() }).strict(),
  output: z.object({ sesiones: z.array(SesionSchema), avisos: z.array(z.string()) }),
});

const TranscriptIn = z.object({ provider: z.string(), sessionId: z.string(), cwd: z.string() }).strict();
export type TranscriptIn = z.infer<typeof TranscriptIn>;

/** `existe` is null when the provider keeps its history somewhere this plugin cannot look: treat it as restorable. */
const TranscriptOut = z.object({ provider: z.string(), sessionId: z.string(), existe: z.boolean().nullable() });
export type TranscriptOut = z.infer<typeof TranscriptOut>;

export const transcriptsCheck = defineRpc({
  name: "archivadas.transcripts",
  input: z.object({ sesiones: z.array(TranscriptIn) }).strict(),
  output: z.object({ resultados: z.array(TranscriptOut) }),
});

/** Brings a session back into a workspace (the daemon unarchives its agent when it has one) and returns the agent to open. */
export const archivadasRestore = defineRpc({
  name: "archivadas.restaurar",
  input: z.object({ providerId: z.string(), providerHandleId: z.string(), cwd: z.string(), workspaceId: z.string() }).strict(),
  output: z.object({ agentId: z.string() }),
});
