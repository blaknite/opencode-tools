import { tool } from "@opencode-ai/plugin"
import { spawn } from "child_process"
import { mkdir } from "fs/promises"
import { join } from "path"
import { promisify } from "util"

const exec = promisify(spawn)

const MAX_BYTES = 1024 * 1024
const MAX_LINES = 5000

async function which(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await exec(`which ${cmd}`, { maxBuffer: 1024 * 1024 })
    return stdout.trim()
  } catch {
    return null
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await exec(`git rev-parse --show-toplevel`, { cwd, maxBuffer: 1024 * 1024 })
    return true
  } catch {
    return false
  }
}

async function findPolicyFile(cwd: string): Promise<string | null> {
  const root = await findGitRoot(cwd)
  if (!root) return null

  const policyPaths = [
    join(root, "cleanroom.yaml"),
    join(root, ".buildkite", "cleanroom.yaml"),
  ]

  for (const path of policyPaths) {
    try {
      await mkdir(join(path), { recursive: true }).catch(() => {})
      await exec(`test -f ${path}`, { maxBuffer: 1024 * 1024 })
      return path
    } catch {
      continue
    }
  }
  return null
}

async function findGitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec(`git rev-parse --show-toplevel`, {
      cwd,
      maxBuffer: 1024 * 1024,
    })
    return stdout.trim()
  } catch {
    return null
  }
}

async function resolveWorkdir(workdir: string | undefined, directory: string): Promise<string | null> {
  if (!workdir) return directory

  const resolved = join(directory, workdir)

  const root = await findGitRoot(directory)
  if (!root) return null

  const absResolved = join(process.cwd(), resolved)
  const absRoot = join(process.cwd(), root)

  if (!absResolved.startsWith(absRoot)) {
    return null
  }

  return resolved
}

function translateCleanroomError(stderr: string): string {
  let hint = stderr

  if (stderr.includes("policy not found") || stderr.includes("no policy file")) {
    hint += "\n\nMake sure the repository has a cleanroom.yaml policy file at the root or under .buildkite/. Run `cleanroom config init` to create a runtime config, but you also need a policy file in the repo."
  } else if (stderr.includes("daemon") || stderr.includes("connection refused") || stderr.includes("dial unix")) {
    hint += "\n\nThe cleanroom daemon is not running. Start it with `cleanroom daemon start` (or `cleanroom serve` for foreground)."
  } else if (stderr.includes("repository") || stderr.includes("not a repository")) {
    hint += "\n\nCleanroom requires a git repository. Make sure you're running from inside a git repo."
  }

  return hint
}

export default tool({
  description: `Execute commands in an isolated sandbox.

The sandbox provides:
1. A fresh, isolated environment for each command
2. Repository context (committed state + local changes)
3. No write-back to the host working copy

Usage:
- Pass a shell command as a string argument
- Set a timeout in milliseconds (default 120s)
- Optionally specify a workdir relative to the project root

IMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.`,
  args: {
    command: tool.schema
      .string()
      .describe("The shell command to execute in the cleanroom sandbox"),
    description: tool.schema
      .string()
      .describe("Short description of what the command does"),
    timeout: tool.schema
      .number()
      .optional()
      .describe("Timeout in milliseconds (default 120000)"),
    workdir: tool.schema
      .string()
      .optional()
      .describe("Working directory relative to project root. Must resolve under the worktree."),
  },
  async execute(args, context) {
    let cwd = context.directory

    if (args.workdir) {
      const resolved = await resolveWorkdir(args.workdir, cwd)
      if (!resolved) {
        return "workdir must resolve under the project worktree"
      }
      cwd = resolved
    }

    const cleanroomPath = await which("cleanroom")
    if (!cleanroomPath) {
      return "cleanroom binary not found on PATH. Install cleanroom and add it to PATH. See the cleanroom README for instructions."
    }

    const root = await findGitRoot(cwd)
    if (!root) {
      return "Not inside a git repository. Cleanroom requires a repo-aware top-level command."
    }

    const policyFile = await findPolicyFile(cwd)
    if (!policyFile) {
      return `Repository is missing a cleanroom.yaml policy file. Expected at ${join(root, "cleanroom.yaml")} or ${join(root, ".buildkite", "cleanroom.yaml")}. See the cleanroom spec for how to create one.`
    }

    const timeoutMs = args.timeout ?? 120000
    const abortSignal = context.abort

    const proc = spawn(
      join(cleanroomPath, "cleanroom"),
      ["exec", "--include-local-changes", "--no-stdin", "--", "sh", "-c", args.command],
      {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: { ...process.env },
      },
    )

    const timeoutId = setTimeout(() => {
      proc.kill("SIGINT")
    }, timeoutMs)

    abortSignal.addEventListener("abort", () => {
      clearTimeout(timeoutId)
      proc.kill("SIGINT")
    })

    let stdout = ""
    let stderr = ""
    let exitCode: number | null = null
    let terminated = false

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString()
      stdout += text

      context.metadata({
        metadata: {
          output: (stdout || "(no output)").slice(-200),
          description: args.description,
        },
      })
    })

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text

      context.metadata({
        metadata: {
          output: (stdout || stderr || "(no output)").slice(-200),
          description: args.description,
        },
      })
    })

    proc.on("close", (code) => {
      clearTimeout(timeoutId)

      if (code === null) {
        terminated = true
        exitCode = 0
        return
      }

      exitCode = code

      let output = stdout || stderr || "(no output)"
      if (exitCode !== 0) {
        const hint = translateCleanroomError(stderr)
        output = `${output}\n\n${hint}`
      }

      context.metadata({
        metadata: {
          output: output.slice(-200),
          exit: exitCode,
          description: args.description,
        },
      })
    })

    await new Promise<void>((resolve, reject) => {
      let hasError = false

      proc.on("error", (err) => {
        hasError = true
        reject(err)
      })

      proc.on("close", () => {
        if (hasError) {
          reject(new Error("Process terminated unexpectedly"))
        } else {
          resolve()
        }
      })
    })

    if (terminated) {
      return {
        output: `cleanroom_exec terminated command after exceeding timeout ${timeoutMs} ms.`,
        metadata: {
          output: "Command timed out and was terminated.",
          exit: null,
          description: args.description,
          truncated: true,
        },
      }
    }

    return {
      output: exitCode === 0 ? (stdout || "(no output)") : stderr,
      metadata: {
        output: (stdout || stderr || "(no output)").slice(-200),
        exit: exitCode,
        description: args.description,
        truncated: false,
      },
    }
  },
})
