import { tool } from "@opencode-ai/plugin"
import { readdir, readFile, access } from "fs/promises"
import path from "path"
import os from "os"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SkillMeta {
  name: string
  description: string
  location: string
  body: string
}

// ---------------------------------------------------------------------------
// Frontmatter parser (no YAML dep needed -- skills only use name/description)
// ---------------------------------------------------------------------------

function parseFrontmatter(raw: string): {
  name?: string
  description?: string
  body: string
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) return { body: raw }

  const frontmatter = match[1]
  const body = match[2]

  let name: string | undefined
  let description: string | undefined

  for (const line of frontmatter.split("\n")) {
    const nameMatch = line.match(/^name:\s*"?([^"]*)"?\s*$/)
    if (nameMatch) {
      name = nameMatch[1].trim()
      continue
    }
    const descMatch = line.match(/^description:\s*"?(.*)"?\s*$/)
    if (descMatch) {
      description = descMatch[1].trim()
      if (description.endsWith('"')) description = description.slice(0, -1)
      continue
    }
  }

  return { name, description, body }
}

// ---------------------------------------------------------------------------
// Skill discovery
// ---------------------------------------------------------------------------

async function dirExists(dir: string): Promise<boolean> {
  try {
    await access(dir)
    return true
  } catch {
    return false
  }
}

async function scanSkillsDir(dir: string): Promise<SkillMeta[]> {
  if (!(await dirExists(dir))) return []

  const entries = await readdir(dir, { withFileTypes: true })
  const skills: SkillMeta[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillFile = path.join(dir, entry.name, "SKILL.md")
    try {
      const raw = await readFile(skillFile, "utf-8")
      const { name, description, body } = parseFrontmatter(raw)
      if (name && description) {
        skills.push({ name, description, location: skillFile, body })
      }
    } catch {
      // no SKILL.md or unreadable -- skip
    }
  }

  return skills
}

function projectSkillDirs(worktree: string): string[] {
  return [
    path.join(worktree, ".opencode", "skills"),
    path.join(worktree, ".claude", "skills"),
    path.join(worktree, ".agents", "skills"),
  ]
}

function globalSkillDirs(): string[] {
  const home = os.homedir()
  return [
    path.join(home, ".config", "opencode", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".config", "agents", "skills"),
    path.join(home, ".agents", "skills"),
  ]
}

async function discoverSkills(worktree: string): Promise<SkillMeta[]> {
  const dirs = [...projectSkillDirs(worktree), ...globalSkillDirs()]
  const results = await Promise.all(dirs.map(scanSkillsDir))
  const flat = results.flat()

  // dedupe by name -- first occurrence wins (project > global)
  const seen = new Set<string>()
  const deduped: SkillMeta[] = []
  for (const skill of flat) {
    if (seen.has(skill.name)) continue
    seen.add(skill.name)
    deduped.push(skill)
  }

  return deduped
}

// ---------------------------------------------------------------------------
// LLM-based skill matching via opencode run
// ---------------------------------------------------------------------------

function buildPrompt(query: string, skills: SkillMeta[]): string {
  const catalogue = skills
    .map((s) => `- ${s.name}: ${s.description}`)
    .join("\n")

  return [
    "## Available skills",
    "",
    catalogue,
    "",
    "## Query",
    "",
    query,
  ].join("\n")
}

const SKILL_MATCHER_CONFIG = JSON.stringify({
  agent: {
    "skill-matcher": {
      mode: "all",
      hidden: true,
      prompt: [
        "You are a skill matcher. Given a user's query and a catalogue of available skills,",
        "pick the single best matching skill. If no skill is relevant, say NONE.",
        "",
        "Reply with ONLY the skill name (e.g. `debugging-failed-builds`) or `NONE`.",
        "No explanation, no punctuation, no markdown, just the name.",
      ].join("\n"),
      permission: { "*": "deny" },
    },
  },
})

async function askAgent(prompt: string): Promise<string> {
  const proc = Bun.spawn(
    ["opencode", "run", "--agent", "skill-matcher", "--dangerously-skip-permissions"],
    {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: SKILL_MATCHER_CONFIG,
      },
    },
  )

  // write the prompt to stdin and close it
  proc.stdin.write(prompt)
  proc.stdin.end()

  const output = await new Response(proc.stdout).text()
  await proc.exited

  return output.trim()
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

function humanize(name: string): string {
  return name.replace(/-/g, " ")
}

// discover skills at load time so the description stays in sync
const bootSkills = await discoverSkills(process.cwd())
const skillList = bootSkills.map((s) => humanize(s.name)).join(", ")
const description = [
  "Find domain-specific instructions by describing what you're about to do. " +
    "Skills contain step-by-step workflows, scripts, and conventions you " +
    "wouldn't otherwise know about. Loading the right skill early saves " +
    "time and avoids mistakes. Describe what you need in natural language.",
  "",
  bootSkills.length > 0
    ? `Skills cover things like: ${skillList}.`
    : "No skills are currently available.",
].join("\n")

export default tool({
  description,
  args: {
    query: tool.schema
      .string()
      .describe(
        "What you need help with. Can be a natural language description " +
          "of the task, or an exact skill name if you know it.",
      ),
  },
  async execute(args, context) {
    const skills = await discoverSkills(context.worktree)

    if (skills.length === 0) {
      return "No skills found. Check that SKILL.md files exist in the expected locations."
    }

    const query = args.query.trim()

    // fast path: exact name match (skip the LLM call)
    const exact = skills.find((s) => s.name === query)
    if (exact) {
      context.metadata({ title: exact.name })
      return await formatSkillContent(exact)
    }

    // ask a fast agent to pick the best skill
    const prompt = buildPrompt(query, skills)
    const answer = await askAgent(prompt)

    // the agent should return just a skill name or NONE
    const cleanAnswer = answer.replace(/`/g, "").trim().toLowerCase()

    if (cleanAnswer === "none" || !cleanAnswer) {
      return (
        `No skill matched the query "${query}".\n\n` +
        "Available skill names for reference:\n" +
        skills.map((s) => `- ${s.name}`).join("\n")
      )
    }

    // find the skill the agent picked
    const matched = skills.find((s) => s.name === cleanAnswer)
    if (!matched) {
      // agent returned something we don't recognise -- fall back to listing
      return (
        `The skill matcher suggested "${answer}" but that skill was not found.\n\n` +
        "Available skill names for reference:\n" +
        skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")
      )
    }

    context.metadata({ title: matched.name })
    return await formatSkillContent(matched)
  },
})

async function listSkillFiles(skillLocation: string): Promise<string[]> {
  const dir = path.dirname(skillLocation)
  try {
    const entries = await readdir(dir, { recursive: true })
    return entries
      .filter((e) => e !== "SKILL.md")
      .map((e) => path.resolve(dir, e))
      .slice(0, 10)
  } catch {
    return []
  }
}

async function formatSkillContent(skill: SkillMeta): Promise<string> {
  const dir = path.dirname(skill.location)
  const files = await listSkillFiles(skill.location)
  const fileList = files.map((f) => `<file>${f}</file>`).join("\n")

  return [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    "",
    skill.body.trim(),
    "",
    `Base directory for this skill: ${dir}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    "",
    "<skill_files>",
    fileList,
    "</skill_files>",
    "</skill_content>",
  ].join("\n")
}
