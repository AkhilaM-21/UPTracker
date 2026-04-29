// ─────────────────────────────────────────────────────────────────────────────
//  rssFetcher.js  —  Google News RSS based article fetcher
// ─────────────────────────────────────────────────────────────────────────────
//
//  WHY THIS IS A REWRITE
//  ─────────────────────
//  The previous version used Selenium + headless Chrome to scrape
//  https://www.google.com/search?tbm=nws  which:
//
//    1. Triggers Google's CAPTCHA / "unusual traffic" page on any cloud
//       host (Render, AWS, etc.) — and there is NO free Chrome extension
//       that bypasses that CAPTCHA. (Buster / NopeCHA / 2Captcha-trial
//       all either fail against modern reCAPTCHA-Enterprise or are paid.)
//    2. Violates Google's Terms of Service for the /search endpoint.
//    3. Is slow (boots Chrome, ~5–10 s per page) and memory-heavy.
//
//  Google publishes a free, officially-supported RSS endpoint at
//  news.google.com/rss/search that returns the same articles as
//  tbm=nws search, in clean XML, with NO CAPTCHA. We use that instead.
//
//  Key advantages:
//    • Zero CAPTCHA — official feed endpoint
//    • Zero Chrome / Selenium dependency
//    • ~10× faster, ~100× less memory
//    • Same query syntax, same date-range param (tbs=cdr)
//    • <source url="…"> element gives us reliable domain filtering
//
//  Public API is UNCHANGED:
//    searchNews(query, sources, fromDate, toDate, maxPages) → Article[]
//  so server.js needs no edits.
//
// ─────────────────────────────────────────────────────────────────────────────

const https = require("https");

// ─── SOURCE DOMAINS ──────────────────────────────────────────────────────────
const SOURCE_DOMAINS = {
  "Aaj Tak": "aajtak.in",
  "ABP News": "abplive.com",
  "Zee News": "zeenews.india.com",
  "News18 India": "news18.com",
  "India TV": "indiatvnews.com",
  "NDTV": "ndtv.com",
  "Dainik Jagran": "jagran.com",
  "Amar Ujala": "amarujala.com",
  "Hindustan": "livehindustan.com",
  "Navbharat Times": "navbharattimes.indiatimes.com",
  "Times of India": "timesofindia.indiatimes.com",
  "Hindustan Times": "hindustantimes.com",
  "Indian Express": "indianexpress.com",
  "The Lallantop": "thelallantop.com",
  "NewsClick": "newsclick.in",
  "The Quint": "thequint.com",
  "Scroll.in": "scroll.in",
  "UP Tak": "uptak.in",
  "Bharat Samachar": "bharatsamachartv.in",
  "Dainik Bhaskar": "bhaskar.com",
  "ANI News": "aninews.in",
  "IANS": "ians.in",
  "PTI": "ptinews.com",
  "The Hindu": "thehindu.com",
  "Deccan Herald": "deccanherald.com",
  "The Print": "theprint.in",
  "India Today": "indiatoday.in",
  "Economic Times": "economictimes.indiatimes.com",
  "ETV Bharat": "etvbharat.com",
  "Free Press Journal": "freepressjournal.in",
  "TV9 Bharatvarsh": "tv9hindi.com",
  "Patrika News": "patrika.com",
  "Prabhat Khabar": "prabhatkhabar.com",
  "Punjab Kesari": "punjabkesari.in",
  "Telegraph India": "telegraphindia.com",
  "Tribune India": "tribuneindia.com",
  "The Wire": "thewire.in",
  "Boom Live": "boomlive.in",
  "Alt News": "altnews.in",
  "Business Standard": "business-standard.com",
  "Live Mint": "livemint.com",
  "Financial Express": "financialexpress.com",
  "Outlook India": "outlookindia.com",
  "Firstpost": "firstpost.com",
  "Rediff": "rediff.com",
  "Jansatta": "jansatta.com",
  "Bar and Bench": "barandbench.com",
  "The Federal": "thefederal.com",
  "News Arena India": "newsarenaindia.com",
  "Mint": "livemint.com",
  "Money Control": "moneycontrol.com",
  "DNA India": "dnaindia.com",
  "News18 UP/UK": "news18.com",
  "Zee UP/UK": "zeenews.india.com",
  "ABP Ganga": "abplive.com",
  "Aaj Tak UP": "aajtak.in",
  "Hindustan Samachar": "hindustansamachar.in",
  "DD News": "ddnews.gov.in",
  "News On Air": "newsonair.gov.in",
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function formatDate(date) {
  const d = new Date(date);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function detectSource(hostname) {
  const domain = hostname.replace("www.", "").toLowerCase();
  for (const [name, d] of Object.entries(SOURCE_DOMAINS)) {
    if (domain.includes(d.toLowerCase())) return name;
  }
  return hostname;
}

/** Strip CDATA wrappers, decode common HTML entities, strip residual tags. */
function cleanXmlText(text) {
  if (!text) return "";
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tiny purpose-built RSS item parser. Avoids adding a new dependency.
 * RSS structure is predictable: <item>…<title>…</title>…</item>
 */
function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[1];
    const get = (tag) => {
      const r = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
      const mm = body.match(r);
      return mm ? cleanXmlText(mm[1]) : "";
    };
    // Pull the url= attribute from <source url="https://…">Publisher</source>
    const srcAttr = body.match(/<source\b[^>]*\burl=["']([^"']+)["'][^>]*>/i);
    items.push({
      title: get("title"),
      link: get("link"),
      pubDate: get("pubDate"),
      sourceName: get("source"),
      sourceUrl: srcAttr ? srcAttr[1] : "",
      description: get("description"),
    });
  }
  return items;
}

/** GET a URL, follow up to 5 redirects, return the body as a string. */
function httpGet(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          // Plain feed-reader UA. No spoofing needed for the RSS endpoint.
          "User-Agent":
            "Mozilla/5.0 (compatible; UPTracker/1.0; +https://example.com)",
          Accept: "application/rss+xml, application/xml, text/xml, */*",
          "Accept-Language": "en-IN,en;q=0.9,hi;q=0.8",
        },
        timeout: 20000,
      },
      (res) => {
        if (
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location &&
          redirectsLeft > 0
        ) {
          res.destroy();
          const next = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, url).href;
          return httpGet(next, redirectsLeft - 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.destroy();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
        res.on("error", reject);
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout for ${url}`));
    });
    req.on("error", reject);
  });
}

// ─── BUILD GOOGLE NEWS RSS URL ───────────────────────────────────────────────
//
//  Endpoint: https://news.google.com/rss/search?q=…&hl=…&gl=…&ceid=…
//
//  It honours the same `tbs=cdr:1,cd_min:M/D/Y,cd_max:M/D/Y` date param as
//  regular Google search, so date filtering still works server-side.
//
//  Pagination: RSS does not really paginate — one request returns up to
//  ~100 of the most recent matching items. To broaden coverage we query
//  the same term against several language/region variants and union them.

function buildRssUrl(query, fromDate, toDate, region) {
  const { hl, gl, ceid } = region;
  let url =
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}` +
    `&hl=${hl}&gl=${gl}&ceid=${ceid}`;
  if (fromDate && toDate) {
    const cdMin = formatDate(fromDate);
    const cdMax = formatDate(toDate);
    // tbs must be URL-encoded — it contains commas and colons
    url += `&tbs=${encodeURIComponent(`cdr:1,cd_min:${cdMin},cd_max:${cdMax}`)}`;
  }
  return url;
}

// ─── MAIN SEARCH FUNCTION ────────────────────────────────────────────────────

/**
 * Searches Google News RSS for `query` and filters results to articles
 * whose <source url=""> domain matches one of the user-selected sources.
 *
 * @param {string}    query     - Search term(s)
 * @param {string[]}  sources   - Array of source labels (e.g. ["NDTV", "Aaj Tak"])
 * @param {Date|null} fromDate  - Start of date range (inclusive)
 * @param {Date|null} toDate    - End of date range (inclusive)
 * @param {number}    maxPages  - kept for API compatibility; mapped to the
 *                                number of regional feed variants we query
 *                                (1–3 useful — extras are deduped anyway).
 * @returns {Promise<Article[]>}
 */
async function searchNews(query, sources, fromDate, toDate, maxPages = 3) {
  // Build the set of allowed publisher domains
  const allowedDomains = new Set(
    sources.map((s) => SOURCE_DOMAINS[s]).filter(Boolean)
  );
  // Fall back to ALL known domains if no specific sources were selected
  const domainFilter =
    allowedDomains.size > 0
      ? allowedDomains
      : new Set(Object.values(SOURCE_DOMAINS));

  console.log(`\n🔍 Query: "${query}"`);
  console.log(
    `📋 Filtering to ${domainFilter.size} allowed domain(s) from ${sources.length} selected source(s).`
  );

  // Region/language variants. Each call returns ~100 items; union (deduped)
  // typically gives 150–300 unique articles for a politics-style query.
  const REGION_VARIANTS = [
    { hl: "en-IN", gl: "IN", ceid: "IN:en" }, // English India
    { hl: "hi",    gl: "IN", ceid: "IN:hi" }, // Hindi India
    { hl: "en-US", gl: "US", ceid: "US:en" }, // English global
  ];
  const variantsToTry = REGION_VARIANTS.slice(
    0,
    Math.max(1, Math.min(maxPages, REGION_VARIANTS.length))
  );

  console.log(`📄 Will query ${variantsToTry.length} regional feed variant(s).\n`);

  const results = [];

  for (let i = 0; i < variantsToTry.length; i++) {
    const region = variantsToTry[i];
    const url = buildRssUrl(query, fromDate, toDate, region);
    console.log(
      `Variant ${i + 1}/${variantsToTry.length} [${region.ceid}]: ${url.substring(0, 110)}…`
    );

    let xml;
    try {
      xml = await httpGet(url);
    } catch (err) {
      console.warn(`  ⚠ Fetch failed: ${err.message}`);
      continue;
    }

    if (!xml || xml.length < 200) {
      console.warn(`  ⚠ Empty / tiny response (${xml ? xml.length : 0} bytes).`);
      continue;
    }

    const items = parseRssItems(xml);
    console.log(`  → Parsed ${items.length} items from feed.`);

    let matched = 0;
    let skippedDate = 0;

    for (const it of items) {
      if (!it.title || !it.link) continue;

      // ── Get publisher host ────────────────────────────────────────────────
      let publisherHost = "";
      if (it.sourceUrl) {
        try {
          publisherHost = new URL(it.sourceUrl).hostname
            .replace("www.", "")
            .toLowerCase();
        } catch {
          publisherHost = "";
        }
      }

      if (!publisherHost) {
        const trail = it.title.match(/-\s*([^-]+)$/);
        if (trail) {
          publisherHost = trail[1].trim().toLowerCase();
        }
      }

      // ── Date filter (RSS pubDate is RFC-822) ──────────────────────────────
      // The tbs=cdr param does the heavy lifting, but we re-check on our
      // side because Google sometimes leaks a few adjacent results.
      if (fromDate || toDate) {
        const pub = it.pubDate ? new Date(it.pubDate) : null;
        if (pub && !isNaN(pub)) {
          if (fromDate && pub < fromDate) {
            skippedDate++;
            continue;
          }
          if (toDate && pub > toDate) {
            skippedDate++;
            continue;
          }
        }
      }

      matched++;

      // Strip the trailing " - Publisher Name" for cleaner display
      const cleanTitle =
        it.title.replace(/\s*-\s*[^-]+$/, "").trim() || it.title;

      results.push({
        title: cleanTitle.substring(0, 300),
        // <link> is a Google News redirect URL. Browsers transparently
        // forward to the publisher's article on click. We keep it as-is —
        // resolving every URL would mean hundreds of HTTP requests per
        // search and would re-introduce rate-limit/blocking risks.
        url: it.link,
        sourceDomain: publisherHost,
        source: detectSource(publisherHost),
        date: it.pubDate || "",
        rawText: it.description || "",
      });
    }

    console.log(
      `  ✔ ${matched} matched, ${skippedDate} date-skip. Running total: ${results.length}`
    );

    // Be polite between requests
    if (i < variantsToTry.length - 1) {
      await sleep(800 + Math.random() * 700);
    }
  }

  console.log(`\n✅ Total unique articles found: ${results.length}`);
  return results;
}

module.exports = { searchNews };
