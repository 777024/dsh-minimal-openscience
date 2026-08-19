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

Clone or copy this repository anywhere, then run from the repository root:

```bash
cd /path/to/dsh-minimal-openscience
bun add @synsci/plugin zod
mkdir -p ~/.config/openscience/command
cp command/dsh.md ~/.config/openscience/command/dsh.md
```

Then edit `~/.config/openscience/openscience.jsonc` and add the plugin at the top level. Use the absolute path to `dsh-openscience.ts` in your clone:

```jsonc
{
  "$schema": "https://syntheticsciences.ai/config.json",
  "plugin": [
    "file:///absolute/path/to/dsh-minimal-openscience/dsh-openscience.ts"
  ]
}
```

To print the exact `file://` URL for your current directory, run:

```bash
echo "file://$(pwd)/dsh-openscience.ts"
```

Restart OpenScience after editing the configuration.

Notes:

- OpenScience resolves `file://` plugin entries from the absolute path, so the path must point at your actual clone location.
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

## Fix notes

- [compute_job schema 修复记录](COMPUTE_JOB_SCHEMA_FIX.md) — documents the OpenScience `compute_job` schema fix, the patched binary build/install steps, and verification results.

## License

MIT
