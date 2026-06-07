import { config } from "./config.js";

const baseUrl = "https://api.github.com";

export class GitHubError extends Error {
  constructor(message, response, body) {
    super(message);
    this.name = "GitHubError";
    this.status = response?.status;
    this.body = body;
  }
}

export function assertGitHubConfigured() {
  if (!config.githubOwner) {
    throw new Error("GITHUB_OWNER is not configured");
  }
  if (!config.githubToken) {
    throw new Error("GITHUB_TOKEN is not configured");
  }
}

export function assertGitHubOwnerConfigured() {
  if (!config.githubOwner) {
    throw new Error("GITHUB_OWNER is not configured");
  }
}

function assertGitHubTokenConfigured() {
  if (!config.githubToken) {
    throw new Error("GITHUB_TOKEN is required for GitHub write/admin operations");
  }
}

async function githubRequest(method, route, body, attempt = 0) {
  assertGitHubOwnerConfigured();
  if (method !== "GET" || route === "/user") {
    assertGitHubTokenConfigured();
  }

  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(config.githubToken ? { Authorization: `Bearer ${config.githubToken}` } : {}),
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": config.githubApiVersion,
      "User-Agent": config.githubUserAgent,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  const data = text ? parseJson(text) : null;

  if (!response.ok) {
    if (shouldRetry(response, attempt)) {
      await waitForRetry(response, attempt);
      return githubRequest(method, route, body, attempt + 1);
    }

    const message = data?.message || `${method} ${route} failed with ${response.status}`;
    throw new GitHubError(message, response, data);
  }

  return data;
}

function shouldRetry(response, attempt) {
  if (attempt >= config.githubMaxRetries) return false;
  return response.status === 403 || response.status === 429 || response.status >= 500;
}

async function waitForRetry(response, attempt) {
  const retryAfter = Number(response.headers.get("retry-after"));
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const nowSeconds = Date.now() / 1000;
  const resetDelay = Number.isFinite(reset) && reset > nowSeconds ? (reset - nowSeconds) * 1000 : 0;
  const retryAfterDelay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
  const fallback = 1000 * 2 ** attempt;
  const delay = Math.min(Math.max(retryAfterDelay, resetDelay, fallback), 60_000);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function paged(route) {
  const results = [];
  let page = 1;

  while (page < 200) {
    const separator = route.includes("?") ? "&" : "?";
    const data = await githubRequest("GET", `${route}${separator}per_page=100&page=${page}`);
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    if (data.length < 100) break;
    page += 1;
  }

  return results;
}

export async function getViewer() {
  return githubRequest("GET", "/user");
}

export async function listRepositories() {
  const encodedOwner = encodeURIComponent(config.githubOwner);

  try {
    return await paged(`/orgs/${encodedOwner}/repos?type=all&sort=full_name`);
  } catch (error) {
    if (error.status !== 404) throw error;
    return paged(`/users/${encodedOwner}/repos?type=all&sort=full_name`);
  }
}

export async function listTeams() {
  const org = encodeURIComponent(config.githubOwner);
  return paged(`/orgs/${org}/teams`);
}

export async function getUser(login) {
  return githubRequest("GET", `/users/${encodeURIComponent(login)}`);
}

export async function inviteCollaborator(repo, username, permission) {
  const owner = encodeURIComponent(config.githubOwner);
  const repoName = encodeURIComponent(repo);
  const user = encodeURIComponent(username);
  return githubRequest("PUT", `/repos/${owner}/${repoName}/collaborators/${user}`, {
    permission
  });
}

export async function removeCollaborator(repo, username) {
  const owner = encodeURIComponent(config.githubOwner);
  const repoName = encodeURIComponent(repo);
  const user = encodeURIComponent(username);
  await githubRequest("DELETE", `/repos/${owner}/${repoName}/collaborators/${user}`);
  return { removed: true };
}

export async function listCollaborators(repo) {
  const owner = encodeURIComponent(config.githubOwner);
  const repoName = encodeURIComponent(repo);
  return paged(`/repos/${owner}/${repoName}/collaborators?affiliation=direct`);
}

export async function getCollaboratorPermission(repo, username) {
  const owner = encodeURIComponent(config.githubOwner);
  const repoName = encodeURIComponent(repo);
  const user = encodeURIComponent(username);
  return githubRequest("GET", `/repos/${owner}/${repoName}/collaborators/${user}/permission`);
}

export async function addTeamMembership(teamSlug, username, role = "member") {
  const org = encodeURIComponent(config.githubOwner);
  const slug = encodeURIComponent(teamSlug);
  const user = encodeURIComponent(username);
  return githubRequest("PUT", `/orgs/${org}/teams/${slug}/memberships/${user}`, { role });
}

export async function removeTeamMembership(teamSlug, username) {
  const org = encodeURIComponent(config.githubOwner);
  const slug = encodeURIComponent(teamSlug);
  const user = encodeURIComponent(username);
  await githubRequest("DELETE", `/orgs/${org}/teams/${slug}/memberships/${user}`);
  return { removed: true };
}

export async function addTeamRepository(teamSlug, repo, permission) {
  const org = encodeURIComponent(config.githubOwner);
  const slug = encodeURIComponent(teamSlug);
  const owner = encodeURIComponent(config.githubOwner);
  const repoName = encodeURIComponent(repo);
  await githubRequest("PUT", `/orgs/${org}/teams/${slug}/repos/${owner}/${repoName}`, { permission });
  return { granted: true };
}

export async function removeTeamRepository(teamSlug, repo) {
  const org = encodeURIComponent(config.githubOwner);
  const slug = encodeURIComponent(teamSlug);
  const owner = encodeURIComponent(config.githubOwner);
  const repoName = encodeURIComponent(repo);
  await githubRequest("DELETE", `/orgs/${org}/teams/${slug}/repos/${owner}/${repoName}`);
  return { removed: true };
}
