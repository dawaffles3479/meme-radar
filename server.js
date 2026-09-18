const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.X_BEARER_TOKEN;

app.use(express.static(path.join(__dirname, "public")));

function extractTickers(text) {
  return [...new Set(
    (text.match(/\$[A-Za-z][A-Za-z0-9_]{1,14}\b/g) || [])
      .map(x => x.toUpperCase())
  )];
}

app.get("/api/search", async (req, res) => {
  if (!TOKEN) {
    return res.status(500).json({
      error: "X_BEARER_TOKEN is not configured."
    });
  }

  const query =
    req.query.q ||
    "$PEPE OR $DOGE OR $SHIB OR $BONK OR $WIF";

  const params = new URLSearchParams({
    query: `(${query}) -is:retweet`,
    max_results: "100",
    "tweet.fields": "created_at,public_metrics,author_id",
    expansions: "author_id",
    "user.fields": "username"
  });

  try {
    const response = await fetch(
      "https://api.x.com/2/tweets/search/recent?" + params,
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    const users = Object.fromEntries(
      (data.includes?.users || []).map(u => [u.id, u.username])
    );

    const posts = (data.data || []).map(tweet => ({
      id: tweet.id,
      text: tweet.text,
      created_at: tweet.created_at,
      author: users[tweet.author_id] || "unknown",
      metrics: tweet.public_metrics || {},
      tickers: extractTickers(tweet.text)
    }));

    res.json({ posts });

  } catch (error) {
    res.status(502).json({
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Meme Radar running on port ${PORT}`);
});
