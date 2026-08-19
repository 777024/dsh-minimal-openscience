/**
 * DSH-style minimal mode for OpenScience.
 *
 * This is the OpenScience port of `dsh-minimal.ts`. It keeps the omp plugin
 * untouched and provides the same minimal/strict/pro behavior through
 * OpenScience's plugin hooks:
 *
 * - `experimental.chat.system.transform` replaces the system prompt with the
 *   official DSH Minimal one-liner.
 * - `chat.message` writes per-user-message tool gating before the message is
 *   persisted. It also intercepts the first pro-mode user request and replaces
 *   it with the DSH Minimal warmup prompt.
 * - `event` watches for `session.idle` after the bootstrap warmup and posts
 *   the original request through the local HTTP prompt_async endpoint with a
 *   cooperative handoff.
 * - `command.execute.before` implements `/dsh [off|minimal|strict|pro]`.
 * - The plugin registers `str_replace_editor`, `tool_grant`, and `xd` tools.
 *
 * Only `node:fs`, `node:path`, `node:os`, and `@synsci/plugin` are used.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative, resolve } from "node:path"
import { tool, type Hooks, type Plugin, type PluginInput } from "@synsci/plugin"

// ---- constants copied byte-for-byte from dsh-minimal.ts -------------------

const MINIMAL_SYSTEM = "You are a helpful software engineer assistant."
const WARMUP_PROMPT = MINIMAL_SYSTEM
const PRO_EDITOR = "str_replace_editor"

/** The official DSH Minimal first-request tool names. */
const PRO_BOOTSTRAP_TOOLS = ["bash", PRO_EDITOR]

/** Resident tool set after warmup: Minimal pair + the on-demand unlock tool. */
const PRO_RESIDENT_TOOLS = ["bash", PRO_EDITOR, "tool_grant"]
const TOOL_GRANT_NAME = "tool_grant"
const HANDOFF_PREFIX =
  "We need to handle the following request together.\n\nCurrently available: bash, str_replace_editor, tool_grant.\nIf you need any other tools, call tool_grant first to discover and unlock them.\n\n"

// ---- OpenScience tool groups (ids verified against backend/cli/src/tool) ---

const TOOL_GROUPS: Record<string, string[]> = {
  files: ["read", "write", "edit", "multiedit", "glob", "grep", "list", "bash", "apply_patch"],
  code: ["lsp", "codesearch", "notebook"],
  subagent: ["task"],
  research: ["webfetch", "websearch"],
  project: ["todowrite", "todoread", "batch"],
}

const SHORT_DESCRIPTIONS: Record<string, string> = {
  read: "Read files, directories, archives, databases, documents, and URLs.",
  write: "Create or overwrite a file.",
  edit: "Edit a file via string replacement.",
  multiedit: "Apply multiple edits to a file.",
  glob: "Glob files and directories with pattern matching.",
  grep: "Search file contents with regex.",
  list: "List directory contents.",
  bash: "Run shell commands in a persistent shell.",
  apply_patch: "Apply a unified patch to multiple files.",
  lsp: "Query language server operations.",
  codesearch: "Search external code and library documentation.",
  notebook: "Run Python code in a persistent notebook kernel.",
  task: "Delegate work to background subagents.",
  webfetch: "Fetch a URL as text, markdown, or HTML.",
  websearch: "Search the web for current information.",
  todowrite: "Write the current todo list.",
  todoread: "Read the current todo list.",
  batch: "Run multiple tool calls in parallel.",
}

type Mode = "off" | "minimal" | "strict" | "pro"

interface SessionState {
  mode: Mode
  manual: boolean
  phase?: "bootstrap" | "promoted"
  granted: string[]
  warmupPrompt?: string
  warmupParts?: unknown[]
  expectSynthetic?: boolean
}

// ---- persistent state ------------------------------------------------------

const STATE_DIR = join(homedir(), ".openscience", "dsh-minimal")
const STATE_FILE = join(STATE_DIR, "state.json")
const state = new Map<string, SessionState>()
let serverUrl: URL | undefined

function normalizeState(value: unknown): SessionState | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const mode = typeof record.mode === "string" && ["off", "minimal", "strict", "pro"].includes(record.mode)
    ? (record.mode as Mode)
    : undefined
  if (!mode) return undefined
  return {
    mode,
    manual: record.manual === true,
    phase: record.phase === "bootstrap" || record.phase === "promoted" ? record.phase : undefined,
    granted: Array.isArray(record.granted) ? record.granted.filter((x): x is string => typeof x === "string") : [],
    warmupPrompt: typeof record.warmupPrompt === "string" ? record.warmupPrompt : undefined,
    expectSynthetic: record.expectSynthetic === true,
  }
}

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return
    const parsed: unknown = JSON.parse(readFileSync(STATE_FILE, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return
    for (const [sessionID, value] of Object.entries(parsed as Record<string, unknown>)) {
      const normalized = normalizeState(value)
      if (normalized) state.set(sessionID, normalized)
    }
  } catch {
    // A corrupt/partial state file should never prevent the plugin from loading.
  }
}

function saveState() {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    const output: Record<string, unknown> = {}
    for (const [sessionID, value] of state) {
      output[sessionID] = {
        mode: value.mode,
        manual: value.manual,
        phase: value.phase,
        granted: value.granted,
        warmupPrompt: value.warmupPrompt,
        expectSynthetic: value.expectSynthetic,
      }
    }
    writeFileSync(STATE_FILE, JSON.stringify(output, null, 2))
  } catch {
    // Persistence is best-effort; runtime behavior continues without it.
  }
}

function setState(sessionID: string, value: SessionState) {
  state.set(sessionID, value)
  saveState()
}

function getOrCreateState(sessionID: string): SessionState {
  const existing = state.get(sessionID)
  if (existing) return existing
  const created: SessionState = { mode: "off", manual: false, granted: [] }
  setState(sessionID, created)
  return created
}

loadState()

// ---- model detection and mode resolution -----------------------------------

function modelHaystack(model: unknown): string {
  const values: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      values.push(value)
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item)
    } else if (value !== null && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) visit(item)
    }
  }
  visit(model)
  return values.join(" ").toLowerCase()
}

function isDeepSeekV4Pro(model: unknown): boolean {
  const haystack = modelHaystack(model)
  return haystack.includes("deepseek") && haystack.includes("v4") && haystack.includes("pro")
}

function isDeepSeekModel(model: unknown): boolean {
  return modelHaystack(model).includes("deepseek")
}

function autoMode(model: unknown): Mode {
  if (isDeepSeekV4Pro(model)) return "pro"
  if (isDeepSeekModel(model)) return "minimal"
  return "off"
}

function resolveMode(sessionID: string, model: unknown): Mode {
  const existing = state.get(sessionID)
  if (existing?.manual) return existing.mode

  if (modelHaystack(model).length === 0) {
    // Model unknown (e.g. the chat.message hook fires before the model is
    // resolved). Keep the current mode instead of resetting it to off.
    return existing?.mode ?? "off"
  }

  const mode = autoMode(model)
  if (!existing) {
    const created: SessionState = {
      mode,
      manual: false,
      granted: [],
      phase: mode === "pro" ? "bootstrap" : undefined,
    }
    setState(sessionID, created)
    return mode
  }

  if (existing.mode !== mode) {
    existing.mode = mode
    existing.manual = false
    existing.phase = mode === "pro" ? "bootstrap" : undefined
    existing.warmupPrompt = undefined
    existing.warmupParts = undefined
    if (mode === "pro") existing.expectSynthetic = undefined
    saveState()
  }
  return existing.mode
}

function parseMode(args: string, current: Mode): Mode {
  const value = args.trim().toLowerCase()
  if (value === "off") return "off"
  if (value === "on" || value === "minimal") return "minimal"
  if (value === "strict") return "strict"
  if (value === "pro") return "pro"
  return current === "off" ? "minimal" : "off"
}

function modeNotice(mode: Mode): string {
  if (mode === "minimal")
    return `dsh-minimal enabled (minimal): discovery protocol active, system prompt is "${MINIMAL_SYSTEM.slice(0, 60)}…"`
  if (mode === "strict")
    return `dsh-minimal strict: only bash/edit/write/read, discovery protocol active, system prompt is "${MINIMAL_SYSTEM.slice(0, 60)}…"`
  if (mode === "pro")
    return `dsh-minimal pro: warmup "${WARMUP_PROMPT}" runs with ${PRO_BOOTSTRAP_TOOLS.join(" + ")}, then the original prompt runs with ${PRO_RESIDENT_TOOLS.join(" + ")} and a cooperative handoff`
  return "dsh-minimal disabled: default system prompt and tool descriptions restored"
}

// ---- tool gating maps ------------------------------------------------------

const BOOTSTRAP_TOOLS: Record<string, boolean> = {
  "*": false,
  bash: true,
  str_replace_editor: true,
}

function promotedTools(granted: string[]): Record<string, boolean> {
  const tools: Record<string, boolean> = {
    "*": false,
    bash: true,
    str_replace_editor: true,
    tool_grant: true,
    xd: true,
  }
  for (const name of granted) tools[name] = true
  return tools
}

const STRICT_TOOLS: Record<string, boolean> = {
  "*": false,
  bash: true,
  edit: true,
  write: true,
  read: true,
  xd: true,
}

// ---- hooks -----------------------------------------------------------------

async function onSystemTransform(
  input: { sessionID?: string; model: unknown },
  output: { system: string[] },
): Promise<void> {
  const sessionID = input.sessionID ?? ""
  const mode = resolveMode(sessionID, input.model)
  if (mode === "off") return
  output.system.splice(0, output.system.length, MINIMAL_SYSTEM)
}

type TextLikePart = { type: "text"; text?: string; synthetic?: boolean }
type FileLikePart = { type: "file"; url?: string; mime?: string; filename?: string }

function cloneParts(parts: unknown[]): unknown[] {
  return JSON.parse(JSON.stringify(parts)) as unknown[]
}

async function onChatMessage(
  input: { sessionID: string; model?: unknown },
  output: { message: { model?: unknown; tools?: Record<string, boolean> }; parts: unknown[] },
): Promise<void> {
  const sessionID = input.sessionID
  // The chat.message hook fires before the model is resolved, so input.model
  // is undefined here. The user message itself carries the model that will be
  // used for the reply; fall back to it for mode detection.
  resolveMode(sessionID, input.model ?? output.message.model)
  const current = state.get(sessionID)
  if (!current || current.mode === "off") {
    if (current?.expectSynthetic) {
      current.expectSynthetic = false
      saveState()
    }
    return
  }

  // A plugin-sent synthetic message (command expansion, handoff, tool_grant
  // unlock) must only update the tool gate, never be mistaken for a real user
  // request or trigger a new warmup.
  if (current.expectSynthetic === true) {
    current.expectSynthetic = false
    if (current.mode === "pro") {
      output.message.tools = current.phase === "bootstrap" ? BOOTSTRAP_TOOLS : promotedTools(current.granted)
    } else if (current.mode === "strict") {
      output.message.tools = STRICT_TOOLS
    }
    saveState()
    return
  }
  if (current.mode === "pro") {
    if (!current.warmupPrompt) {
      // First real user request: stash the original parts in memory, replace
      // the persisted transcript with the one-line warmup prompt, and expose
      // only the DSH Minimal bootstrap tool pair.
      const originalParts = cloneParts(output.parts)
      const nonSyntheticTexts = originalParts
        .filter((part): part is TextLikePart => {
          const candidate = part as TextLikePart
          return candidate?.type === "text" && candidate.synthetic !== true && typeof candidate.text === "string"
        })
        .map((part) => part.text ?? "")
      current.warmupParts = originalParts
      current.warmupPrompt = nonSyntheticTexts.join("\n\n")
      current.phase = "bootstrap"

      const firstTextIndex = (output.parts as TextLikePart[]).findIndex((part) => part.type === "text")
      if (firstTextIndex >= 0) {
        const first = output.parts[firstTextIndex] as TextLikePart
        first.text = WARMUP_PROMPT
        output.parts.splice(0, output.parts.length, first)
      } else {
        output.parts.splice(0, output.parts.length, { type: "text", text: WARMUP_PROMPT })
      }
      output.message.tools = BOOTSTRAP_TOOLS
      saveState()
      return
    }

    if (current.phase === "promoted") {
      output.message.tools = promotedTools(current.granted)
      saveState()
      return
    }

    // A real user message arrived before the bootstrap finished (race or a
    // restart residue). Drop the stale warmup and promote immediately.
    current.warmupPrompt = undefined
    current.warmupParts = undefined
    current.phase = "promoted"
    output.message.tools = promotedTools(current.granted)
    saveState()
    return
  }

  if (current.mode === "strict") {
    output.message.tools = STRICT_TOOLS
    saveState()
    return
  }

  // minimal: no gating; leave the full native tool surface enabled.
}

async function onEvent(
  input: { event: unknown },
  serverUrl: URL,
): Promise<void> {
  if (typeof input.event !== "object" || input.event === null) return
  const event = input.event as { type?: string; sessionID?: string }
  if (event.type !== "session.idle" || typeof event.sessionID !== "string") return

  const current = state.get(event.sessionID)
  if (!current || current.mode !== "pro" || current.phase !== "bootstrap" || !current.warmupPrompt) return

  current.phase = "promoted"
  current.expectSynthetic = true
  const prompt = current.warmupPrompt
  const fileParts = (current.warmupParts ?? [])
    .filter((part): part is FileLikePart => {
      const candidate = part as FileLikePart
      return candidate?.type === "file" && typeof candidate.url === "string"
    })
    .map((part) => ({
      type: "file" as const,
      url: part.url as string,
      mime: part.mime as string,
      filename: part.filename,
    }))
  current.warmupPrompt = undefined
  current.warmupParts = undefined
  saveState()

  const parts: unknown[] = [{ type: "text", text: HANDOFF_PREFIX + prompt }]
  parts.push(...fileParts)

  const url = new URL(`session/${event.sessionID}/prompt_async`, serverUrl)
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts }),
    })
  } catch {
    // The host session will surface the handoff failure; state is already
    // promoted so a future real message continues with the resident tools.
  }
}

async function onCommandBefore(
  input: { command: string; sessionID: string; arguments: string },
  output: { parts: { type: string; text?: string }[] },
): Promise<void> {
  if (input.command !== "dsh") return

  const current = getOrCreateState(input.sessionID)
  const next = parseMode(input.arguments, current.mode)
  current.mode = next
  current.manual = true
  current.expectSynthetic = true
  if (next === "off" || next === "minimal" || next === "strict") {
    current.phase = undefined
    current.warmupPrompt = undefined
    current.warmupParts = undefined
  }
  if (next === "pro" && !current.phase) current.phase = "bootstrap"
  saveState()

  const notice = modeNotice(next)
  const existing = output.parts.find((part) => part.type === "text")
  if (existing) {
    existing.text = notice
  } else {
    output.parts.push({ type: "text", text: notice })
  }
}

// ---- plugin tools ----------------------------------------------------------

const z = tool.schema

const STR_REPLACE_EDITOR_DESCRIPTION = `Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\``

function editorPath(cwd: string, path: string): string {
  const target = resolve(cwd, path)
  const root = resolve(cwd)
  const rel = relative(root, target)
  if (rel.startsWith("..") || rel.includes(":")) throw new Error("path must stay inside the current workspace")
  return target
}

function executeEditor(
  params: {
    command: string
    path: string
    file_text?: string
    insert_line?: number
    new_str?: string
    old_str?: string
    view_range?: number[]
  },
  cwd: string,
): string {
  const path = editorPath(cwd, params.path)
  if (params.command === "view") {
    const body = readFileSync(path, "utf8")
    const lines = body.split(/\r?\n/)
    let selected = lines
    if (Array.isArray(params.view_range) && params.view_range.length >= 2) {
      const start = params.view_range[0]
      const end = params.view_range[1]
      const startIdx = Math.max(0, start - 1)
      const endIdx = end === -1 ? lines.length : Math.min(lines.length, end)
      selected = lines.slice(startIdx, endIdx)
    }
    return selected.map((line, index) => `${String(index + 1).padStart(4)}  ${line}`).join("\n")
  }
  if (params.command === "create") {
    if (params.file_text === undefined) throw new Error("file_text is required for create")
    mkdirSync(resolve(path, ".."), { recursive: true })
    writeFileSync(path, params.file_text)
    return `Created ${params.path}`
  }
  const body = readFileSync(path, "utf8")
  if (params.command === "str_replace") {
    if (params.old_str === undefined || params.new_str === undefined)
      throw new Error("old_str and new_str are required for str_replace")
    const count = body.split(params.old_str).length - 1
    if (count !== 1) throw new Error(`old_str must match exactly once; found ${count}`)
    writeFileSync(path, body.replace(params.old_str, params.new_str))
    return `Updated ${params.path}`
  }
  if (params.insert_line === undefined || params.new_str === undefined)
    throw new Error("insert_line and new_str are required for insert")
  const lines = body.split(/\r?\n/)
  lines.splice(Math.max(0, params.insert_line - 1), 0, params.new_str)
  writeFileSync(path, lines.join("\n"))
  return `Updated ${params.path}`
}

const str_replace_editor = tool({
  description: STR_REPLACE_EDITOR_DESCRIPTION,
  args: {
    command: z.enum(["view", "create", "str_replace", "insert"]),
    path: z.string(),
    file_text: z.string().optional(),
    insert_line: z.number().int().optional(),
    new_str: z.string().optional(),
    old_str: z.string().optional(),
    view_range: z.array(z.number()).optional(),
  },
  async execute(args, context) {
    return executeEditor(
      {
        command: args.command,
        path: args.path,
        file_text: args.file_text,
        insert_line: args.insert_line,
        new_str: args.new_str,
        old_str: args.old_str,
        view_range: args.view_range,
      },
      context.directory,
    )
  },
})

const tool_grant = tool({
  description:
    "Unlock additional OpenScience tools after the DSH Minimal bootstrap. Pass a tool group name or explicit tool names. After unlocking, the current session's tool gate is updated immediately.",
  args: {
    group: z.enum(Object.keys(TOOL_GROUPS) as [string, ...string[]]).optional(),
    tools: z.array(z.string()).optional(),
  },
  async execute(args, context) {
    const names = args.group ? TOOL_GROUPS[args.group] : args.tools ?? []
    if (names.length === 0) throw new Error("tool_grant requires either a group or at least one tool name")

    const current = getOrCreateState(context.sessionID)
    current.granted = Array.from(new Set([...current.granted, ...names]))
    current.expectSynthetic = true
    saveState()

    if (!serverUrl) throw new Error("plugin server URL is not initialized")
    const url = new URL(`session/${context.sessionID}/prompt_async`, serverUrl)
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ type: "text", text: `(dsh tool_grant unlocked: ${names.join(", ")})` }],
        }),
      })
    } catch {
      // The unlock is recorded; the next user turn will still see it via
      // persisted state if the synthetic prompt could not be posted.
    }

    const available = [...new Set([...PRO_RESIDENT_TOOLS, ...current.granted])]
    return `Unlocked ${names.join(", ")}; currently available: ${available.join(", ")}`
  },
})

const xd = tool({
  description:
    "Discover DSH capability groups. Use read xd:// for the group directory, read xd://<group> for a group's tools, or read xd://<tool> to inspect a tool.",
  args: {
    device: z.string().optional(),
  },
  async execute(args) {
    const directory = Object.entries(TOOL_GROUPS)
      .map(([group, tools]) => `- ${group}: ${tools.join(", ")}`)
      .join("\n")
    const intro =
      "DSH discovery protocol active. Read xd:// for this directory, xd://<group> for a group's tools. " +
      "Skills are loaded with the native skill tool as needed. To unlock a group, call tool_grant with its group name."

    if (!args.device) return `${intro}\n\n${directory}`
    if (args.device in TOOL_GROUPS) {
      const tools = TOOL_GROUPS[args.device]
      const details = tools.map((name) => `- ${name}: ${SHORT_DESCRIPTIONS[name] ?? "OpenScience tool"}`).join("\n")
      return `Device ${args.device}:\n${details}`
    }
    return `Unknown device: ${args.device}. Available devices:\n${Object.keys(TOOL_GROUPS)
      .map((group) => `- ${group}`)
      .join("\n")}`
  },
})

// ---- plugin export ---------------------------------------------------------

export const DshOpenscience: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const baseUrl = input.serverUrl
  serverUrl = baseUrl
  return {
    event: (eventInput) => onEvent(eventInput, baseUrl),
    "experimental.chat.system.transform": onSystemTransform,
    "chat.message": onChatMessage,
    "command.execute.before": onCommandBefore,
    tool: {
      str_replace_editor,
      tool_grant,
      xd,
    },
  }
}

export default DshOpenscience
