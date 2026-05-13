import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import formatFromString from "@quilicicf/markdown-formatter/lib/formatFromString.js";
import TurndownService from "turndown";

export const DEFAULT_TIMEOUT_MS = 20_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 120_000;
export const DEFAULT_OUTPUT_MODE = "toc-only";
export const DEFAULT_CRAWL_OUTPUT_MODE = "summary";
export const DEFAULT_MAX_HOPS = 2;
export const DEFAULT_MAX_PAGES = 30;
export const DEFAULT_MAX_LINKS_PER_PAGE = 40;
export const DEFAULT_CRAWL_CONCURRENCY = 4;

const MARKDOWN_MARKER = "Markdown Content:";
const TOC_START = "<!-- TOC START min:2 max:4 -->";
const TOC_END = "<!-- TOC END -->";
const CACHE_DIR_NAME = ".md";
const MANIFEST_DIR_NAME = "crawls";
const MAX_SUMMARY_PAGES = 50;

const defaultRequestHeaders = {
  Accept: "text/markdown,text/plain,text/html;q=0.9,*/*;q=0.1",
  "User-Agent": "webfetch-cli/0.1",
};

const turndown = new TurndownService({
  codeBlockStyle: "fenced",
  headingStyle: "atx",
});

function clampInteger(value, fallback, min, max) {
  const number = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;
  return Math.min(Math.max(number, min), max);
}

export function normalizeUrl(input) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) {
    throw new Error("URL is required.");
  }

  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http and https URLs are supported: ${url.protocol}`);
  }
  return url.toString();
}

function canonicalizeCrawlUrl(input) {
  const url = new URL(input);
  url.hash = "";

  if (url.pathname.endsWith("/index.html")) {
    url.pathname = url.pathname.slice(0, -"index.html".length);
  }

  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  if (url.pathname === "") {
    url.pathname = "/";
  }

  return url.toString();
}

function normalizeText(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").trim();
}

function looksLikeHtml(text) {
  return /^\s*(<!doctype html|<html\b|<head\b|<body\b)/i.test(text);
}

function stripFrontmatter(text) {
  if (!text.startsWith("---\n")) {
    if (!text.startsWith("+++\n")) {
      return text;
    }

    const endToml = text.indexOf("\n+++\n", 4);
    if (endToml === -1) {
      return text;
    }

    return text.slice(endToml + 5).trim();
  }

  const end = text.indexOf("\n---\n", 4);
  if (end === -1) {
    return text;
  }

  return text.slice(end + 5).trim();
}

function isBlankMarkdown(text) {
  return stripFrontmatter(text).trim().length === 0;
}

function extractMarkdownPayload(text) {
  const normalized = normalizeText(text);
  const markerIndex = normalized.indexOf(MARKDOWN_MARKER);
  if (markerIndex === -1) {
    return normalized;
  }

  return normalized.slice(markerIndex + MARKDOWN_MARKER.length).trim();
}

function ensureServiceMarkdown(text, source) {
  const markdown = extractMarkdownPayload(text);
  if (!markdown || isBlankMarkdown(markdown)) {
    throw new Error(`${source} returned blank markdown.`);
  }
  if (looksLikeHtml(markdown)) {
    throw new Error(`${source} returned HTML instead of markdown.`);
  }
  return markdown;
}

function convertRawContentToMarkdown(body, contentType) {
  const normalized = normalizeText(body);
  if (!normalized) {
    throw new Error("raw-html-turndown returned blank content.");
  }

  const lowerType = contentType?.toLowerCase() ?? "";
  if (looksLikeHtml(normalized) || lowerType.includes("html")) {
    const markdown = turndown.turndown(normalized).trim();
    if (!markdown || isBlankMarkdown(markdown)) {
      throw new Error("turndown produced blank markdown.");
    }
    return markdown;
  }

  if (lowerType.includes("markdown") || lowerType.includes("text/plain")) {
    return normalized;
  }

  throw new Error(`unsupported raw content type: ${contentType ?? "unknown"}`);
}

function ensureAbortSignal(signal) {
  return signal ?? new AbortController().signal;
}

function getFetchSignal(parentSignal, timeoutMs) {
  return AbortSignal.any([ensureAbortSignal(parentSignal), AbortSignal.timeout(timeoutMs)]);
}

function buildSources(normalizedUrl, rawOnly) {
  if (rawOnly) {
    return [{ source: "raw-html-turndown", requestUrl: normalizedUrl }];
  }

  return [
    { source: "jina-reader", requestUrl: `https://r.jina.ai/${normalizedUrl}` },
    { source: "defuddle", requestUrl: `https://defuddle.md/${normalizedUrl}` },
    { source: "markdown-new", requestUrl: `https://markdown.new/${normalizedUrl}` },
    { source: "pure-md", requestUrl: `https://pure.md/${normalizedUrl}` },
    { source: "raw-html-turndown", requestUrl: normalizedUrl },
  ];
}

async function fetchAttempt(source, requestUrl, timeoutMs, signal, headers) {
  const response = await fetch(requestUrl, {
    headers,
    redirect: "follow",
    signal: getFetchSignal(signal, timeoutMs),
  });
  const contentType = response.headers.get("content-type");

  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${response.status}`), {
      status: response.status,
      contentType,
    });
  }

  const body = await response.text();
  const markdown =
    source === "raw-html-turndown"
      ? convertRawContentToMarkdown(body, contentType)
      : ensureServiceMarkdown(body, source);

  return {
    markdown,
    attempt: {
      source,
      requestUrl,
      ok: true,
      status: response.status,
      contentType,
    },
  };
}

function formatError(error) {
  if (error instanceof Error) {
    return {
      message: error.message,
      status: error.status,
      contentType: error.contentType,
    };
  }

  return { message: String(error) };
}

function stripTocBlock(markdown) {
  return markdown.replace(/<!-- TOC START[\s\S]*?<!-- TOC END.*?-->/, "").trim();
}

function extractTocBlock(markdown) {
  const match = markdown.match(/<!-- TOC START[\s\S]*?<!-- TOC END.*?-->/);
  if (!match) {
    return "";
  }

  return normalizeText(match[0]);
}

function tocHasEntries(tocBlock) {
  return /\[[^\]]+\]\(#.+\)/.test(tocBlock);
}

function hasTocEligibleHeadings(markdown) {
  const withoutFrontmatter = stripFrontmatter(markdown);
  const withoutToc = stripTocBlock(withoutFrontmatter);
  return /^#{2,4}\s+.+$/m.test(withoutToc);
}

function normalizeForFileName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[`*_~#[\]()>!]/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function stripWrappingQuotes(value) {
  return String(value ?? "").replace(/^['"]+|['"]+$/g, "").trim();
}

function splitLeadingFrontmatter(text) {
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---\n", 4);
    if (end !== -1) {
      return {
        frontmatter: text.slice(0, end + 5).trimEnd(),
        body: text.slice(end + 5).trimStart(),
      };
    }
  }

  if (text.startsWith("+++\n")) {
    const end = text.indexOf("\n+++\n", 4);
    if (end !== -1) {
      return {
        frontmatter: text.slice(0, end + 5).trimEnd(),
        body: text.slice(end + 5).trimStart(),
      };
    }
  }

  return { frontmatter: "", body: text };
}

function extractFrontmatterTitle(markdown) {
  const { frontmatter } = splitLeadingFrontmatter(markdown);
  if (!frontmatter) {
    return "";
  }

  const yamlMatch = frontmatter.match(/^title\s*:\s*(.+)$/im);
  if (yamlMatch?.[1]) {
    return stripWrappingQuotes(yamlMatch[1]);
  }

  const tomlMatch = frontmatter.match(/^title\s*=\s*(.+)$/im);
  if (tomlMatch?.[1]) {
    return stripWrappingQuotes(tomlMatch[1]);
  }

  return "";
}

function extractHeadingTitle(markdown, pattern = /^#\s+(.+)$/m) {
  const withoutFrontmatter = stripFrontmatter(markdown);
  const withoutToc = stripTocBlock(withoutFrontmatter);
  const headingMatch = withoutToc.match(pattern);
  if (!headingMatch?.[1]) {
    return "";
  }

  return headingMatch[1]
    .replace(/`/g, "")
    .replace(/!?\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~]/g, "")
    .trim();
}

function fallbackTitleFromUrl(normalizedUrl) {
  const url = new URL(normalizedUrl);
  const segments = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const lastSegment = segments.length > 0 ? segments[segments.length - 1] : undefined;
  if (lastSegment) {
    return decodeURIComponent(lastSegment);
  }

  return url.hostname;
}

function deriveCacheTitle(markdown, normalizedUrl) {
  return (
    extractFrontmatterTitle(markdown) ||
    extractHeadingTitle(markdown, /^#\s+(.+)$/m) ||
    fallbackTitleFromUrl(normalizedUrl) ||
    extractHeadingTitle(markdown, /^#{1,6}\s+(.+)$/m)
  );
}

function buildTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function buildCacheFileName(markdown, normalizedUrl) {
  const url = new URL(normalizedUrl);
  const title = deriveCacheTitle(markdown, normalizedUrl);
  const safeTitle = normalizeForFileName(title) || "document";
  const domain = normalizeForFileName(url.hostname.replace(/^www\./, "")) || "site";
  const timestamp = buildTimestamp();
  const hash = createHash("sha256").update(`${normalizedUrl}\n${markdown}`).digest("hex").slice(0, 10);
  const fileName = `${safeTitle}-${domain}-${timestamp}-${hash}.md`;

  return {
    absolutePath: "",
    domain,
    fileName,
    hash,
    relativePath: join(CACHE_DIR_NAME, fileName),
    timestamp,
    title,
  };
}

function urlPathToMirrorSegments(normalizedUrl) {
  const url = new URL(normalizedUrl);
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => normalizeForFileName(decodeURIComponent(segment)) || "segment");

  if (segments.length === 0 || normalizedUrl.endsWith("/")) {
    segments.push("index");
  }

  const lastIndex = segments.length - 1;
  const rawLastSegment = url.pathname.split("/").filter(Boolean).pop() ?? "";
  if (/\.[a-z0-9]+$/i.test(rawLastSegment)) {
    segments[lastIndex] = segments[lastIndex].replace(/-[a-z0-9]+$/, "") || "index";
  }

  return segments;
}

function buildRecursiveCacheDetails(normalizedUrl) {
  const url = new URL(normalizedUrl);
  const segments = urlPathToMirrorSegments(normalizedUrl);
  const querySuffix = url.search ? `-${normalizeForFileName(url.search.slice(1)) || "query"}` : "";
  const fileName = `${segments.pop() ?? "index"}${querySuffix}.md`;
  const relativePath = join(CACHE_DIR_NAME, url.hostname, ...segments, fileName);
  const title = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? url.hostname);

  return {
    absolutePath: "",
    domain: normalizeForFileName(url.hostname.replace(/^www\./, "")) || "site",
    fileName,
    hash: createHash("sha256").update(normalizedUrl).digest("hex").slice(0, 10),
    relativePath,
    timestamp: buildTimestamp(),
    title,
  };
}

async function writeCacheFile(markdown, normalizedUrl, cwd) {
  const cache = buildCacheFileName(markdown, normalizedUrl);
  const cacheDir = resolve(cwd, CACHE_DIR_NAME);
  const absolutePath = resolve(cacheDir, cache.fileName);

  await mkdir(cacheDir, { recursive: true });
  await writeFile(absolutePath, `${normalizeText(markdown)}\n`, "utf8");

  return {
    ...cache,
    absolutePath,
  };
}

async function writeRecursiveCacheFile(markdown, normalizedUrl, cwd) {
  const cache = buildRecursiveCacheDetails(normalizedUrl);
  const absolutePath = resolve(cwd, cache.relativePath);

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${normalizeText(markdown)}\n`, "utf8");

  return {
    ...cache,
    absolutePath,
  };
}

function buildManifestCacheDetails(rootUrl, payload) {
  const url = new URL(rootUrl);
  const title = `crawl-${normalizeForFileName(url.hostname)}${url.pathname === "/" ? "" : `-${normalizeForFileName(url.pathname)}`}`;
  const safeTitle = normalizeForFileName(title) || "crawl";
  const domain = normalizeForFileName(url.hostname.replace(/^www\./, "")) || "site";
  const timestamp = buildTimestamp();
  const hash = createHash("sha256").update(`${rootUrl}\n${payload}`).digest("hex").slice(0, 10);
  const fileName = `${safeTitle}-${domain}-${timestamp}-${hash}.json`;

  return {
    absolutePath: "",
    domain,
    fileName,
    hash,
    relativePath: join(CACHE_DIR_NAME, MANIFEST_DIR_NAME, fileName),
    timestamp,
    title,
  };
}

async function writeManifestFile(rootUrl, manifest, cwd) {
  const payload = `${JSON.stringify(manifest, null, 2)}\n`;
  const cache = buildManifestCacheDetails(rootUrl, payload);
  const cacheDir = resolve(cwd, CACHE_DIR_NAME, MANIFEST_DIR_NAME);
  const absolutePath = resolve(cacheDir, cache.fileName);

  await mkdir(cacheDir, { recursive: true });
  await writeFile(absolutePath, payload, "utf8");

  return {
    ...cache,
    absolutePath,
  };
}

function renderOutput(markdown, cache, requestedMode) {
  const tocBlock = extractTocBlock(markdown);
  const tocAvailable = tocHasEntries(tocBlock);
  const effectiveMode = requestedMode === "toc-only" && !tocAvailable ? "path-only" : requestedMode;

  if (effectiveMode === "path-only") {
    return {
      text: cache.relativePath,
      details: {
        effectiveMode,
        requestedMode,
        tocAvailable,
      },
    };
  }

  if (effectiveMode === "toc-only") {
    return {
      text: `Path: ${cache.relativePath}\n\n${tocBlock}`,
      details: {
        effectiveMode,
        requestedMode,
        tocAvailable,
      },
    };
  }

  return {
    text: `Path: ${cache.relativePath}\n\n${markdown}`,
    details: {
      effectiveMode,
      requestedMode,
      tocAvailable,
    },
  };
}

function injectTocBlock(markdown) {
  if (markdown.includes("<!-- TOC START") || markdown.includes("<!-- TOC END")) {
    return { markdown, tocInjected: false };
  }

  if (!hasTocEligibleHeadings(markdown)) {
    return { markdown, tocInjected: false };
  }

  const { frontmatter, body } = splitLeadingFrontmatter(markdown);
  const tocBlock = `${TOC_START}\n\n${TOC_END}`;

  if (frontmatter) {
    return {
      markdown: `${frontmatter}\n\n${tocBlock}${body ? `\n\n${body}` : ""}`,
      tocInjected: true,
    };
  }

  return {
    markdown: `${tocBlock}${body ? `\n\n${body}` : ""}`,
    tocInjected: true,
  };
}

async function normalizeMarkdown(markdown) {
  const input = normalizeText(markdown);
  const prepared = injectTocBlock(input);

  try {
    const result = await formatFromString(
      prepared.markdown,
      {
        watermark: "none",
        escapeGithubAdmonitions: false,
      },
      {},
    );

    const normalized = normalizeText(typeof result.value === "string" ? result.value : String(result.value ?? ""));
    if (!normalized || isBlankMarkdown(normalized)) {
      throw new Error("markdown formatter returned blank markdown.");
    }

    return {
      markdown: normalized,
      details: {
        ok: true,
        changed: normalized !== input,
        formatterMessages: result.messages.map((message) => String(message.reason ?? message.message ?? message)),
        tocInjected: prepared.tocInjected,
      },
    };
  } catch (error) {
    return {
      markdown: input,
      details: {
        ok: false,
        changed: false,
        formatterMessages: [],
        tocInjected: false,
        error: formatError(error).message,
      },
    };
  }
}

async function fetchAndNormalizeUrl(normalizedUrl, options = {}) {
  const timeoutMs = clampInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const attempts = [];
  const headers = { ...defaultRequestHeaders, ...(options.headers ?? {}) };

  for (const source of buildSources(normalizedUrl, Boolean(options.rawOnly))) {
    try {
      const result = await fetchAttempt(source.source, source.requestUrl, timeoutMs, options.signal, headers);
      const normalized = await normalizeMarkdown(result.markdown);
      attempts.push(result.attempt);
      return {
        attempts,
        markdown: normalized.markdown,
        normalization: normalized.details,
        normalizedUrl,
        source: source.source,
        timeoutMs,
      };
    } catch (error) {
      const formatted = formatError(error);
      attempts.push({
        source: source.source,
        requestUrl: source.requestUrl,
        ok: false,
        status: formatted.status,
        contentType: formatted.contentType,
        error: formatted.message,
      });
    }
  }

  throw new Error(
    `webfetch failed for ${normalizedUrl}. Attempts: ${attempts
      .map((attempt) => `${attempt.source}: ${attempt.error ?? "unknown error"}`)
      .join(" | ")}`,
  );
}

export async function fetchUrl(inputUrl, options = {}) {
  const normalizedUrl = normalizeUrl(inputUrl);
  const requestedMode = options.outputMode ?? DEFAULT_OUTPUT_MODE;
  const cwd = options.cwd ?? process.cwd();
  const page = await fetchAndNormalizeUrl(normalizedUrl, options);
  const cache = await writeCacheFile(page.markdown, normalizedUrl, cwd);
  const output = renderOutput(page.markdown, cache, requestedMode);

  return {
    text: output.text,
    details: {
      attempts: page.attempts,
      cache,
      normalization: page.normalization,
      output: output.details,
      normalizedUrl,
      source: page.source,
      timeoutMs: page.timeoutMs,
    },
  };
}

function normalizeParentDomain(input) {
  return String(input ?? "").trim().replace(/^\.+|\.+$/g, "").toLowerCase();
}

function isAllowedHost(hostname, parentDomain) {
  const normalizedHost = normalizeParentDomain(hostname);
  const normalizedParent = normalizeParentDomain(parentDomain);
  return normalizedHost === normalizedParent || normalizedHost.endsWith(`.${normalizedParent}`);
}

function shouldSkipDiscoveredUrl(rawHref) {
  return !rawHref || /^(#|mailto:|tel:|javascript:|data:)/i.test(rawHref.trim());
}

function shouldSkipDiscoveredPage(normalizedUrl, allowQuery) {
  const url = new URL(normalizedUrl);
  const path = url.pathname.toLowerCase();

  if (url.search && !allowQuery) {
    return "has-query";
  }

  if (/\.(?:png|jpe?g|gif|webp|svg|pdf|zip|gz|tgz|bz2|xz|7z|tar|whl|exe|dmg|mp4|mp3|json|xml|rss)$/i.test(path)) {
    return "non-doc-asset";
  }

  if (/(^|\/)(download|downloads|search|genindex|py-modindex|bugs?|issue|issues|github|gitlab|bitbucket|changelog)(\/|$)/i.test(path)) {
    return "non-doc-page";
  }

  return null;
}

function getAllowedPathPrefix(rootUrl) {
  const pathname = new URL(rootUrl).pathname;
  const normalizedPath = pathname === "/" ? "/" : pathname.replace(/\/+$/, "");
  const lastSlash = normalizedPath.lastIndexOf("/");
  if (lastSlash <= 0) {
    return "/";
  }
  return `${normalizedPath.slice(0, lastSlash + 1)}`;
}

function isWithinAllowedPath(normalizedUrl, allowedPathPrefix) {
  const pathname = new URL(normalizedUrl).pathname;
  return allowedPathPrefix === "/" || pathname === allowedPathPrefix.slice(0, -1) || pathname.startsWith(allowedPathPrefix);
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= items.length) {
          return;
        }
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    }),
  );

  return results;
}

function discoverLinks(markdown, baseUrl) {
  const discovered = new Map();
  const source = stripTocBlock(markdown);
  const patterns = [/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, /<((?:https?:\/\/|\/)[^>\s]+)>/g];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const href = match[1]?.trim();
      if (!href || shouldSkipDiscoveredUrl(href)) {
        continue;
      }

      try {
        const resolved = new URL(href, baseUrl);
        if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
          continue;
        }
        resolved.hash = "";
        const normalizedUrl = resolved.toString();
        const canonicalUrl = canonicalizeCrawlUrl(normalizedUrl);
        if (!discovered.has(canonicalUrl)) {
          discovered.set(canonicalUrl, normalizedUrl);
        }
      } catch {
        continue;
      }
    }
  }

  return [...discovered.entries()].map(([canonicalUrl, url]) => ({ canonicalUrl, url }));
}

function toPosixPath(path) {
  return path.replace(/\\/g, "/");
}

function buildRelativeMarkdownLink(fromPath, toPath, hash) {
  const rel = toPosixPath(relative(dirname(fromPath), toPath)) || ".";
  return `${rel}${hash}`;
}

function rewriteMarkdownLinks(markdown, baseUrl, currentPath, pathByUrl) {
  const replacer = (rawHref) => {
    if (shouldSkipDiscoveredUrl(rawHref)) {
      return null;
    }

    try {
      const resolved = new URL(rawHref, baseUrl);
      const hash = resolved.hash;
      const targetPath = pathByUrl.get(canonicalizeCrawlUrl(resolved.toString()));
      if (!targetPath) {
        return null;
      }
      return buildRelativeMarkdownLink(currentPath, targetPath, hash);
    } catch {
      return null;
    }
  };

  const rewrittenLinks = markdown.replace(/(\[[^\]]*\]\()([^\)\s]+)([^\)]*\))/g, (full, prefix, href, suffix) => {
    const nextHref = replacer(href);
    return nextHref ? `${prefix}${nextHref}${suffix}` : full;
  });

  return rewrittenLinks.replace(/<((?:https?:\/\/|\/)[^>\s]+)>/g, (full, href) => {
    const nextHref = replacer(href);
    return nextHref ? `<${nextHref}>` : full;
  });
}

function renderCrawlSummary(manifestPath, crawl) {
  const lines = [
    `Manifest: ${manifestPath}`,
    `Root: ${crawl.rootUrl}`,
    `Allowed parent domain: ${crawl.allowedParentDomain}`,
    `Allowed parent path: ${crawl.allowedPathPrefix}`,
    `Fetched pages: ${crawl.fetchedPages.length}/${crawl.limits.maxPages}`,
    `Visited URLs: ${crawl.visitedCount}`,
    `Max hops: ${crawl.limits.maxHops}`,
    `Stopped because: ${crawl.stoppedBecause}`,
  ];

  if (crawl.failures.length > 0) {
    lines.push(`Failures: ${crawl.failures.length}`);
  }

  if (crawl.skippedLinks.length > 0) {
    lines.push(`Skipped links: ${crawl.skippedLinks.length}`);
  }

  if (crawl.fetchedPages.length > 0) {
    lines.push("", "Pages:");
    for (const page of crawl.fetchedPages.slice(0, MAX_SUMMARY_PAGES)) {
      lines.push(`- [${page.depth}] ${page.normalizedUrl} -> ${page.cache.relativePath}`);
    }
    if (crawl.fetchedPages.length > MAX_SUMMARY_PAGES) {
      lines.push(`- ... ${crawl.fetchedPages.length - MAX_SUMMARY_PAGES} more pages in manifest`);
    }
  }

  return lines.join("\n");
}

export async function crawlUrl(inputUrl, options = {}) {
  const rootUrl = normalizeUrl(inputUrl);
  const rootCanonicalUrl = canonicalizeCrawlUrl(rootUrl);
  const timeoutMs = clampInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxHops = clampInteger(options.maxHops, DEFAULT_MAX_HOPS, 0, 10);
  const maxPages = clampInteger(options.maxPages, DEFAULT_MAX_PAGES, 1, 500);
  const maxLinksPerPage = clampInteger(options.maxLinksPerPage, DEFAULT_MAX_LINKS_PER_PAGE, 1, 500);
  const crawlConcurrency = clampInteger(options.concurrency, DEFAULT_CRAWL_CONCURRENCY, 1, 32);
  const cwd = options.cwd ?? process.cwd();
  const outputMode = options.outputMode ?? DEFAULT_CRAWL_OUTPUT_MODE;
  const allowedParentDomain = normalizeParentDomain(options.parentDomain || new URL(rootUrl).hostname);
  const allowedPathPrefix = getAllowedPathPrefix(rootUrl);
  const allowQuery = Boolean(options.allowQuery);
  const activeSignal = ensureAbortSignal(options.signal);

  if (!allowedParentDomain) {
    throw new Error("parentDomain resolved to an empty value.");
  }

  let frontier = [{ url: rootUrl, canonicalUrl: rootCanonicalUrl, depth: 0, discoveredFrom: null }];
  const queued = new Set([rootCanonicalUrl]);
  const visited = new Set();
  const fetchedPages = [];
  const recursivePages = [];
  const skippedLinks = [];
  const failures = [];

  while (frontier.length > 0 && recursivePages.length < maxPages) {
    if (activeSignal.aborted) {
      throw new Error("crawl aborted.");
    }

    const remainingSlots = maxPages - recursivePages.length;
    const batch = frontier.slice(0, remainingSlots);
    frontier = frontier.slice(batch.length);

    for (const current of batch) {
      visited.add(current.canonicalUrl);
    }

    options.onUpdate?.({
      fetchedPages: recursivePages.length,
      maxHops,
      maxLinksPerPage,
      maxPages,
      pending: frontier.length,
      rootUrl,
      batchSize: batch.length,
      depth: batch[0]?.depth ?? 0,
    });

    const batchResults = await mapWithConcurrency(batch, crawlConcurrency, async (current) => {
      try {
        const page = await fetchAndNormalizeUrl(current.url, {
          ...options,
          timeoutMs,
          signal: activeSignal,
        });
        const title = deriveCacheTitle(page.markdown, page.normalizedUrl) || fallbackTitleFromUrl(page.normalizedUrl);
        const links = discoverLinks(page.markdown, page.normalizedUrl);

        return {
          current,
          links,
          page: {
            attempts: page.attempts,
            cache: buildRecursiveCacheDetails(current.url),
            canonicalUrl: current.canonicalUrl,
            depth: current.depth,
            discoveredFrom: current.discoveredFrom,
            linkCount: links.length,
            markdown: page.markdown,
            normalizedUrl: current.url,
            source: page.source,
            title,
          },
        };
      } catch (error) {
        failures.push({
          depth: current.depth,
          discoveredFrom: current.discoveredFrom,
          error: formatError(error).message,
          url: current.url,
        });
        return { current, links: [], page: null };
      }
    });

    for (const result of batchResults) {
      if (!result.page) {
        continue;
      }

      recursivePages.push(result.page);

      if (result.current.depth >= maxHops) {
        continue;
      }

      let acceptedLinks = 0;
      for (const discoveredLink of result.links) {
        if (queued.has(discoveredLink.canonicalUrl) || visited.has(discoveredLink.canonicalUrl)) {
          continue;
        }

        const skippedReason = shouldSkipDiscoveredPage(discoveredLink.url, allowQuery);
        if (skippedReason) {
          skippedLinks.push({
            from: result.page.normalizedUrl,
            reason: skippedReason,
            to: discoveredLink.url,
          });
          continue;
        }

        const hostname = new URL(discoveredLink.url).hostname;
        if (!isAllowedHost(hostname, allowedParentDomain)) {
          skippedLinks.push({
            from: result.page.normalizedUrl,
            reason: `outside-parent-domain:${allowedParentDomain}`,
            to: discoveredLink.url,
          });
          continue;
        }

        if (!isWithinAllowedPath(discoveredLink.url, allowedPathPrefix)) {
          skippedLinks.push({
            from: result.page.normalizedUrl,
            reason: `outside-parent-path:${allowedPathPrefix}`,
            to: discoveredLink.url,
          });
          continue;
        }

        if (acceptedLinks >= maxLinksPerPage) {
          skippedLinks.push({
            from: result.page.normalizedUrl,
            reason: `per-page-link-cap:${maxLinksPerPage}`,
            to: discoveredLink.url,
          });
          continue;
        }

        acceptedLinks += 1;
        queued.add(discoveredLink.canonicalUrl);
        frontier.push({
          url: discoveredLink.url,
          canonicalUrl: discoveredLink.canonicalUrl,
          depth: result.current.depth + 1,
          discoveredFrom: result.page.normalizedUrl,
        });
      }
    }
  }

  const pathByUrl = new Map();
  for (const page of recursivePages) {
    pathByUrl.set(page.canonicalUrl, page.cache.relativePath);
  }

  for (const page of recursivePages) {
    const rewrittenMarkdown = rewriteMarkdownLinks(page.markdown, page.normalizedUrl, page.cache.relativePath, pathByUrl);
    const cache = await writeRecursiveCacheFile(rewrittenMarkdown, page.normalizedUrl, cwd);
    fetchedPages.push({
      attempts: page.attempts,
      cache,
      canonicalUrl: page.canonicalUrl,
      depth: page.depth,
      discoveredFrom: page.discoveredFrom,
      linkCount: page.linkCount,
      normalizedUrl: page.normalizedUrl,
      source: page.source,
      title: page.title,
    });
  }

  const crawl = {
    allowedParentDomain,
    allowedPathPrefix,
    failures,
    fetchedAt: new Date().toISOString(),
    fetchedPages,
    limits: {
      maxHops,
      maxPages,
      maxLinksPerPage,
      concurrency: crawlConcurrency,
      timeoutMs,
    },
    rootUrl,
    skippedLinks,
    stoppedBecause: frontier.length > 0 && fetchedPages.length >= maxPages ? "max-pages" : "queue-empty",
    visitedCount: visited.size,
  };

  const manifest = await writeManifestFile(rootUrl, crawl, cwd);
  crawl.manifestPath = manifest.relativePath;
  await writeFile(manifest.absolutePath, `${JSON.stringify(crawl, null, 2)}\n`, "utf8");

  let text;
  if (outputMode === "path-only") {
    text = manifest.relativePath;
  } else if (outputMode === "all") {
    text = `Manifest: ${manifest.relativePath}\n\n${JSON.stringify(crawl, null, 2)}`;
  } else {
    text = renderCrawlSummary(manifest.relativePath, crawl);
  }

  return {
    text,
    details: {
      crawl,
      manifest,
      outputMode,
    },
  };
}
