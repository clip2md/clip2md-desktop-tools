import {
  METRIC_KEYS,
  type MetricKey,
  type MetricSnapshot,
} from "../note-properties";
import { nowBeijingDateTime } from "../date-format";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined ? [] : [value];
const schema = /^https?:\/\/schema\.org\/?$/;
const schemaName = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value.match(/^https?:\/\/schema\.org\/([A-Za-z]+)$/)?.[1] ||
      (/^[A-Za-z]+$/.test(value) ? value : undefined)
    : undefined;
const actions = new Map<string, MetricKey>([
  ["ViewAction", "views"],
  ["LikeAction", "likes"],
  ["BookmarkAction", "collects"],
  ["CommentAction", "comments"],
  ["ShareAction", "shares"],
]);
const articleTypes = new Set([
  "Article",
  "BlogPosting",
  "NewsArticle",
  "TechArticle",
  "ScholarlyArticle",
  "SocialMediaPosting",
]);

function knownContext(value: unknown): boolean {
  if (typeof value === "string") return schema.test(value);
  if (object(value))
    return (
      typeof value["@vocab"] === "string" &&
      schema.test(value["@vocab"]) &&
      Object.keys(value).every((key) => ["@vocab", "@language"].includes(key))
    );
  return false;
}
function contextMatches(node: ObjectValue): boolean {
  return !("@context" in node) || knownContext(node["@context"]);
}
function reference(value: unknown): string | undefined {
  return typeof value === "string"
    ? value
    : object(value) && typeof value["@id"] === "string"
      ? value["@id"]
      : undefined;
}
function canonical(value: string, base: string): string | undefined {
  try {
    const url = new URL(value, base);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return;
    url.hash = "";
    for (const key of [...url.searchParams.keys()])
      if (/^utm_/i.test(key) || ["fbclid", "gclid"].includes(key))
        url.searchParams.delete(key);
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/$/, "") || "/";
    return url.href;
  } catch {
    return;
  }
}

/** Selecting a variable is the opt-in; existing templates never acquire metrics. */
export function wantsArticleMetrics(...templates: string[]): boolean {
  return [...METRIC_KEYS, "metrics_captured_at"].some((key) =>
    templates.some((template) => template.includes(`{{${key}}}`)),
  );
}

/** Select only source declarations that identify the current article, without executing scripts. */
function articleGraph(document: Document, url: string, title: string) {
  const nodes: ObjectValue[] = [];
  const add = (value: unknown, inherited = false, depth = 0) => {
    if (depth > 8 || nodes.length >= 1024) return;
    if (Array.isArray(value)) {
      for (const item of value) add(item, inherited, depth + 1);
      return;
    }
    if (!object(value)) return;
    const valid =
      "@context" in value ? knownContext(value["@context"]) : inherited;
    if (!valid) return;
    nodes.push(value);
    if ("@graph" in value) add(value["@graph"], true, depth + 1);
    // A WebPage may identify its actual article inline. Do not walk related
    // articles, comments, lists or embedded videos looking for counters.
    if (array(value["@type"]).some((type) => schemaName(type) === "WebPage"))
      add(value.mainEntity, true, depth + 1);
  };
  for (const script of Array.from(document.scripts).slice(0, 64)) {
    if (
      script.type.split(";")[0].trim().toLowerCase() !== "application/ld+json"
    )
      continue;
    const text = script.textContent || "";
    if (text.length > 1024 * 1024) continue;
    try {
      add(JSON.parse(text));
    } catch {
      /* Invalid metadata must not prevent saving valid article text. */
    }
  }
  const byId = new Map<string, ObjectValue[]>();
  for (const node of nodes) {
    if (typeof node["@id"] !== "string") continue;
    try {
      const id = new URL(node["@id"], url).href;
      byId.set(id, [...(byId.get(id) || []), node]);
    } catch {
      /* Not an addressable graph node. */
    }
  }
  const resolve = (value: unknown): ObjectValue | undefined => {
    if (!object(value)) return;
    if (Object.keys(value).length !== 1 || typeof value["@id"] !== "string")
      return value;
    try {
      const matches = byId.get(new URL(value["@id"], url).href);
      return matches?.length === 1 ? matches[0] : undefined;
    } catch {
      return;
    }
  };
  const articles = nodes.filter(
    (node) =>
      contextMatches(node) &&
      array(node["@type"]).some((type) =>
        articleTypes.has(schemaName(type) || ""),
      ),
  );
  const page = canonical(url, url);
  const normalizeTitle = (value: string) => value.trim().replace(/\s+/g, " ");
  const heading =
    document.querySelector("article h1, main h1")?.textContent ||
    (document.querySelectorAll("h1").length === 1
      ? document.querySelector("h1")?.textContent
      : undefined);
  const selected = articles.filter((node) => {
    const explicit = [...array(node.url), ...array(node.mainEntityOfPage)];
    if (explicit.length)
      return explicit.every((value) => {
        const raw = reference(value);
        return raw !== undefined && canonical(raw, url) === page;
      });
    if (typeof node["@id"] === "string")
      return canonical(node["@id"], url) === page;
    return (
      articles.length === 1 &&
      typeof node.headline === "string" &&
      !!heading &&
      normalizeTitle(node.headline) === normalizeTitle(title) &&
      normalizeTitle(node.headline) === normalizeTitle(heading)
    );
  });
  return { selected, resolve };
}

/** A source declaration is a reason to disclose possible truncation, not proof of completeness. */
export function readArticleAccessWarnings(
  document: Document,
  url: string,
  title: string,
): string[] {
  return articleGraph(document, url, title).selected.some(
    (article) => article.isAccessibleForFree === false,
  )
    ? [
        "原站标注了订阅、付费或注册访问限制，本次仅保存已取得的图文，请从原文核对是否完整",
      ]
    : [];
}

/** Read only source-supplied, unambiguous counters for this article. No script execution or requests. */
export function readArticleMetrics(
  document: Document,
  url: string,
  title: string,
): MetricSnapshot | undefined {
  const { selected, resolve } = articleGraph(document, url, title);
  const observed = new Map<MetricKey, Set<number>>();
  for (const article of selected)
    for (const raw of array(article.interactionStatistic)) {
      const counter = resolve(raw);
      if (
        !counter ||
        !contextMatches(counter) ||
        !array(counter["@type"]).some(
          (type) => schemaName(type) === "InteractionCounter",
        )
      )
        continue;
      if (counter.interactionService !== undefined) {
        const service = resolve(counter.interactionService);
        const serviceUrl = reference(
          service?.url ?? service?.["@id"] ?? counter.interactionService,
        );
        try {
          if (
            !serviceUrl ||
            new URL(serviceUrl, url).origin !== new URL(url).origin
          )
            continue;
        } catch {
          continue;
        }
      }
      if (
        object(counter.interactionType) &&
        !contextMatches(counter.interactionType)
      )
        continue;
      const action = object(counter.interactionType)
        ? (counter.interactionType["@type"] ?? counter.interactionType["@id"])
        : counter.interactionType;
      const key = actions.get(schemaName(action) || "");
      if (!key) continue;
      const rawCount = counter.userInteractionCount;
      const count =
        typeof rawCount === "number"
          ? rawCount
          : typeof rawCount === "string" && /^\d+$/.test(rawCount.trim())
            ? Number(rawCount)
            : NaN;
      if (!Number.isSafeInteger(count) || count < 0) continue;
      if (!observed.has(key)) observed.set(key, new Set());
      observed.get(key)!.add(count);
    }
  const metrics = Object.fromEntries(
    [...observed]
      .filter(([, values]) => values.size === 1)
      .map(([key, values]) => [key, [...values][0]]),
  );
  return Object.keys(metrics).length
    ? { ...metrics, metrics_captured_at: nowBeijingDateTime() }
    : undefined;
}
