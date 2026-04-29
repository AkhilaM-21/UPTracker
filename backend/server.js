require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { searchNews } = require("./rssFetcher");
const { analyseText } = require("./sentimentEngine");
const https = require("https");

const app = express();
app.set("trust proxy", true);
const PORT = process.env.PORT || 4000;

function translateText(text) {
  if (!text || !/[^\x00-\x7F]/.test(text)) return Promise.resolve(text);
  return new Promise((resolve) => {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(text)}`;
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve(json[0].map(item => item[0]).join(""));
        } catch { resolve(text); }
      });
    }).on("error", () => resolve(text));
  });
}

const SYNONYM_MAP = {
  "up": "Uttar Pradesh",
  "यूपी": "Uttar Pradesh",
  "उत्तर प्रदेश": "Uttar Pradesh",
  "sp": "Samajwadi Party",
  "सपा": "Samajwadi Party",
  "समाजवादी पार्टी": "Samajwadi Party",
  "bjp": "BJP",
  "भाजपा": "BJP",
  "भारतीय जनता पार्टी": "BJP",
  "bsp": "Bahujan Samaj Party",
  "बसपा": "Bahujan Samaj Party",
  "बहुजन समाज पार्टी": "Bahujan Samaj Party",
  "congress": "Congress",
  "कांग्रेस": "Congress",
  "aap": "Aam Aadmi Party",
  "आप": "Aam Aadmi Party",
  "आम आदमी पार्टी": "Aam Aadmi Party",
  "rld": "Rashtriya Lok Dal",
  "रालोद": "Rashtriya Lok Dal",
  "nda": "NDA",
  "एनडीए": "NDA"
};

function expandFuzzy(term) {
  const t = term.toLowerCase().trim().replace(/"/g, '');
  if (SYNONYM_MAP[t]) return SYNONYM_MAP[t];
  return term;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "X-Requested-With,content-type,Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});
app.use(express.json({ limit: "10mb" }));

const limiter = rateLimit({
  windowMs: 2 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => true
});

app.use("/api/", limiter);

app.get("/health", (_req, res) => res.json({ status: "ok", time: new Date() }));

// ─── URL METADATA LOOKUP — for "Import from Document" feature ─────────────────
// Accepts: { urls: ["https://...", "https://...", ...] }
// Returns: [{ url, title, source, date }]

const http = require("http");

function fetchPageMeta(url, retries = 0) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.warn(`⏱️  Timeout fetching: ${url}`);
      resolve(null);
    }, 15000); // 15s timeout

    const mod = url.startsWith("https") ? https : http;
    
    const userAgents = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Safari/605.1.15",
    ];
    const ua = userAgents[Math.floor(Math.random() * userAgents.length)];

    const options = {
      headers: {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Cache-Control": "max-age=0",
      },
      timeout: 14000
    };

    const req = mod.get(url, options, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        clearTimeout(timeout);
        console.log(`📍 Redirect: ${res.statusCode} -> ${res.headers.location}`);
        return fetchPageMeta(res.headers.location, retries).then(resolve);
      }

      // Accept successful responses and tolerate some errors (403, etc)
      if (res.statusCode !== 200 && res.statusCode !== 403) {
        console.warn(`⚠️  Status ${res.statusCode} for ${url}`);
        clearTimeout(timeout);
        if ((res.statusCode === 500 || res.statusCode === 502 || res.statusCode === 503) && retries < 2) {
          console.log(`🔄 Retrying ${url}...`);
          return setTimeout(() => fetchPageMeta(url, retries + 1).then(resolve), 1500);
        }
        return resolve(null);
      }

      let html = "";
      res.setEncoding("utf8");
      
      res.on("data", chunk => { 
        html += chunk; 
        if (html.length > 200000) {
          res.destroy();
          console.log(`📦 HTML size limit reached for ${url}, processing...`);
        }
      });
      
      res.on("end", () => {
        clearTimeout(timeout);
        try {
          if (!html || html.length < 500) {
            console.warn(`⚠️  Minimal/no HTML content for: ${url}`);
            resolve(null);
            return;
          }

          // Extract og:title
          const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
                       || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1];

          // Extract <title> as fallback
          const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();

          // Extract og:site_name
          const siteName = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1]
                        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i)?.[1];

          // Extract og:published_time / article:published_time
          const pubTime = html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i)?.[1]
                       || html.match(/<meta[^>]+property=["']og:updated_time["'][^>]+content=["']([^"']+)["']/i)?.[1];

          const title = (ogTitle || titleTag || "").replace(/\s+/g, " ").trim().substring(0, 300);
          const hostname = new URL(url).hostname.replace("www.", "");

          if (title && title.length > 5) {
            console.log(`✅ Fetched: ${hostname} - "${title.substring(0, 60)}..."`);
            resolve({
              url,
              title,
              source: siteName || hostname,
              date: pubTime ? pubTime.slice(0, 10) : new Date().toISOString().slice(0, 10),
            });
          } else {
            console.warn(`⚠️  No valid title extracted for: ${url}`);
            resolve(null);
          }
        } catch (err) {
          console.error(`❌ Parse error for ${url}:`, err.message);
          resolve(null);
        }
      });
      
      res.on("error", (err) => { 
        clearTimeout(timeout);
        console.error(`❌ Response error for ${url}:`, err.message);
        resolve(null); 
      });
    });

    req.on("error", (err) => { 
      clearTimeout(timeout);
      console.error(`❌ Request error for ${url}:`, err.message);
      if (err.code === 'ENOTFOUND') {
        console.log(`   (DNS error - domain not found)`);
      }
      resolve(null); 
    });

    req.on("timeout", () => {
      req.destroy();
      clearTimeout(timeout);
      console.warn(`⏱️  Request timeout after 14s for: ${url}`);
      resolve(null);
    });
  });
}

app.post("/api/lookup-urls", async (req, res) => {
  try {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: "Provide an array of URLs." });
    }

    const clean = urls.map(u => String(u).trim()).filter(u => u.startsWith("http"));
    if (clean.length === 0) return res.json({ articles: [] });

    // Check for Google search URLs and warn
    const googleSearchUrls = clean.filter(u => u.includes("google.com/search"));
    const validUrls = clean.filter(u => !u.includes("google.com/search"));

    let warningMsg = "";
    if (googleSearchUrls.length > 0) {
      warningMsg = `Skipped ${googleSearchUrls.length} Google search URL(s) - please paste direct article links instead.`;
    }

    if (validUrls.length === 0) {
      return res.json({ 
        articles: [],
        warning: warningMsg || "No valid article URLs found. Please paste direct links to articles, not search results."
      });
    }

    console.log(`\n🔍 Fetching metadata for ${validUrls.length} URL(s)...`);
    
    // Process in parallel batches of 3 (reduced from 5 for stability)
    const results = [];
    const failed = [];
    for (let i = 0; i < validUrls.length; i += 3) {
      const batch = validUrls.slice(i, i + 3);
      const settled = await Promise.all(batch.map(u => fetchPageMeta(u)));
      settled.forEach((r, idx) => { 
        if (r && r.title) {
          results.push(r);
        } else {
          failed.push(batch[idx]);
        }
      });
    }

    console.log(`📊 Results: ${results.length}/${validUrls.length} successful, ${failed.length} failed`);
    
    if (failed.length > 0) {
      console.log(`Failed URLs:`, failed.join(", "));
    }

    return res.json({ 
      articles: results,
      warning: warningMsg || null,
      failedUrls: failed.length > 0 ? failed : null
    });
  } catch (error) {
    console.error("Lookup error:", error);
    return res.status(500).json({ error: "Internal server error during URL lookup." });
  }
});


app.post("/api/analyze", async (req, res) => {
  const { sources, keywords, fromDate, toDate } = req.body;

  if (!sources || !Array.isArray(sources) || sources.length === 0) {
    return res.status(400).json({ error: "Provide at least one source." });
  }

  const from = fromDate ? new Date(fromDate) : null;
  const to = toDate ? new Date(toDate) : null;
  if (from && isNaN(from)) return res.status(400).json({ error: "Invalid fromDate." });
  if (to && isNaN(to)) return res.status(400).json({ error: "Invalid toDate." });
  if (to) to.setHours(23, 59, 59, 999);

  // Build multiple queries for looping
  let queries = [];
  if (keywords && keywords.trim()) {
    const phrases = keywords.split(",").map(p => p.trim()).filter(Boolean);
    for (let phrase of phrases) {
      const andParts = phrase.split("+").map(t => t.trim()).filter(Boolean);

      // Expand each part: try whole part first, then word-by-word
      // e.g. "sp" → "Samajwadi Party", "सपा" → "Samajwadi Party"
      //      "up budget" → "Uttar Pradesh budget"
      const expandedParts = andParts.map(part => {
        const wholeTry = expandFuzzy(part);
        if (wholeTry !== part) return wholeTry; // matched as a whole phrase
        // Otherwise expand word by word
        return part.split(/\s+/).map(w => expandFuzzy(w)).join(" ");
      });

      const finalQ = expandedParts.join(" ");
      console.log(`  Abbreviation expansion: "${phrase}" → "${finalQ}"`);
      queries.push(finalQ);
    }
  } else {
    queries = ["politics OR राजनीति"];
  }

  let rawArticles = [];
  // Loop through each keyword query (up to 10)
  // maxPages=6 → scans ~600 Google News results per query for maximum coverage
  for (let finalQuery of queries.slice(0, 10)) {
    try {
      console.log("\n══════════════════════════════════════");
      console.log("Running query:", finalQuery);
      const batch = await searchNews(finalQuery, sources, from, to, 6);
      rawArticles = [...rawArticles, ...batch];
      console.log(`Query done. Batch size: ${batch.length}. Total so far: ${rawArticles.length}`);
    } catch (err) {
      console.error(`Search failed for "${finalQuery}":`, err.message);
    }
  }

  try {
    if (rawArticles.length === 0) {
      return res.json({ articles: [], count: 0 });
    }

    let articles = rawArticles.map((art) => {
      // Use existing engine to get political relevance and topics, but leave sentiment manual
      const analysis = analyseText(art.rawText || art.title);
      return {
        title: art.title,
        source: art.source,
        date: art.date,
        url: art.url,
        summary: art.summary || "",
        sentiment: "neutral", // Keep manual per user request
        politically_relevant: analysis.politically_relevant, // Automatic again
        topics: analysis.topics, // Automatic again
      };
    });

    return res.json({ articles, count: articles.length });
  } catch (err) {
    console.error("Analyze error:", err);
    return res.status(500).json({ error: err.message || "Analysis failed." });
  }
});

app.listen(PORT, () => {
  console.log("\n========================================");
  console.log(`✅ Server running on port ${PORT}`);
 
  console.log("📰 Ready to scrape news");
  console.log("========================================\n");
});
