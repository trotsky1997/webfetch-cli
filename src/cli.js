import { resolve } from "node:path";

import {
  DEFAULT_CRAWL_OUTPUT_MODE,
  DEFAULT_MAX_HOPS,
  DEFAULT_MAX_LINKS_PER_PAGE,
  DEFAULT_MAX_PAGES,
  DEFAULT_OUTPUT_MODE,
  DEFAULT_TIMEOUT_MS,
  crawlUrl,
  fetchUrl,
} from "./core.js";

const helpText = `webfetch-cli

Usage:
  npx webfetch-cli fetch <url> [options]
  npx webfetch-cli crawl <url> [options]

Fetch options:
  --output <mode>       all, path-only, or toc-only. Default: ${DEFAULT_OUTPUT_MODE}
  --timeout <ms>        Per-attempt timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --cwd <path>          Directory where .md/ is written. Default: current directory
  --raw-only            Skip hosted Markdown services and fetch the URL directly
  --json                Print JSON details instead of text output

Crawl options:
  --parent-domain <d>   Allowed hostname suffix. Default: root hostname
  --max-hops <n>        Link distance from root. Default: ${DEFAULT_MAX_HOPS}
  --max-pages <n>       Page cap. Default: ${DEFAULT_MAX_PAGES}
  --max-links <n>       Per-page followed-link cap. Default: ${DEFAULT_MAX_LINKS_PER_PAGE}
  --concurrency <n>     Parallel fetches. Default: 4
  --allow-query         Allow query-string URLs during crawl
  --output <mode>       summary, path-only, or all. Default: ${DEFAULT_CRAWL_OUTPUT_MODE}
  --timeout <ms>        Per-attempt timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --cwd <path>          Directory where .md/ is written. Default: current directory
  --raw-only            Skip hosted Markdown services and fetch URLs directly
  --json                Print JSON details instead of text output
  --verbose             Print crawl progress to stderr

Examples:
  npx webfetch-cli fetch https://example.com --output toc-only
  npx webfetch-cli crawl https://docs.python.org/3/library/index.html --max-hops 1 --max-pages 30
  npx webfetch-cli fetch http://localhost:8080 --raw-only --cwd ./scratch
`;

function readFlagValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseCommonOptions(args, startIndex = 0) {
  const options = {};
  let url = "";

  for (let i = startIndex; i < args.length; i += 1) {
    const arg = args[i];

    if (!arg.startsWith("--")) {
      if (url) {
        throw new Error(`Unexpected positional argument: ${arg}`);
      }
      url = arg;
      continue;
    }

    switch (arg) {
      case "--output":
        options.outputMode = readFlagValue(args, i, arg);
        i += 1;
        break;
      case "--timeout":
        options.timeoutMs = Number(readFlagValue(args, i, arg));
        i += 1;
        break;
      case "--cwd":
        options.cwd = resolve(readFlagValue(args, i, arg));
        i += 1;
        break;
      case "--raw-only":
        options.rawOnly = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--parent-domain":
        options.parentDomain = readFlagValue(args, i, arg);
        i += 1;
        break;
      case "--max-hops":
        options.maxHops = Number(readFlagValue(args, i, arg));
        i += 1;
        break;
      case "--max-pages":
        options.maxPages = Number(readFlagValue(args, i, arg));
        i += 1;
        break;
      case "--max-links":
        options.maxLinksPerPage = Number(readFlagValue(args, i, arg));
        i += 1;
        break;
      case "--concurrency":
        options.concurrency = Number(readFlagValue(args, i, arg));
        i += 1;
        break;
      case "--allow-query":
        options.allowQuery = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { url, options };
}

function validateOutputMode(mode, allowed, label) {
  if (!allowed.includes(mode)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
}

export async function main(argv) {
  const [command] = argv;

  if (!command || command === "--help" || command === "-h") {
    console.log(helpText);
    return;
  }

  if (command !== "fetch" && command !== "crawl") {
    throw new Error(`Unknown command: ${command}\n\n${helpText}`);
  }

  const { url, options } = parseCommonOptions(argv, 1);
  if (options.help) {
    console.log(helpText);
    return;
  }
  if (!url) {
    throw new Error(`Missing URL.\n\n${helpText}`);
  }

  if (command === "fetch") {
    const outputMode = options.outputMode ?? DEFAULT_OUTPUT_MODE;
    validateOutputMode(outputMode, ["all", "path-only", "toc-only"], "fetch --output");
    const result = await fetchUrl(url, {
      ...options,
      outputMode,
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : result.text);
    return;
  }

  const outputMode = options.outputMode ?? DEFAULT_CRAWL_OUTPUT_MODE;
  validateOutputMode(outputMode, ["summary", "path-only", "all"], "crawl --output");
  const result = await crawlUrl(url, {
    ...options,
    outputMode,
    onUpdate: options.verbose
      ? (update) => {
          console.error(
            `Crawling ${update.fetchedPages}/${update.maxPages} pages; depth=${update.depth}; batch=${update.batchSize}; pending=${update.pending}`,
          );
        }
      : undefined,
  });

  console.log(options.json ? JSON.stringify(result, null, 2) : result.text);
}
