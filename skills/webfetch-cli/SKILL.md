---
name: webfetch-cli
description: Use when the user asks to fetch a web page as Markdown, cache web content locally, crawl a bounded documentation subtree, mirror docs under .md/, or use the trotsky1997/webfetch-cli GitHub npx tool. This skill is for web-to-Markdown retrieval without Pi.
---

# Webfetch CLI

Use the standalone GitHub CLI package:

```bash
npm exec --yes --package=github:trotsky1997/webfetch-cli -- webfetch-cli --help
```

Do not assume the package is installed globally. Prefer the GitHub `npm exec --package=...` form so it works before npm publication.

## Single Page

Fetch one page as Markdown and write a cache file under `.md/`:

```bash
npm exec --yes --package=github:trotsky1997/webfetch-cli -- \
  webfetch-cli fetch "https://example.com" --output toc-only
```

Output modes:

- `toc-only`: path plus generated TOC, falling back to path-only when no TOC exists
- `path-only`: only the cache path
- `all`: path plus full Markdown

Use `--raw-only` for local servers, intranet pages, or cases where hosted Markdown extraction should be skipped.

## Documentation Crawl

Crawl a bounded documentation subtree and mirror fetched pages under `.md/<host>/...`:

```bash
npm exec --yes --package=github:trotsky1997/webfetch-cli -- \
  webfetch-cli crawl "https://docs.python.org/3/library/index.html" \
  --max-hops 1 \
  --max-pages 30 \
  --output summary
```

Useful crawl flags:

- `--parent-domain <domain>` limits allowed hostnames to that suffix
- `--max-hops <n>` limits link distance from the root
- `--max-pages <n>` limits fetched pages
- `--max-links <n>` limits followed links per page
- `--concurrency <n>` controls parallel fetches
- `--allow-query` keeps query-string URLs in scope
- `--verbose` prints crawl progress to stderr

The crawl writes a manifest under `.md/crawls/`. Use `--output path-only` when the caller only needs that manifest path, or `--output all` when inline JSON details are useful.

## Working Directory

By default, output goes to `.md/` in the current directory. Use `--cwd <path>` to direct writes somewhere else:

```bash
npm exec --yes --package=github:trotsky1997/webfetch-cli -- \
  webfetch-cli fetch "https://example.com" --cwd "/tmp/webfetch-out" --output path-only
```

## Reading Results

After a successful run, inspect the printed path or manifest:

```bash
sed -n '1,120p' .md/example-com-*.md
```

For crawls, read `.md/crawls/*.json` to see fetched pages, skipped links, failures, limits, and cache paths.

## Failure Handling

If fetch fails, retry with:

- `--raw-only` to skip hosted extractors
- a larger `--timeout`, for example `--timeout 60000`
- smaller crawl bounds, for example `--max-hops 1 --max-pages 10`

For user-facing summaries, mention where files were written and whether failures appear in the crawl manifest.
