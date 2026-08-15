/**
 * DSH-style minimal mode for omp.
 *
 * `/dsh-minimal` toggles a single-sentence system prompt plus an on-demand
 * capability-discovery protocol (read xd:// to enumerate tool devices, read
 * xd://<tool> for docs/schema, write JSON to xd://<tool> to execute), so the
 * system prompt never needs a tool catalog again. `/dsh-minimal strict`
 * additionally narrows tools to bash/edit/write/read. Modeled on DeepSeek
 * Harness's `minimal` agent preset: the persona IS the complete system prompt.
 *
 * The plugin also registers a `skills` device (loadMode "discoverable", so it
 * mounts under xd:// automatically): `write xd://skills {"action":"list"}`
 * enumerates skills and `{"action":"read","name":"<name>"}` loads SKILL.md.
 *
 * Mechanism: `before_provider_request` mutates `payload.instructions` and
 * `payload.tools` in place (verified: mutation alone is honored, no return
 * value needed). State persists as a `com.dsh-minimal.state` custom session
 * entry so it survives session restart; the last entry wins.
 *
 * Auto-enable: when no manual state exists and the active model is a DeepSeek
 * model, minimal mode is enabled automatically and the user is notified in TUI.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const STATE_ENTRY = 'com.dsh-minimal.state'
const MINIMAL_SYSTEM = 'You are a helpful software engineer assistant.'

/** Strict-mode tool allowlist: bash + editing trio + the xd discovery device. */
const STRICT_TOOLS = new Set(['bash', 'edit', 'write', 'read', 'xd'])

/** One-line descriptions replacing the verbose built-ins when a mode is active.
 *  read/write carry the xd:// discovery protocol so it stays out of the system prompt. */
const SHORT_DESCRIPTIONS: Record<string, string> = {
  read: 'Read files, directories, archives, databases, documents, and URLs. Internal URLs: xd:// lists mounted tool devices; xd://<tool> returns that device\'s docs and JSON schema.',
  write: 'Create or overwrite a file; write JSON args to xd://<tool> to execute a mounted tool device.',
  bash: 'Run shell commands in a persistent shell.',
  edit: 'Edit a file via string replacement.',
  eval: 'Run code in a persistent kernel (Python or JS).',
  glob: 'Glob files and directories with pattern matching.',
  grep: 'Search file contents with regex.',
  task: 'Delegate work to background subagents.',
  hub: 'Coordinate with subagents and manage background processes.',
  todo: 'Track task progress with a todo list.',
  web_search: 'Search the web for current information.',
}

type Mode = 'off' | 'minimal' | 'strict'

// ---- skill scanning (standard provider roots, first name wins) -------------

interface SkillInfo {
  name: string
  description: string
  path: string
}

function skillRoots(cwd: string): string[] {
  const home = homedir()
  return [
    join(home, '.omp', 'agent', 'skills'),
    join(cwd, '.omp', 'skills'),
    join(cwd, '.agent', 'skills'),
    join(cwd, '.agents', 'skills'),
    join(cwd, '.claude', 'skills'),
    join(cwd, '.codex', 'skills'),
    join(home, '.claude', 'skills'),
    join(home, '.codex', 'skills'),
    join(home, '.agents', 'skills'),
  ]
}

function parseFrontmatter(body: string): { name?: string; description?: string } {
  if (!body.startsWith('---')) return {}
  const end = body.indexOf('\n---', 3)
  if (end < 0) return {}
  const fm = body.slice(3, end)
  const key = (pattern: RegExp): string | undefined => {
    const match = pattern.exec(fm)?.[1]
    return match ? match.replace(/^['"]|['"]$/g, '').trim() : undefined
  }
  return {
    name: key(/^name:\s*(.+)$/m),
    description: key(/^description:\s*(.+)$/m),
  }
}

function scanSkills(cwd: string): SkillInfo[] {
  const seen = new Set<string>()
  const out: SkillInfo[] = []
  for (const root of skillRoots(cwd)) {
    let entries
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillMd = join(root, entry.name, 'SKILL.md')
      if (!existsSync(skillMd)) continue
      let body: string
      try {
        body = readFileSync(skillMd, 'utf8')
      } catch {
        continue
      }
      const fm = parseFrontmatter(body)
      const name = fm.name ?? entry.name
      if (seen.has(name)) continue
      seen.add(name)
      out.push({ name, description: fm.description ?? '', path: skillMd })
    }
  }
  return out
}

// ---- minimal structural types (no runtime dependency on the host package) ----

interface Entry {
  type: string
  customType?: string
  data?: { mode?: Mode; enabled?: boolean; auto?: boolean }
}

interface SessionManager {
  getBranch(): Entry[]
}

interface Ctx {
  sessionManager?: SessionManager
  model?: { id?: string; provider?: string; name?: string }
  models?: {
    current?(): { id?: string; provider?: string; name?: string } | undefined
  }
  ui?: { notify(text: string, level?: string): unknown }
}

interface CommandCtx extends Ctx {
  ui: { notify(text: string, level?: string): unknown }
}

interface ToolParams {
  action: 'list' | 'read'
  name?: string
}

interface ToolContext {
  cwd: string
}

interface ToolResult {
  content: { type: 'text'; text: string }[]
  details?: unknown
  isError?: boolean
}

interface Pi {
  on(event: string, handler: (event: unknown, ctx?: Ctx) => void | Promise<void>): unknown
  registerCommand(
    name: string,
    def: { description: string; handler: (args: string, ctx: CommandCtx) => void | Promise<void> },
  ): unknown
  registerTool(def: {
    name: string
    label?: string
    description: string
    parameters: unknown
    loadMode?: string
    execute(
      id: string,
      params: ToolParams,
      signal: unknown,
      onUpdate: unknown,
      ctx: ToolContext,
    ): Promise<ToolResult>
  }): unknown
  appendEntry(type: string, data: unknown): unknown
  zod: {
    object: (shape: Record<string, unknown>) => unknown
    enum: (values: readonly string[]) => unknown
    string: () => { optional: () => unknown }
  }
}

function readMode(sessionManager: SessionManager | undefined): Mode {
  if (!sessionManager) return 'off'
  let mode: Mode = 'off'
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== 'custom' || entry.customType !== STATE_ENTRY) continue
    const data = entry.data
    if (data?.mode === 'minimal' || data?.mode === 'strict') {
      mode = data.mode
    } else if (data?.enabled === true) {
      mode = 'minimal' // legacy `{ enabled: true }` entries
    } else {
      mode = 'off'
    }
  }
  return mode
}

function hasModeEntry(sessionManager: SessionManager | undefined): boolean {
  if (!sessionManager) return false
  return sessionManager.getBranch().some(
    (entry) => entry.type === 'custom' && entry.customType === STATE_ENTRY,
  )
}

function isDeepSeekModel(ctx: Ctx | undefined): boolean {
  const model = ctx?.model ?? ctx?.models?.current?.()
  if (!model) return false
  const haystack = [model.id, model.provider, model.name]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return haystack.includes('deepseek')
}

function autoModeNotice(model: { id?: string; provider?: string; name?: string } | undefined): string {
  const label = model?.id ?? model?.name ?? 'DeepSeek model'
  return `dsh-minimal auto-enabled (minimal): detected ${label}, discovery protocol active`
}

function parseMode(args: string, current: Mode): Mode {
  const value = args.trim().toLowerCase()
  if (value === 'off') return 'off'
  if (value === 'on' || value === 'minimal') return 'minimal'
  if (value === 'strict') return 'strict'
  // bare toggle: off <-> minimal; strict falls back to off
  return current === 'off' ? 'minimal' : 'off'
}

function modeNotice(mode: Mode): string {
  if (mode === 'minimal') {
    return `dsh-minimal enabled (minimal): discovery protocol active, system prompt is "${MINIMAL_SYSTEM.slice(0, 60)}…"`
  }
  if (mode === 'strict') {
    return `dsh-minimal strict: only bash/edit/write/read, discovery protocol active, system prompt is "${MINIMAL_SYSTEM.slice(0, 60)}…"`
  }
  return 'dsh-minimal disabled: default system prompt and tool descriptions restored'
}

interface ToolLike {
  name?: unknown
  description?: unknown
}

function applyMode(event: unknown, mode: Mode): void {
  const payload = (event as { payload?: { instructions?: unknown; tools?: unknown } }).payload
  if (!payload) return
  if (typeof payload.instructions === 'string') {
    payload.instructions = MINIMAL_SYSTEM
  }
  if (!Array.isArray(payload.tools)) return
  let tools = payload.tools
  if (mode === 'strict') {
    tools = tools.filter(
      (tool): tool is ToolLike =>
        typeof tool === 'object' &&
        tool !== null &&
        typeof (tool as ToolLike).name === 'string' &&
        STRICT_TOOLS.has((tool as ToolLike).name as string),
    )
    payload.tools = tools
  }
  for (const tool of tools) {
    if (typeof tool !== 'object' || tool === null) continue
    const t = tool as ToolLike
    if (typeof t.name === 'string') {
      const short = SHORT_DESCRIPTIONS[t.name]
      if (short) t.description = short
    }
  }
}

function renderSkillList(skills: SkillInfo[]): string {
  if (skills.length === 0) return 'No skills found.'
  return skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ''}`).join('\n')
}

export default function (pi: Pi) {
  pi.registerCommand('dsh-minimal', {
    description:
      'Toggle DSH-style minimal mode (single-sentence prompt + xd discovery protocol); `strict` keeps only bash/edit/write/read; `on`/`off`/`minimal`/`strict` set explicitly',
    handler: (args, ctx) => {
      const next = parseMode(args, readMode(ctx.sessionManager))
      pi.appendEntry(STATE_ENTRY, { mode: next })
      ctx.ui.notify(modeNotice(next), 'info')
    },
  })

  pi.registerTool({
    name: 'xd',
    label: 'XD Devices',
    description:
      'Discover extra capabilities on demand: read xd:// to list mounted tool devices; read xd://<tool> for each device\'s docs and JSON schema; write the JSON args object to xd://<tool> to execute. Mounted devices: ast_edit, debug, lsp, inspect_image, browser, checkpoint, rewind, skills (skills actions: list/read).',
    parameters: pi.zod.object({}),
    loadMode: 'essential',
    async execute() {
      return {
        content: [{ type: 'text', text: 'Use read xd:// to enumerate mounted tool devices, then read xd://<tool> for its docs and schema before writing JSON args to execute it.' }],
      }
    },
  })

  pi.registerTool({
    name: 'skills',
    label: 'Skills',
    description:
      'List or read available skills. action "list" returns name + description per skill; action "read" returns the SKILL.md body for the given name.',
    parameters: pi.zod.object({
      action: pi.zod.enum(['list', 'read']),
      name: pi.zod.string().optional(),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.action === 'list') {
        const skills = scanSkills(ctx.cwd)
        return {
          content: [{ type: 'text', text: renderSkillList(skills) }],
          details: { skills },
        }
      }
      const skill = scanSkills(ctx.cwd).find((s) => s.name === params.name)
      if (!skill) {
        return {
          content: [{ type: 'text', text: `No skill named "${params.name ?? ''}".` }],
          isError: true,
        }
      }
      const body = readFileSync(skill.path, 'utf8')
      return {
        content: [{ type: 'text', text: body }],
        details: { name: skill.name },
      }
    },
  })

  pi.on('before_provider_request', (event, ctx) => {
    // If the user has ever explicitly set dsh-minimal state, respect that
    // manual state (including an explicit `off`).
    if (hasModeEntry(ctx?.sessionManager)) {
      const mode = readMode(ctx?.sessionManager)
      if (mode === 'off') return
      applyMode(event, mode)
      return
    }

    // No manual state yet: auto-enable minimal mode when a DeepSeek model is used.
    if (!isDeepSeekModel(ctx)) return

    pi.appendEntry(STATE_ENTRY, { mode: 'minimal', auto: true })
    ctx?.ui?.notify?.(autoModeNotice(ctx?.model ?? ctx?.models?.current?.()), 'info')
    applyMode(event, 'minimal')
  })
}
