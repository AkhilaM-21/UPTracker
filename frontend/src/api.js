const BASE = import.meta.env.VITE_API_URL || "http://localhost:4000";

export async function analyzeArticles(sources, keywords = "", fromDate = null, toDate = null) {
  const res = await fetch(`${BASE}/api/analyze`, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "bypass-tunnel-reminder": "true"
    },
    body: JSON.stringify({ sources, keywords, fromDate, toDate }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
