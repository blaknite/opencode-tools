import { tool } from "@opencode-ai/plugin";
import { readdir, readFile, access } from "fs/promises";
import path from "path";
import os from "os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SkillMeta {
  name: string;
  description: string;
  location: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Frontmatter parser (no YAML dep needed -- skills only use name/description)
// ---------------------------------------------------------------------------

function parseFrontmatter(raw: string): {
  name?: string;
  description?: string;
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { body: raw };

  const frontmatter = match[1];
  const body = match[2];

  let name: string | undefined;
  let description: string | undefined;

  for (const line of frontmatter.split("\n")) {
    const nameMatch = line.match(/^name:\s*"?([^"]*)"?\s*$/);
    if (nameMatch) {
      name = nameMatch[1].trim();
      continue;
    }
    const descMatch = line.match(/^description:\s*"?(.*)"?\s*$/);
    if (descMatch) {
      description = descMatch[1].trim();
      if (description.endsWith('"')) description = description.slice(0, -1);
      continue;
    }
  }

  return { name, description, body };
}

// ---------------------------------------------------------------------------
// Skill discovery
// ---------------------------------------------------------------------------

async function dirExists(dir: string): Promise<boolean> {
  try {
    await access(dir);
    return true;
  } catch {
    return false;
  }
}

async function scanSkillsDir(dir: string): Promise<SkillMeta[]> {
  if (!(await dirExists(dir))) return [];

  const entries = await readdir(dir, { withFileTypes: true });
  const skills: SkillMeta[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, "SKILL.md");
    try {
      const raw = await readFile(skillFile, "utf-8");
      const { name, description, body } = parseFrontmatter(raw);
      if (name && description) {
        skills.push({ name, description, location: skillFile, body });
      }
    } catch {
      // no SKILL.md or unreadable -- skip
    }
  }

  return skills;
}

function projectSkillDirs(worktree: string): string[] {
  return [
    path.join(worktree, ".opencode", "skills"),
    path.join(worktree, ".claude", "skills"),
    path.join(worktree, ".agents", "skills"),
  ];
}

function globalSkillDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".config", "opencode", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".config", "agents", "skills"),
    path.join(home, ".agents", "skills"),
  ];
}

async function discoverSkills(worktree: string): Promise<SkillMeta[]> {
  const dirs = [...projectSkillDirs(worktree), ...globalSkillDirs()];
  const results = await Promise.all(dirs.map(scanSkillsDir));
  const flat = results.flat();

  // dedupe by name -- first occurrence wins (project > global)
  const seen = new Set<string>();
  const deduped: SkillMeta[] = [];
  for (const skill of flat) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    deduped.push(skill);
  }

  return deduped;
}

// ---------------------------------------------------------------------------
// LLM-based skill matching via opencode run
// ---------------------------------------------------------------------------

const SKILL_RESOLVER_SYSTEM_PROMPT = [
  "You are a skill resolver. Your job is to identify which skills, if any, are relevant to the given query and load them.",
  "",
  "A skill is relevant when following it would directly guide the work described. The match should be on substance: the query and the skill should be about the same thing. Shared vocabulary is not enough.",
  "",
  "Follow these steps:",
  "",
  "1. If a specific skill name is provided, load that skill. Otherwise, identify the best matching skill(s) from the available list based on the substance of the query.",
  "2. Use the `skill` tool to load the identified skill(s).",
  "3. Check each loaded skill for required dependencies and load those too.",
  "4. Repeat until no more required dependencies remain.",
  "5. Your final message must be a valid JSON array of exact skill names. No prose before it, no prose after it, no markdown, no explanation.",
  "   Any text outside the JSON array will cause a parse failure.",
  '   Example: ["debugging-failed-builds","using-buildkite"]',
  "   If no skills are relevant, return [].",
  "",
  "When a query covers multiple distinct topics, include all relevant skills. When nothing is a genuine match, return [] rather than forcing a close-enough result.",
  "Use exact skill names.",
].join("\n");

function buildResolverPrompt(query: string, exactSkillName?: string): string {
  if (exactSkillName) {
    return `Load this skill and resolve its dependencies: ${exactSkillName}`;
  }
  return `Find the best matching skill(s) and resolve their dependencies for this query: ${query}`;
}

function isLocalAgent(agentName: string | undefined): boolean {
  if (!agentName) return false;
  return /local/i.test(agentName);
}

const LOCAL_MODEL = "lmstudio/unsloth/qwen3.5-9b";
const CLOUD_MODEL = "anthropic/claude-haiku-4-5";

function buildSkillResolverConfig(callingAgent: string | undefined): string {
  const model = isLocalAgent(callingAgent) ? LOCAL_MODEL : CLOUD_MODEL;

  return JSON.stringify({
    agent: {
      "skill-resolver": {
        mode: "all",
        hidden: true,
        prompt: SKILL_RESOLVER_SYSTEM_PROMPT,
        model,
        permission: {
          "*": "deny",
          skill: "allow",
        },
      },
    },
  });
}

async function askAgent(
  prompt: string,
  worktree: string,
  callingAgent: string | undefined,
  abort?: AbortSignal,
): Promise<string> {
  const proc = Bun.spawn(
    [
      "opencode",
      "run",
      "--agent",
      "skill-resolver",
      "--dangerously-skip-permissions",
      "--format",
      "json",
    ],
    {
      cwd: worktree,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: buildSkillResolverConfig(callingAgent),
      },
    },
  );

  const onAbort = () => proc.kill();
  abort?.addEventListener("abort", onAbort);

  proc.stdin.write(prompt);
  proc.stdin.end();

  let sessionID: string | undefined;
  const textParts: string[] = [];
  let sawStructuredOutput = false;

  try {
    const [raw, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      const detail = stderr.trim() || "No stderr output.";
      throw new Error(
        `Skill resolver exited with code ${exitCode}.\n\n${detail}`,
      );
    }

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        sawStructuredOutput = true;
        if (!sessionID && event.sessionID) sessionID = event.sessionID;
        if (event.type === "text" && event.part?.text)
          textParts.push(event.part.text);
      } catch {
        // not JSON, skip
      }
    }

    if (!sawStructuredOutput) {
      const detail = raw.trim() || "No stdout output.";
      throw new Error(
        `Skill resolver returned unparseable output.\n\n${detail}`,
      );
    }
  } finally {
    abort?.removeEventListener("abort", onAbort);

    if (sessionID) {
      await Bun.spawn(["opencode", "session", "delete", sessionID], {
        cwd: worktree,
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
    }
  }

  const full = textParts.join("").trim();
  if (!full) {
    throw new Error("Skill resolver returned no text response.");
  }

  const match = full.match(/\[.*\]/s);
  if (!match) {
    throw new Error(`Skill resolver returned no JSON array: ${JSON.stringify(full)}`);
  }

  return match[0];
}

function parseResolvedSkillNames(answer: string): string[] {
  try {
    const parsed = JSON.parse(answer);
    if (!Array.isArray(parsed)) return [];

    const seen = new Set<string>();

    return parsed
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => {
        if (!value || seen.has(value)) return false;
        seen.add(value);
        return true;
      });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

function humanize(name: string): string {
  return name.replace(/-/g, " ");
}

// discover skills at load time so the description stays in sync
const bootSkills = await discoverSkills(process.cwd());
const skillList = bootSkills.map((s) => humanize(s.name)).join(", ");
const description = [
  "Find domain-specific instructions by describing the task you are about to perform. " +
    "Skills contain step-by-step workflows, scripts, and conventions specific to this environment.",
  "",
  bootSkills.length > 0
    ? `Skills cover things like: ${skillList}.`
    : "No skills are currently available.",
].join("\n");

export default tool({
  description,
  args: {
    query: tool.schema
      .string()
      .describe(
        "The task you are about to perform, described in terms of what you are trying to accomplish. " +
          "Describe the goal, not the method. Keep it short. " +
          "Use an exact skill name if you already know it. " +
          "Examples: user says 'can you look at this PR?' -> query 'reviewing a pull request'; " +
          "user says 'the build is red' -> query 'build is failing'; " +
          "user says 'write me a ticket for this' -> query 'writing an issue'.",
      ),
  },
  async execute(args, context) {
    const skills = await discoverSkills(context.worktree);

    if (skills.length === 0) {
      return "No skills found. Check that SKILL.md files exist in the expected locations.";
    }

    const query = args.query.trim();
    const exact = skills.find((s) => s.name === query);

    const prompt = buildResolverPrompt(query, exact?.name);
    const answer = await askAgent(
      prompt,
      context.worktree,
      context.agent,
      context.abort,
    );

    const resolvedNames = parseResolvedSkillNames(answer);
    if (resolvedNames.length === 0) {
      if (answer !== "[]") {
        throw new Error(
          `Skill resolver returned invalid JSON: ${JSON.stringify(answer)}`,
        );
      }

      return `No skill matched the query "${query}".`;
    }

    const resolvedSkills = resolvedNames
      .map((name) => skills.find((skill) => skill.name === name))
      .filter((skill): skill is SkillMeta => Boolean(skill));

    if (resolvedSkills.length === 0) {
      return `The skill resolver suggested unknown skills: ${answer}.`;
    }

    if (resolvedSkills.length !== resolvedNames.length) {
      const missing = resolvedNames.filter(
        (name) => !resolvedSkills.some((skill) => skill.name === name),
      );

      return `The skill resolver suggested missing skills: ${missing.join(", ")}.`;
    }

    context.metadata({ title: resolvedSkills[0].name });
    return await formatSkillContent(resolvedSkills);
  },
});

async function listSkillFiles(skillLocation: string): Promise<string[]> {
  const dir = path.dirname(skillLocation);
  try {
    const entries = (await readdir(dir, { recursive: true })) as string[];
    return entries
      .filter((e) => e !== "SKILL.md")
      .map((e) => path.resolve(dir, e))
      .slice(0, 10);
  } catch {
    return [];
  }
}

async function formatSkillContent(skills: SkillMeta[]): Promise<string> {
  const sections = await Promise.all(
    skills.map(async (skill) => {
      const dir = path.dirname(skill.location);
      const files = await listSkillFiles(skill.location);
      const fileList = files.map((f) => `<file>${f}</file>`).join("\n");

      return [
        `<skill_content name="${skill.name}">`,
        `# Skill: ${skill.name}`,
        "",
        "Read this skill before acting.",
        "Required dependent skills have already been loaded below when they were found.",
        "If you discover another required skill that is not included here, call `find_skill` for it before continuing.",
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
      ].join("\n");
    }),
  );

  return sections.join("\n\n");
}
