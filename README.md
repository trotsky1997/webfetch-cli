# webfetch-cli

Standalone Node CLI for fetching web pages as Markdown and crawling bounded documentation sets. It does not depend on Pi.

## Install

```bash
npm install
npm exec -- webfetch-cli --help
```

After publishing to npm, it can be run without a global install:

```bash
npx webfetch-cli fetch https://example.com --output toc-only
npx webfetch-cli crawl https://docs.python.org/3/library/index.html --max-hops 1 --max-pages 30
```

## Commands

Fetch one page:

```bash
npx webfetch-cli fetch https://example.com --output toc-only
```

Crawl a documentation subtree:

```bash
npx webfetch-cli crawl https://docs.python.org/3/library/index.html --max-hops 1 --max-pages 30
```

Both commands write cache files under `.md/` in the current directory by default. Use `--cwd <path>` to write elsewhere.

## Fetch Chain

Unless `--raw-only` is set, page fetching tries:

1. `https://r.jina.ai/{url}`
2. `https://defuddle.md/{url}`
3. `https://markdown.new/{url}`
4. `https://pure.md/{url}`
5. Raw HTML converted to Markdown with `turndown`

`--raw-only` skips hosted services and fetches the target URL directly. This is useful for local sites and tests.

## Options

Fetch:

```bash
npx webfetch-cli fetch <url> \
  --output all|path-only|toc-only \
  --timeout 20000 \
  --cwd . \
  --raw-only \
  --json
```

Crawl:

```bash
npx webfetch-cli crawl <url> \
  --parent-domain docs.example.com \
  --max-hops 2 \
  --max-pages 30 \
  --max-links 40 \
  --concurrency 4 \
  --allow-query \
  --output summary|path-only|all \
  --timeout 20000 \
  --cwd . \
  --raw-only \
  --verbose \
  --json
```

## Output Layout

Single-page fetches:

```text
.md/<title>-<domain>-<timestamp>-<hash>.md
```

Crawls:

```text
.md/<hostname>/<original-path>.md
.md/crawls/crawl-<root>-<timestamp>-<hash>.json
```

## Verify

```bash
npm run smoke
```
