import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(__dirname, "..");

loadDotEnv(path.join(rootDir, ".env"));

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export const config = {
  port: numberFromEnv("PORT", 4173),
  githubToken: process.env.GITHUB_TOKEN || "",
  githubOwner: process.env.GITHUB_OWNER || "",
  githubApiVersion: process.env.GITHUB_API_VERSION || "2026-03-10",
  githubUserAgent: process.env.GITHUB_USER_AGENT || "osh-github-manager",
  githubMaxRetries: Math.max(0, numberFromEnv("GITHUB_MAX_RETRIES", 3)),
  adminToken: process.env.ADMIN_TOKEN || "",
  jobConcurrency: Math.max(1, numberFromEnv("JOB_CONCURRENCY", 1)),
  jobDelayMs: numberFromEnv("JOB_DELAY_MS", 500),
  dataFile: path.join(rootDir, "data", "state.json"),
  databaseFile: process.env.DATABASE_FILE || path.join(rootDir, "data", "app.db"),
  sessionSecret: process.env.SESSION_SECRET || "change-me-in-production",
  appBaseUrl: process.env.APP_BASE_URL || `http://localhost:${numberFromEnv("PORT", 4173)}`,
  githubOAuthClientId: process.env.GITHUB_OAUTH_CLIENT_ID || "",
  githubOAuthClientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET || "",
  adminGithubLogins: (process.env.ADMIN_GITHUB_LOGINS || process.env.GITHUB_OWNER || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
};

export function publicConfig() {
  return {
    ownerConfigured: Boolean(config.githubOwner),
    tokenConfigured: Boolean(config.githubToken),
    adminAuthEnabled: Boolean(config.adminToken),
    githubOwner: config.githubOwner || null,
    githubApiVersion: config.githubApiVersion,
    githubMaxRetries: config.githubMaxRetries,
    oauthConfigured: Boolean(config.githubOAuthClientId && config.githubOAuthClientSecret),
    appBaseUrl: config.appBaseUrl,
    adminGithubLogins: config.adminGithubLogins,
    jobConcurrency: config.jobConcurrency,
    jobDelayMs: config.jobDelayMs
  };
}
