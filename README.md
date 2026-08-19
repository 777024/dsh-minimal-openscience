# dsh-minimal for OpenScience

A plugin that brings the DeepSeek Harness `dsh` minimal mode to [OpenScience](https://github.com/synthetic-sciences/openscience): one-line system prompt plus on-demand capability discovery through `xd`.

DeepSeek models can lose behavior quality without the minimal-prompt treatment. This plugin reduces the system prompt to the exact official DSH sentence:

```
You are a helpful software engineer assistant.
```

It then keeps discovery available through `xd`, so the model can find tools without carrying a bloated system prompt.

## Behavior

Three modes are available:

- `minimal` — one-line system prompt, full native OpenScience tool surface, no tool gating.
- `strict` — one-line system prompt with a narrow allowlist: `bash`, `edit`, `write`, `read`, and `xd`.
- `pro` — two-stage DeepSeek V4 Pro style bootstrap: the first user request is replaced by the one-line warmup prompt with only `bash` + `str_replace_editor`; after the warmup turn, the original request is handed back in a short cooperative frame with `bash`, `str_replace_editor`, `tool_grant`, and `xd`.

Automatic mode selection:

- DeepSeek V4 flash and other ordinary DeepSeek models → `minimal` automatically.
- DeepSeek V4 Pro → `pro` automatically (kept for future use; not the default path with V4 flash).
- Other models → `off`.

`/dsh [off|minimal|strict|pro]` manually overrides the automatic mode and takes priority. Manual mode persists per session.

## Installation

Run from this repository:

```bash
cd /home/ubuntu/dsh-minimal-openscience && bun add @synsci/plugin zod
mkdir -p ~/.config/openscience/command && cp command/dsh.md ~/.config/openscience/command/dsh.md
```

Then edit `~/.config/openscience/openscience.jsonc` and add the plugin at the top level:

```jsonc
{
  "$schema": "https://syntheticsciences.ai/config.json",
  "plugin": [
    "file:///home/ubuntu/dsh-minimal-openscience/dsh-openscience.ts"
  ]
}
```

Restart OpenScience after editing the configuration.

Notes:

- The plugin is referenced by the absolute path above. If you move this repository, update the `plugin` entry in `~/.config/openscience/openscience.jsonc`.
- To uninstall, remove the `plugin` entry and delete `~/.config/openscience/command/dsh.md`.

## Usage

| Command | Effect |
| --- | --- |
| `/dsh` | Toggle off ↔ minimal |
| `/dsh minimal` or `/dsh on` | Enable minimal mode |
| `/dsh strict` | Enable strict mode |
| `/dsh pro` | Enable pro mode |
| `/dsh off` | Disable dsh behavior |

The plugin also registers three tools:

- `xd` — lists DSH capability groups and their OpenScience tool ids (`read xd://`, `read xd://<group>`).
- `tool_grant` — unlocks a tool group (or explicit tool names) after a pro-mode warmup.
- `str_replace_editor` — the official DSH Minimal editing tool with the same schema and semantics.

## Differences from the omp version

- OpenScience does not expose outbound provider payload tool lists to plugin hooks, so the wire-level payload patch that replaced the built-in bash schema is not ported. The model sees OpenScience's native `bash` schema; `str_replace_editor` is plugin-defined and keeps the DSH Minimal schema byte-identical.
- Subagent sessions use the same main-session `chat.message` flow; there is no omp-specific subagent yield contract.
- Pro-mode handoff forwards the original text and file parts; the original parts are kept only in memory during the session, not persisted to disk.

## License

MIT
