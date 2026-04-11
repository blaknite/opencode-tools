# OpenCode Tools

A collection of tools for improved RAG without blowing out context.

## Tools

### find_skill

Find domain-specific instructions by describing what you're about to do. Skills contain step-by-step workflows, scripts, and conventions you wouldn't otherwise know about. Loading the right skill early saves time and avoids mistakes.

**Note:** This tool is designed to replace the default opencode skill tool. Disabling the built-in skill system removes the large skill list from the system prompt and allows agents to load skills dynamically through natural language queries instead.

### web-search

Search the web using DuckDuckGo and extract page content from the top results. Use this when you need to look something up online, find documentation, research a topic, or answer questions that require current information.

## Requirements

- **Bun** runtime (required by both tools)
- **opencode** CLI (required for `find_skill`)
- **ddgs** Python CLI: `pip install ddgs` (required for `web-search`)
