# paseo-archivadas

A Paseo plugin: one button in the header of every workspace that lists what you can bring back into it.

- the sessions Paseo's own «Importar sesión» sheet shows for the workspace's directory (provider sessions that are not
  live agents), and
- every **archived Paseo agent** of that workspace (same workspace id, or the same directory after realpath), in
  **yellow** with a badge «Archivada · 6 nov».

Tap a row and the session comes back into *this* workspace and opens. An archived agent returns as the very same agent (same
id, labels and history); a session never imported becomes a new agent. A search box filters by title and prompts, and
«archivada» finds the archived ones. Paseo's native «Importar sesión» button is untouched.

An archived agent whose Claude transcript is no longer on disk (or that never had a provider session) is drawn dimmed with
«sin historial» and cannot be tapped: the daemon cannot resume it.

## Where it shows

- **Desktop / wide window:** the archive icon in the workspace header (next to the agent count, `…` and the side-panel
  icon) opens the list as a popover.
- **Phone:** Paseo 0.12 draws no plugin header buttons in its compact header, so the same list is a workspace panel:
  `+` (new tab) → «Sesiones y archivadas». The command center (`Buscar`) finds it too, on any layout.

## Install

```sh
paseo plugin add git:pocharlies-org/paseo-archivadas
```

Requires Paseo `>=0.11.2`.

## How it works

Paseo's plugin API (`PaseoApi`) does not expose the three daemon calls this needs: the listing of importable sessions
(`fetchRecentProviderSessions`), the agent history with archived agents (`fetchAgentHistory`) and the import
(`importAgent`). The plugin's server side therefore opens a short connection of its own to the local daemon, per request,
like the `paseo` CLI does (`paseo import` is the same `importAgent` call): same host, same password or local credential. It
loads the daemon's own client module from the daemon install instead of bundling a copy, so it always speaks the protocol of
the daemon it runs in.

- The list asks for what the native sheet asks (200 sessions of the directory) and pages the whole agent history of the
  workspace's project to the end.
- A session that is both importable and archived is one row, and the archived record wins. An archived agent whose session
  is running as a live agent is hidden (importing it would fail).
- Transcripts are looked up on the daemon host in `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<encoded-cwd>/<sessionId>.jsonl`,
  then in every project folder. `CLAUDE_CONFIG_DIR` is the one of the Claude provider's `env` in the Paseo `config.json`
  (`agents.providers.claude.env`, what the daemon starts Claude with), else the plugin process's own, else `~/.claude`. Other providers keep their history elsewhere: they are treated as restorable.
- Restoring runs `importAgent({providerId, providerHandleId, cwd, workspaceId})`. The daemon does it atomically (an archived
  agent whose provider cannot resume it is archived again). The row shows the error inline if it fails.

### Limits

- Archived agents the daemon's history does not list (the ones whose workspace was removed) are not marked: their sessions
  still appear in the native list when their transcript exists, unmarked.
- The plugin reads `~/.paseo` (`paseo.pid`, `local-credential`, and from `config.json` only that one `CLAUDE_CONFIG_DIR` value) and the daemon's `PASEO_*` environment to connect; a daemon
  that listens only on a Unix socket is not supported.

## Development

`npm ci --ignore-scripts && npm run typecheck && npm test`. `scripts/deploy.sh` updates the daemon's git checkout of this
repo (the installed plugin) from trunk and reloads it on the local daemon.

MIT licensed.
