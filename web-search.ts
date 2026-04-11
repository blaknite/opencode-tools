import { tool } from "@opencode-ai/plugin"
import { tmpdir } from "os"
import { join } from "path"
import { readFile, unlink } from "fs/promises"

interface SearchResult {
  title: string
  href: string
  body: string
}

async function search(query: string, limit: number): Promise<SearchResult[]> {
  const tmp = join(tmpdir(), `ddgs-${Date.now()}.json`)

  const proc = Bun.spawn(
    ["ddgs", "text", "-q", query, "-m", String(limit), "-b", "duckduckgo", "-o", tmp],
    { stdout: "pipe", stderr: "pipe" },
  )

  await proc.exited

  try {
    const raw = await readFile(tmp, "utf-8")
    return JSON.parse(raw) as SearchResult[]
  } catch {
    return []
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

async function extract(url: string): Promise<string> {
  const proc = Bun.spawn(
    ["ddgs", "extract", "-u", url, "-f", "text_markdown"],
    { stdout: "pipe", stderr: "pipe" },
  )

  const output = await new Response(proc.stdout).text()
  await proc.exited

  // ddgs extract prefixes output with "URL: <url>\n\n"
  const cleaned = output.replace(/^URL:\s.*\n\n/, "").trim()
  return cleaned
}

const MAX_CHARS_PER_PAGE = 10000

// Sites that block automated extraction or return useless bot-challenge pages
const EXCLUDED_SITES = [
  "reddit.com",
  "quora.com",
  "pinterest.com",
  "instagram.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
]

export default tool({
  description: `Search the web using DuckDuckGo and extract page content from the top results.

Pass a search query and this tool will:
1. Search DuckDuckGo for the top 3 results
2. Extract the content of each result page
3. Return the combined content with source URLs

Use this when you need to look something up online, find documentation, research a topic, or answer questions that require current information.`,
  args: {
    query: tool.schema.string().describe("The search query to look up on DuckDuckGo"),
  },
  async execute(args, context) {
    context.metadata({ title: `Searching: ${args.query}` })

    const exclusions = EXCLUDED_SITES.map((s) => `-site:${s}`).join(" ")
    const fullQuery = `${args.query} ${exclusions}`

    const results = await search(fullQuery, 3)

    if (results.length === 0) {
      return `No search results found for "${args.query}".`
    }

    const extractions = await Promise.all(
      results.map(async (result, i) => {
        try {
          let content = await extract(result.href)

          if (!content) {
            content = result.body
          } else if (content.length > MAX_CHARS_PER_PAGE) {
            content = content.slice(0, MAX_CHARS_PER_PAGE) + "\n\n[Content truncated]"
          }

          return `## ${i + 1}. ${result.title}\n**URL:** ${result.href}\n\n${content}`
        } catch {
          return `## ${i + 1}. ${result.title}\n**URL:** ${result.href}\n\n${result.body}`
        }
      }),
    )

    return extractions.join("\n\n---\n\n")
  },
})
