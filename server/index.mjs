#!/usr/bin/env node
/**
 * Launch MCP — zero-dependency MCP server (stdio, JSON-RPC 2.0).
 * Analyzes GitHub releases and generates launch content via tools + prompts.
 * Requires Node 18+. Optional: GITHUB_TOKEN env var for rate limits / private repos.
 */
import { createInterface } from "node:readline";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// GitHub client
// ---------------------------------------------------------------------------
const API = "https://api.github.com";

async function gh(path) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "launch-mcp",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GitHub API ${res.status} for ${path}: ${body.slice(0, 300)}` +
        (res.status === 403 ? " (hint: set GITHUB_TOKEN to raise rate limits)" : "")
    );
  }
  return res.json();
}

function parseRepo(input) {
  const m = String(input).match(/(?:github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/);
  if (!m) throw new Error(`Cannot parse repository from "${input}". Use "owner/repo".`);
  return { owner: m[1], repo: m[2] };
}

async function listReleasesApi(owner, repo, limit = 10) {
  return gh(`/repos/${owner}/${repo}/releases?per_page=${Math.min(limit, 100)}`);
}

async function getRelease(owner, repo, tag) {
  if (tag) return gh(`/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  return gh(`/repos/${owner}/${repo}/releases/latest`);
}

async function getPreviousTag(owner, repo, tag) {
  const releases = await listReleasesApi(owner, repo, 100);
  const ordered = releases
    .filter((r) => !r.draft)
    .sort((a, b) => (b.published_at || "").localeCompare(a.published_at || ""));
  const idx = ordered.findIndex((r) => r.tag_name === tag);
  if (idx >= 0 && idx + 1 < ordered.length) return ordered[idx + 1].tag_name;
  return null;
}

async function compareTags(owner, repo, base, head) {
  const data = await gh(
    `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=250`
  );
  return data.commits.map((c) => ({
    sha: c.sha.slice(0, 7),
    message: (c.commit?.message || "").split("\n")[0],
    author: c.author?.login ?? c.commit?.author?.name ?? null,
    url: c.html_url,
  }));
}

async function getPullRequest(owner, repo, num) {
  try {
    const pr = await gh(`/repos/${owner}/${repo}/pulls/${num}`);
    return {
      number: pr.number,
      title: pr.title,
      user: pr.user?.login ?? "unknown",
      labels: (pr.labels || []).map((l) => l.name),
      url: pr.html_url,
      body: pr.body ? String(pr.body).slice(0, 1000) : null,
    };
  } catch {
    return null;
  }
}

function categorize(commits) {
  const out = { features: [], fixes: [], breaking: [], docs: [], performance: [], other: [] };
  const byType = {};
  for (const c of commits) {
    const msg = c.message;
    const m = msg.match(/^(\w+)(\([^)]*\))?(!)?:\s*(.*)/);
    const type = m ? m[1].toLowerCase() : "other";
    byType[type] = (byType[type] || 0) + 1;
    const line = `${msg} (${c.sha})`;
    if ((m && m[3]) || /BREAKING CHANGE/i.test(msg)) out.breaking.push(line);
    else if (type === "feat") out.features.push(line);
    else if (type === "fix") out.fixes.push(line);
    else if (type === "docs") out.docs.push(line);
    else if (type === "perf") out.performance.push(line);
    else out.other.push(line);
  }
  return { categorized: out, byType };
}

async function analyzeRelease(repoInput, tag, compareBase) {
  const { owner, repo } = parseRepo(repoInput);
  const [repoInfo, release] = await Promise.all([
    gh(`/repos/${owner}/${repo}`),
    getRelease(owner, repo, tag),
  ]);
  const previousTag = compareBase ?? (await getPreviousTag(owner, repo, release.tag_name));
  let commits = [];
  if (previousTag) {
    try {
      commits = await compareTags(owner, repo, previousTag, release.tag_name);
    } catch {}
  }
  const prNumbers = [
    ...new Set(commits.flatMap((c) => [...c.message.matchAll(/#(\d+)/g)].map((m) => parseInt(m[1], 10)))),
  ].slice(0, 30);
  const prs = (await Promise.all(prNumbers.map((n) => getPullRequest(owner, repo, n)))).filter(Boolean);
  const contributors = [...new Set(commits.map((c) => c.author).filter(Boolean))];
  const { categorized, byType } = categorize(commits);
  return {
    repo: repoInfo,
    release: {
      tag: release.tag_name,
      name: release.name || release.tag_name,
      url: release.html_url,
      publishedAt: release.published_at,
      prerelease: release.prerelease,
      body: release.body,
      author: release.author?.login ?? null,
      assets: (release.assets || []).map((a) => ({ name: a.name, downloads: a.download_count })),
    },
    previousTag,
    commits,
    commitStats: { total: commits.length, byType },
    pullRequests: prs,
    contributors,
    categorized,
  };
}


async function analyzeRepo(repoInput, includeReadme = true, commitLimit = 30) {
  const { owner, repo } = parseRepo(repoInput);
  const info = await gh(`/repos/${owner}/${repo}`);
  const [languages, contributors, commits, tags, readme, latestRelease] = await Promise.all([
    gh(`/repos/${owner}/${repo}/languages`).catch(() => ({})),
    gh(`/repos/${owner}/${repo}/contributors?per_page=10`).catch(() => []),
    gh(`/repos/${owner}/${repo}/commits?per_page=${Math.min(commitLimit, 100)}`).catch(() => []),
    gh(`/repos/${owner}/${repo}/tags?per_page=10`).catch(() => []),
    includeReadme ? gh(`/repos/${owner}/${repo}/readme`).catch(() => null) : null,
    gh(`/repos/${owner}/${repo}/releases/latest`).catch(() => null),
  ]);

  const L = [];
  L.push(`# Repository analysis: ${info.full_name}`, "");
  L.push(`- **Description**: ${info.description ?? "n/a"}`);
  L.push(`- **URL**: ${info.html_url}${info.homepage ? ` — homepage: ${info.homepage}` : ""}`);
  L.push(`- **Stats**: ⭐ ${info.stargazers_count} stars, ${info.forks_count} forks, ${info.subscribers_count ?? "?"} watchers, ${info.open_issues_count} open issues`);
  L.push(`- **License**: ${info.license?.spdx_id ?? "none"} — created ${String(info.created_at).slice(0, 10)}, last push ${String(info.pushed_at).slice(0, 10)}`);
  if (info.topics?.length) L.push(`- **Topics**: ${info.topics.join(", ")}`);
  L.push(`- **Latest release**: ${latestRelease ? `${latestRelease.tag_name} (${String(latestRelease.published_at).slice(0, 10)}) — use analyze_release for details` : "none — this repo does not use GitHub releases"}`);
  L.push("");

  const totalBytes = Object.values(languages).reduce((a, b) => a + b, 0);
  if (totalBytes > 0) {
    L.push("## Languages", "");
    for (const [lang, bytes] of Object.entries(languages).sort((a, b) => b[1] - a[1]).slice(0, 8))
      L.push(`- ${lang}: ${((bytes / totalBytes) * 100).toFixed(1)}%`);
    L.push("");
  }

  if (contributors.length) {
    L.push("## Top contributors", "");
    for (const c of contributors) L.push(`- @${c.login} (${c.contributions} commits)`);
    L.push("");
  }

  if (commits.length) {
    L.push(`## Recent commits (last ${commits.length})`, "");
    for (const c of commits)
      L.push(`- ${String(c.commit?.author?.date ?? "").slice(0, 10)} ${(c.commit?.message ?? "").split("\n")[0].slice(0, 100)} (@${c.author?.login ?? c.commit?.author?.name ?? "?"})`);
    L.push("");
  }

  if (tags.length) L.push("## Tags", "", tags.map((t) => `- ${t.name}`).join("\n"), "");

  if (readme?.content) {
    const text = Buffer.from(readme.content, "base64").toString("utf8");
    L.push("## README (excerpt)", "", text.slice(0, 8000), "");
    if (text.length > 8000) L.push(`…(README truncated, ${text.length} chars total)`);
  }
  return L.join("\n");
}

function analysisToMarkdown(a) {
  const L = [];
  L.push(`# Release analysis: ${a.repo.full_name} ${a.release.tag}`, "");
  L.push(`- **Release**: [${a.release.name}](${a.release.url})${a.release.prerelease ? " (pre-release)" : ""}`);
  L.push(`- **Published**: ${a.release.publishedAt ?? "unpublished"}${a.release.author ? ` by @${a.release.author}` : ""}`);
  L.push(`- **Compared against**: ${a.previousTag ?? "none (first release or no earlier tag found)"}`);
  L.push(`- **Repo**: ${a.repo.description ?? ""} — ⭐ ${a.repo.stargazers_count}, ${a.repo.language ?? "n/a"}${a.repo.homepage ? `, ${a.repo.homepage}` : ""}`);
  L.push(`- **Commits in this release**: ${a.commitStats.total}`);
  L.push(`- **Contributors**: ${a.contributors.length ? a.contributors.map((c) => `@${c}`).join(", ") : "n/a"}`, "");
  const sections = [
    ["🚨 Breaking changes", a.categorized.breaking],
    ["✨ Features", a.categorized.features],
    ["🐛 Fixes", a.categorized.fixes],
    ["⚡ Performance", a.categorized.performance],
    ["📝 Docs", a.categorized.docs],
    ["🔧 Other", a.categorized.other],
  ];
  for (const [title, items] of sections) {
    if (!items.length) continue;
    L.push(`## ${title} (${items.length})`, "");
    for (const item of items.slice(0, 40)) L.push(`- ${item}`);
    if (items.length > 40) L.push(`- …and ${items.length - 40} more`);
    L.push("");
  }
  if (a.pullRequests.length) {
    L.push(`## Merged pull requests (${a.pullRequests.length})`, "");
    for (const pr of a.pullRequests)
      L.push(`- #${pr.number} ${pr.title} (@${pr.user})${pr.labels.length ? ` [${pr.labels.join(", ")}]` : ""}`);
    L.push("");
  }
  if (a.release.body) L.push(`## Existing release notes on GitHub`, "", a.release.body.slice(0, 4000), "");
  if (a.release.assets.length) {
    L.push(`## Assets`, "");
    for (const asset of a.release.assets) L.push(`- ${asset.name} (${asset.downloads} downloads)`);
  }
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Share card (SVG; PNG via ImageMagick if available)
// ---------------------------------------------------------------------------
const THEMES = {
  dark: { bg: "#0d1117", bg2: "#0d1117", fg: "#f0f6fc", muted: "#8b949e", accent: "#58a6ff" },
  light: { bg: "#ffffff", bg2: "#ffffff", fg: "#1f2328", muted: "#59636e", accent: "#0969da" },
  gradient: { bg: "#1a1b3a", bg2: "#3b1d5e", fg: "#ffffff", muted: "#b8b9d1", accent: "#8b7cf8" },
};
const escXml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const trunc = (s, max) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
function mix(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return "#" + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
const fmtStars = (n) =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, "")}k` : String(n);

function buildCardSvg(o) {
  const theme = THEMES[o.theme ?? "gradient"];
  const accent = o.accentColor ?? theme.accent;
  const title = trunc(o.title ?? "New release", 48);
  const titleSize = title.length <= 30 ? 62 : title.length <= 38 ? 50 : 42;
  const highlights = (o.highlights ?? []).slice(0, 4).map((h) => trunc(h, 64));
  const font = `-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;
  const bulletY = 330;
  const bullets = highlights
    .map(
      (h, i) => `
    <circle cx="88" cy="${bulletY + i * 56 - 7}" r="5" fill="${accent}"/>
    <text x="112" y="${bulletY + i * 56}" font-family="${font}" font-size="28" fill="${theme.fg}" fill-opacity="0.92">${escXml(h)}</text>`
    )
    .join("");
  const stars =
    o.stars != null
      ? `<g transform="translate(1040, 76)">
          <path d="M12 1.5l3.1 6.3 6.9 1-5 4.9 1.2 6.9-6.2-3.3-6.2 3.3 1.2-6.9-5-4.9 6.9-1z" fill="#e3b341" transform="scale(1.15)"/>
          <text x="34" y="20" font-family="${font}" font-size="26" fill="${theme.muted}">${fmtStars(o.stars)}</text>
        </g>`
      : "";
  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${theme.bg}"/><stop offset="100%" stop-color="${theme.bg2}"/>
    </linearGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${accent}"/><stop offset="100%" stop-color="${accent}" stop-opacity="0.35"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="0" y="0" width="1200" height="10" fill="url(#bar)"/>
  <circle cx="1060" cy="520" r="260" fill="${mix(theme.bg2, accent, 0.07)}"/>
  <circle cx="1160" cy="600" r="160" fill="${mix(theme.bg2, accent, 0.09)}"/>
  <text x="80" y="96" font-family="${font}" font-size="30" fill="${theme.muted}">${escXml(trunc(o.repoName, 40))}</text>
  <rect x="76" y="130" rx="22" ry="22" width="${52 + o.version.length * 19}" height="46" fill="${mix(theme.bg, accent, 0.16)}"/>
  <text x="100" y="162" font-family="${font}" font-size="30" font-weight="600" fill="${accent}">${escXml(o.version)}</text>
  <text x="78" y="256" font-family="${font}" font-size="${titleSize}" font-weight="700" fill="${theme.fg}">${escXml(title)}</text>
  ${bullets}
  ${stars}
  <text x="80" y="580" font-family="${font}" font-size="24" fill="${theme.muted}">github.com/${escXml(trunc(o.repoName, 48))}</text>
</svg>`;
}

function renderCard(o, outBase) {
  const svg = buildCardSvg(o);
  mkdirSync(dirname(outBase), { recursive: true });
  const svgPath = outBase + ".svg";
  writeFileSync(svgPath, svg, "utf8");
  let pngPath = null;
  for (const bin of ["magick", "convert", "rsvg-convert"]) {
    try {
      const target = outBase + ".png";
      if (bin === "rsvg-convert") execFileSync(bin, ["-o", target, svgPath], { stdio: "ignore" });
      else execFileSync(bin, [svgPath, target], { stdio: "ignore" });
      pngPath = target;
      break;
    } catch {}
  }
  return { svgPath, pngPath };
}

// ---------------------------------------------------------------------------
// Tool & prompt definitions
// ---------------------------------------------------------------------------
const REPO_DESC = 'GitHub repository as "owner/repo" or a full GitHub URL';
const TAG_DESC = "Release tag (e.g. v1.2.0). Omit for the latest release";

const TOOLS = [
  {
    name: "analyze_release",
    description:
      "Analyze a GitHub release: metadata, commits since the previous release (categorized by conventional-commit type), merged PRs, contributors, and existing notes. Run this first — its output is the source material for all content generation.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: REPO_DESC },
        tag: { type: "string", description: TAG_DESC },
        compare_base: { type: "string", description: "Override the tag to diff against (defaults to the previous published release)" },
      },
      required: ["repo"],
    },
  },
  {
    name: "analyze_repo",
    description:
      "Analyze a GitHub repository as a whole — no release required: metadata, stars/forks, languages, topics, top contributors, recent commit activity, tags, and README excerpt. Use this when the repo has no releases, or for project-level (rather than release-level) launch content.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: REPO_DESC },
        include_readme: { type: "boolean", description: "Include a README excerpt (default true)" },
        commit_limit: { type: "integer", minimum: 1, maximum: 100, description: "Recent commits to include (default 30)" },
      },
      required: ["repo"],
    },
  },
  {
    name: "list_releases",
    description: "List recent releases of a GitHub repository (tag, name, date, prerelease flag).",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: REPO_DESC },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max releases to return (default 10)" },
      },
      required: ["repo"],
    },
  },
  {
    name: "generate_share_card",
    description:
      "Generate a 1200x630 social share-card image (SVG, plus PNG when an SVG rasterizer is installed) announcing a release. Provide a short title and up to 4 highlight bullets — typically distilled from analyze_release output. Returns file paths.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: REPO_DESC },
        version: { type: "string", description: "Version label shown on the card, e.g. v2.1.0" },
        title: { type: "string", description: "Headline (max ~46 chars shown)" },
        highlights: { type: "array", items: { type: "string" }, maxItems: 4, description: "Up to 4 short highlight bullets" },
        stars: { type: "integer", description: "Star count badge (from analyze_release)" },
        theme: { type: "string", enum: ["dark", "light", "gradient"], description: "Card theme (default gradient)" },
        accent_color: { type: "string", description: "Accent hex color, e.g. #8b7cf8" },
        output_dir: { type: "string", description: "Directory to write the image (defaults to a temp dir)" },
      },
      required: ["repo", "version"],
    },
  },
];

const PROMPT_INSTRUCTIONS = {
  "release-notes":
    "Write polished release notes in Markdown. Structure: a 2-3 sentence overview of the release theme; sections for Breaking Changes (with migration guidance), New Features, Bug Fixes, and Other Improvements (omit empty sections); a Contributors thank-you list. Tone: clear, professional, developer-facing. Rewrite raw commit messages into user-benefit language.",
  changelog:
    'Produce a changelog entry following the Keep a Changelog format (https://keepachangelog.com): a "## [version] - YYYY-MM-DD" heading, then "### Added / Changed / Deprecated / Removed / Fixed / Security" subsections as applicable. Terse, one line per change, imperative mood, reference PR numbers like (#123).',
  "blog-post":
    "Write a launch blog post (500-800 words) in Markdown. Open with a hook about the problem this release solves, walk through the 2-4 most significant changes with concrete usage examples where the data supports them, mention notable fixes briefly, close with upgrade instructions and a link to the full release. Tone: enthusiastic but substantive. Include a suggested title and 3 alternative titles at the top.",
  "twitter-thread":
    'Write a Twitter/X thread (3-6 tweets, each under 280 characters). Tweet 1: the announcement with the single most exciting change and the release link. Middle tweets: one key feature or fix each, concrete and specific. Final tweet: call to action and thanks to contributors. Number the tweets "1/", "2/", etc. Minimal hashtags (max 2 total), no emoji spam.',
  "linkedin-post":
    "Write a LinkedIn post (120-200 words). Professional but warm tone. Lead with the impact of the release, summarize 2-3 headline improvements in plain language a non-user could follow, credit the contributor community, end with a link to the release and a question inviting engagement. No hashtag walls (max 3).",
  "full-launch-kit":
    "Produce a complete launch kit as a single Markdown document with these sections: 1) Release Notes (polished, sectioned by change type, contributor thanks); 2) Changelog entry (Keep a Changelog format); 3) Blog Post (500-800 words with title options); 4) Twitter/X Thread (3-6 numbered tweets under 280 chars); 5) LinkedIn Post (120-200 words). Then call the generate_share_card tool with a punchy title and the top 3-4 highlights to create the announcement image, and report the file paths.",
};

const PROMPTS = Object.entries({
  "release-notes": "Write polished release notes for a GitHub release",
  changelog: "Generate a Keep-a-Changelog style changelog entry",
  "blog-post": "Write a launch blog post announcing the release",
  "twitter-thread": "Write a Twitter/X thread announcing the release",
  "linkedin-post": "Write a LinkedIn post announcing the release",
  "full-launch-kit": "Generate the complete launch kit: release notes, changelog, blog post, social posts, and a share card",
}).map(([name, description]) => ({
  name,
  description,
  arguments: [
    { name: "repo", description: REPO_DESC, required: true },
    { name: "tag", description: TAG_DESC, required: false },
  ],
}));

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------
async function callTool(name, args = {}) {
  if (name === "analyze_release") {
    const a = await analyzeRelease(args.repo, args.tag, args.compare_base);
    return analysisToMarkdown(a);
  }
  if (name === "analyze_repo") {
    return analyzeRepo(args.repo, args.include_readme !== false, args.commit_limit ?? 30);
  }
  if (name === "list_releases") {
    const { owner, repo } = parseRepo(args.repo);
    const releases = await listReleasesApi(owner, repo, args.limit ?? 10);
    return (
      releases
        .map(
          (r) =>
            `- ${r.tag_name}${r.name && r.name !== r.tag_name ? ` — ${r.name}` : ""} (${
              r.published_at?.slice(0, 10) ?? "draft"
            })${r.prerelease ? " [prerelease]" : ""}`
        )
        .join("\n") || "No releases found."
    );
  }
  if (name === "generate_share_card") {
    const { owner, repo } = parseRepo(args.repo);
    if (!args.version) throw new Error("version is required");
    const dir = args.output_dir ?? join(tmpdir(), "launch-mcp");
    const base = join(dir, `${repo}-${String(args.version).replace(/[^\w.-]/g, "_")}-card`);
    const { svgPath, pngPath } = renderCard(
      {
        repoName: `${owner}/${repo}`,
        version: args.version,
        title: args.title,
        highlights: args.highlights,
        stars: args.stars,
        theme: args.theme,
        accentColor: args.accent_color,
      },
      base
    );
    return pngPath
      ? `Share card written:\n- PNG: ${pngPath}\n- SVG: ${svgPath}`
      : `Share card written (SVG only — no PNG rasterizer found on this system):\n- SVG: ${svgPath}`;
  }
  throw new Error(`Unknown tool: ${name}`);
}

function getPrompt(name, args = {}) {
  const instructions = PROMPT_INSTRUCTIONS[name];
  if (!instructions) throw new Error(`Unknown prompt: ${name}`);
  if (!args.repo) throw new Error("repo argument is required");
  const text =
    `First call the launch-mcp tool \`analyze_release\` with repo="${args.repo}"` +
    (args.tag ? ` and tag="${args.tag}"` : " (latest release)") +
    `. If that fails because the repo has no releases, call \`analyze_repo\` instead and adapt the task to a project-level launch. Then use the output to complete this task:\n\n${instructions}\n\n` +
    `Ground every claim in the analysis data. Do not invent features, numbers, or quotes. ` +
    `Link to the release URL where appropriate.`;
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 over stdio (newline-delimited)
// ---------------------------------------------------------------------------
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(req) {
  const { id, method, params = {} } = req;
  try {
    switch (method) {
      case "initialize":
        return reply(id, {
          protocolVersion: params.protocolVersion || "2024-11-05",
          capabilities: { tools: {}, prompts: {} },
          serverInfo: { name: "launch-mcp", version: "0.2.0" },
        });
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, { tools: TOOLS });
      case "tools/call": {
        try {
          const text = await callTool(params.name, params.arguments);
          return reply(id, { content: [{ type: "text", text }] });
        } catch (err) {
          return reply(id, { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
        }
      }
      case "prompts/list":
        return reply(id, { prompts: PROMPTS });
      case "prompts/get":
        return reply(id, getPrompt(params.name, params.arguments));
      case "resources/list":
        return reply(id, { resources: [] });
      default:
        if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (id !== undefined) replyError(id, -32603, err.message || String(err));
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  handle(req);
});
rl.on("close", () => process.exit(0));
console.error("launch-mcp server running on stdio (zero-dependency build)");
