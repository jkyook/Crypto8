/**
 * 프로토콜별 인사이트 뉴스: GDELT, Google News RSS, 거버넌스/포럼 RSS, Reddit 검색 등을 병합·중복 제거 후 요약 문자열을 만듭니다.
 * (텔레그램은 공개 API가 없어 공식/대표 채널 웹 보기 링크를 참고용으로만 포함합니다.)
 */

export type ProtocolNewsItem = {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
};

export type ProtocolNewsBundle = {
  items: ProtocolNewsItem[];
  digest: string;
  scannedSources: string[];
};

type SourceFeed = { url: string; label: string; kind: "rss" | "atom" };

type ProtocolProfile = {
  slug: string;
  /** UI/요약에 쓰는 표시 이름 */
  label: string;
  /** Reddit/Google 등 노이즈가 큰 소스에서 제목·URL에 하나 이상 포함돼야 통과 */
  relevanceKeywords: string[];
  googleNewsQueries: string[];
  gdeltQueries: string[];
  feeds: SourceFeed[];
  redditSearchRss: string | null;
  /** 텔레그램·소셜은 크롤링하지 않고 참고 링크 + 안내 문구로만 제공 */
  referenceHubs: ProtocolNewsItem[];
  telegramNote: string;
};

const UA = "Mozilla/5.0 (compatible; Crypto8Insights/1.1; +https://github.com/)";

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'");
}

function stripCdata(s: string): string {
  return s.replace("<![CDATA[", "").replace("]]>", "").trim();
}

function parseGoogleNewsRss(xml: string, defaultSource = "Google News"): ProtocolNewsItem[] {
  const itemBlocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => m[1] ?? "");
  return itemBlocks
    .map((block) => {
      const title = stripCdata(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "");
      const link = decodeXmlEntities(block.match(/<link>([\s\S]*?)<\/link>/i)?.[1]?.trim() ?? "");
      const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim() ?? "";
      const source = stripCdata(block.match(/<source[^>]*>([\s\S]*?)<\/source>/i)?.[1]?.trim() ?? "");
      let publishedAt = "";
      if (pubDate) {
        const t = Date.parse(pubDate);
        publishedAt = Number.isNaN(t) ? "" : new Date(t).toISOString();
      }
      return {
        title: decodeXmlEntities(title),
        source: decodeXmlEntities(source || defaultSource),
        url: decodeXmlEntities(link),
        publishedAt
      };
    })
    .filter((item) => item.title && item.url)
    .slice(0, 8);
}

function parseRss2(xml: string, sourceLabel: string): ProtocolNewsItem[] {
  const itemBlocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => m[1] ?? "");
  return itemBlocks
    .map((block) => {
      const title = stripCdata(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "");
      let link = block.match(/<link>([\s\S]*?)<\/link>/i)?.[1]?.trim() ?? "";
      if (!link) {
        link = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)?.[1]?.trim() ?? "";
      }
      const pubDate =
        block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim() ??
        block.match(/<dc:date>([\s\S]*?)<\/dc:date>/i)?.[1]?.trim() ??
        "";
      let publishedAt = "";
      if (pubDate) {
        const t = Date.parse(pubDate);
        publishedAt = Number.isNaN(t) ? "" : new Date(t).toISOString();
      }
      return {
        title: decodeXmlEntities(title),
        source: sourceLabel,
        url: decodeXmlEntities(link),
        publishedAt
      };
    })
    .filter((item) => item.title && item.url)
    .slice(0, 10);
}

function parseAtom(xml: string, sourceLabel: string): ProtocolNewsItem[] {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((m) => m[1] ?? "");
  return entries
    .map((block) => {
      const title = stripCdata(block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "");
      const linkMatch = block.match(/<link[^>]+href="([^"]+)"/i);
      const link = linkMatch?.[1]?.trim() ?? "";
      const updated = block.match(/<updated>([\s\S]*?)<\/updated>/i)?.[1]?.trim() ?? "";
      let publishedAt = "";
      if (updated) {
        const t = Date.parse(updated);
        publishedAt = Number.isNaN(t) ? "" : new Date(t).toISOString();
      }
      return {
        title: decodeXmlEntities(title),
        source: sourceLabel,
        url: decodeXmlEntities(link),
        publishedAt
      };
    })
    .filter((item) => item.title && item.url)
    .slice(0, 10);
}

function parseGdeltDate(seendate: string): string {
  if (/^\d{14}$/.test(seendate)) {
    const y = Number(seendate.slice(0, 4));
    const mo = Number(seendate.slice(4, 6)) - 1;
    const d = Number(seendate.slice(6, 8));
    const h = Number(seendate.slice(8, 10));
    const mi = Number(seendate.slice(10, 12));
    const s = Number(seendate.slice(12, 14));
    const dt = new Date(Date.UTC(y, mo, d, h, mi, s));
    return Number.isNaN(dt.getTime()) ? "" : dt.toISOString();
  }
  const t = Date.parse(seendate);
  return Number.isNaN(t) ? "" : new Date(t).toISOString();
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/atom+xml, text/xml, */*" },
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

async function fetchGoogleNewsQueries(queries: string[]): Promise<ProtocolNewsItem[]> {
  const out: ProtocolNewsItem[] = [];
  for (const q of queries) {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
    const xml = await fetchText(rssUrl);
    if (xml) {
      out.push(...parseGoogleNewsRss(xml));
    }
  }
  return out;
}

async function fetchGdeltArticles(query: string): Promise<ProtocolNewsItem[]> {
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=8&format=json&sort=datedesc`;
  try {
    const response = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) return [];
    const data = (await response.json()) as {
      articles?: Array<{ title?: string; sourcecommonname?: string; url?: string; seendate?: string }>;
    };
    return (data.articles ?? [])
      .filter((a) => a.title && a.url)
      .map((a) => ({
        title: a.title ?? "",
        source: `GDELT:${a.sourcecommonname ?? "news"}`,
        url: a.url ?? "",
        publishedAt: a.seendate ? parseGdeltDate(a.seendate) : ""
      }))
      .slice(0, 8);
  } catch {
    return [];
  }
}

async function fetchFeed(feed: SourceFeed): Promise<ProtocolNewsItem[]> {
  const xml = await fetchText(feed.url);
  if (!xml) return [];
  if (feed.kind === "atom") {
    return parseAtom(xml, feed.label);
  }
  return parseRss2(xml, feed.label);
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref"].forEach((k) => u.searchParams.delete(k));
    return u.toString();
  } catch {
    return url;
  }
}

function dedupeMerge(items: ProtocolNewsItem[]): ProtocolNewsItem[] {
  const seen = new Set<string>();
  const result: ProtocolNewsItem[] = [];
  for (const item of items) {
    const key = normalizeUrl(item.url).toLowerCase();
    const titleKey = item.title.toLowerCase().slice(0, 72);
    const k2 = `${key}|${titleKey}`;
    if (seen.has(key) || seen.has(k2)) continue;
    seen.add(key);
    seen.add(k2);
    result.push({ ...item, url: normalizeUrl(item.url) });
  }
  return result;
}

function sortByDateDesc(items: ProtocolNewsItem[]): ProtocolNewsItem[] {
  return [...items].sort((a, b) => {
    const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return tb - ta;
  });
}

/** Google News·Reddit·GDELT에서 엉뚱한 헤드라인이 섞이는 경우 제거 */
function passesLooseRelevance(item: ProtocolNewsItem, profile: ProtocolProfile): boolean {
  const text = `${item.title} ${item.url}`.toLowerCase();
  if (item.source === "Reddit" || item.source === "Google News" || item.source.startsWith("GDELT:")) {
    return profile.relevanceKeywords.some((k) => text.includes(k.toLowerCase()));
  }
  return true;
}

function truncateTitle(s: string, max = 110): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function buildHeuristicDigest(label: string, top: ProtocolNewsItem[]): string {
  const lines: string[] = [];
  lines.push(
    `「${label}」에 대해 뉴스·거버넌스/포럼 RSS·GDELT·커뮤니티(Reddit) 신호를 함께 살펴 최근 흐름만 골랐습니다. (원문 링크는 아래 목록)`
  );
  if (top.length === 0) {
    lines.push("· 자동 수집된 최신 헤드라인이 없습니다. 참고 허브 링크와 텔레그램·공식 소셜을 직접 확인해 주세요.");
  } else {
    for (const it of top.slice(0, 5)) {
      lines.push(`· ${truncateTitle(it.title, 118)}`);
    }
  }
  return lines.join("\n");
}

async function maybeOpenAiDigest(label: string, headlines: string[]): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || headlines.length === 0) return null;
  const prompt = [
    `You are a DeFi risk analyst writing for Korean operators.`,
    `Protocol context: ${label}.`,
    `Below are recent headlines/snippets (may mix English/Korean). Write 3–5 short bullet lines in Korean only,`,
    `highlighting only material governance, security, deployment/chain, liquidity/APR, or major partnership news.`,
    `Ignore price speculation and duplicate themes. No links in bullets.`,
    `Headlines:\n- ${headlines.slice(0, 14).join("\n- ")}`
  ].join("\n");
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(25000),
      body: JSON.stringify({
        model: process.env.OPENAI_NEWS_MODEL ?? "gpt-4o-mini",
        temperature: 0.25,
        messages: [
          { role: "system", content: "Respond in Korean only. Be concise and factual." },
          { role: "user", content: prompt }
        ]
      })
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text && text.length > 20 ? text : null;
  } catch {
    return null;
  }
}

function resolveProfile(protocol: string): ProtocolProfile {
  const p = protocol.toLowerCase();
  if (p.includes("aave")) {
    return {
      slug: "aave",
      label: "Aave (Arbitrum/Base 등)",
      relevanceKeywords: ["aave", "gho", "stk", "aavenews", "aave.com", "governance.aave"],
      googleNewsQueries: [
        "Aave V3 Arbitrum OR Base lending",
        "Aave protocol governance GHO",
        "Aave DeFi security incident OR upgrade"
      ],
      gdeltQueries: [
        "aave AND (arbitrum OR base OR ethereum) AND (defi OR lending OR governance OR upgrade)",
        "(aave OR aavenews OR ghoprotocol) AND (defi OR vote OR snapshot)"
      ],
      feeds: [
        { url: "https://governance.aave.com/latest.rss", label: "Aave Governance Forum", kind: "rss" },
        { url: "https://medium.com/feed/aave", label: "Aave Labs (Medium)", kind: "rss" }
      ],
      redditSearchRss: "https://www.reddit.com/r/defi/search.rss?q=aave&restrict_sr=1&sort=new",
      referenceHubs: [
        {
          title: "Aave 거버넌스 포럼 (공식)",
          source: "참고 허브",
          url: "https://governance.aave.com/",
          publishedAt: new Date().toISOString()
        },
        {
          title: "Snapshot — aave.eth 투표",
          source: "참고 허브",
          url: "https://snapshot.org/#/aave.eth",
          publishedAt: new Date().toISOString()
        },
        {
          title: "Aave 공식 사이트 — 푸터의 소셜·커뮤니티(텔레그램 등) 링크 확인",
          source: "참고 허브",
          url: "https://aave.com/",
          publishedAt: new Date().toISOString()
        }
      ],
      telegramNote:
        "텔레그램은 t.me/s/… 공개 미리보기·공식 트위터·Discord와 함께 교차 확인하세요. 미등록·사칭 채널에 주의합니다."
    };
  }
  if (p.includes("uniswap")) {
    return {
      slug: "uniswap",
      label: "Uniswap",
      relevanceKeywords: ["uniswap", "uni v3", "univ3", "v3 pool", "fee switch", "uniswap.org"],
      googleNewsQueries: [
        "Uniswap V3 Arbitrum liquidity",
        "Uniswap governance proposal fee switch",
        "Uniswap Labs announcement"
      ],
      gdeltQueries: ["uniswap AND (v3 OR arbitrum OR governance OR fee) AND (defi OR dex)", "uniswap AND (hack OR exploit OR upgrade)"],
      feeds: [{ url: "https://gov.uniswap.org/latest.rss", label: "Uniswap Governance Forum", kind: "rss" }],
      redditSearchRss: "https://www.reddit.com/r/defi/search.rss?q=uniswap&restrict_sr=1&sort=new",
      referenceHubs: [
        { title: "Uniswap 거버넌스 포럼", source: "참고 허브", url: "https://gov.uniswap.org/", publishedAt: new Date().toISOString() },
        { title: "Uniswap 블로그", source: "참고 허브", url: "https://blog.uniswap.org/", publishedAt: new Date().toISOString() },
        {
          title: "Uniswap Discord (공식 커뮤니티 안내)",
          source: "커뮤니티",
          url: "https://discord.com/invite/uniswap",
          publishedAt: new Date().toISOString()
        }
      ],
      telegramNote: "Uniswap 관련 텔레그램·트레이딩 봇 채널은 사칭이 많으니 Labs/Uniswap Foundation이 안내하는 경로만 사용하세요."
    };
  }
  if (p.includes("orca")) {
    return {
      slug: "orca",
      label: "Orca (Solana)",
      relevanceKeywords: ["orca", "whirlpool", "whirlpools", "orca.so"],
      googleNewsQueries: ["Orca Solana DEX concentrated liquidity", "Orca Whirlpools governance OR hack", "Orca DeFi Solana news"],
      gdeltQueries: ["orca AND (solana OR whirlpool OR dex) AND (defi OR liquidity OR hack)", "orca.so AND (upgrade OR announcement)"],
      feeds: [{ url: "https://medium.com/feed/orca-so", label: "Orca (Medium)", kind: "rss" }],
      redditSearchRss: "https://www.reddit.com/r/solana/search.rss?q=orca&restrict_sr=1&sort=new",
      referenceHubs: [
        { title: "Orca 공식 블로그", source: "참고 허브", url: "https://www.orca.so/blog", publishedAt: new Date().toISOString() },
        { title: "Orca X(트위터)", source: "소셜", url: "https://x.com/orca_so", publishedAt: new Date().toISOString() },
        {
          title: "Solana DeFi 커뮤니티 (Reddit r/solana)",
          source: "Reddit",
          url: "https://www.reddit.com/r/solana/",
          publishedAt: new Date().toISOString()
        }
      ],
      telegramNote: "Solana 생태계 텔레그램은 비공식 채널이 많습니다. Orca 공지는 X·블로그·Discord를 우선 확인하세요."
    };
  }
  const tokens = protocol
    .toLowerCase()
    .replace(/[()/,]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2)
    .slice(0, 8);
  const q = tokens[0] ?? protocol;
  return {
    slug: "generic",
    label: protocol,
    relevanceKeywords: tokens.length ? tokens : [protocol.toLowerCase()],
    googleNewsQueries: [`${protocol} crypto defi`, `${protocol} governance OR protocol`],
    gdeltQueries: [`"${protocol}" AND (defi OR crypto OR blockchain)`],
    feeds: [],
    redditSearchRss: `https://www.reddit.com/r/defi/search.rss?q=${encodeURIComponent(q)}&restrict_sr=1&sort=new`,
    referenceHubs: [],
    telegramNote: "공식 거버넌스·블로그·등록 소셜과 교차 확인하세요."
  };
}

export async function gatherProtocolInsightsNews(protocol: string): Promise<ProtocolNewsBundle> {
  const profile = resolveProfile(protocol);
  const scanned: string[] = [];

  const tasks: Promise<ProtocolNewsItem[]>[] = [];

  tasks.push(
    (async () => {
      const items = await fetchGoogleNewsQueries(profile.googleNewsQueries);
      scanned.push(`Google News (${profile.googleNewsQueries.length}쿼리)`);
      return items;
    })()
  );

  for (const q of profile.gdeltQueries) {
    tasks.push(
      (async () => {
        const items = await fetchGdeltArticles(q);
        if (items.length) scanned.push(`GDELT:${q.slice(0, 48)}…`);
        return items;
      })()
    );
  }

  for (const feed of profile.feeds) {
    tasks.push(
      (async () => {
        const items = await fetchFeed(feed);
        if (items.length) scanned.push(feed.label);
        return items;
      })()
    );
  }

  if (profile.redditSearchRss) {
    tasks.push(
      (async () => {
        const xml = await fetchText(profile.redditSearchRss);
        if (!xml) return [];
        const isAtom = xml.includes("<feed");
        const items = isAtom ? parseAtom(xml, "Reddit") : parseRss2(xml, "Reddit");
        if (items.length) scanned.push("Reddit search RSS");
        return items;
      })()
    );
  }

  const chunks = await Promise.all(tasks);
  let merged = chunks.flat();
  merged.push(...profile.referenceHubs);

  merged = dedupeMerge(merged);
  merged = merged.filter((item) => passesLooseRelevance(item, profile));
  merged = sortByDateDesc(merged);

  const topForUi = merged.slice(0, 14);
  const topForDigest = merged.filter((x) => !profile.referenceHubs.some((h) => h.url === x.url)).slice(0, 12);

  const aiDigest = await maybeOpenAiDigest(
    profile.label,
    topForDigest.map((i) => `${i.title} (${i.source})`)
  );
  const heuristic = buildHeuristicDigest(profile.label, topForDigest.length ? topForDigest : merged);
  const digest = aiDigest
    ? `${aiDigest}\n\n───\n${heuristic}\n\n※ ${profile.telegramNote}`
    : `${heuristic}\n\n※ ${profile.telegramNote}`;

  return {
    items: topForUi,
    digest,
    scannedSources: [...new Set([...scanned, "참고 허브·텔레그램 링크"])]
  };
}
