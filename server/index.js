import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, publicConfig } from "./config.js";
import {
  exchangeOAuthCode,
  getOAuthUser,
  getUser,
  getViewer,
  listRepositories,
  listTeams
} from "./github.js";
import { createJob, retryJob, startJobQueue } from "./jobQueue.js";
import { addAudit, getState, loadState, mutateState } from "./store.js";
import { csvEscape, id, normalizeLogin, normalizeRepoName, nowIso, parseCsvLine, safeIncludes, unique } from "./utils.js";
import {
  authMiddleware,
  clearSessionCookie,
  createOrUpdateOAuthUser,
  createSession,
  destroySession,
  publicUser,
  requireAdminUser,
  requireLogin,
  setSessionCookie
} from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(authMiddleware);
app.use(express.static(path.join(__dirname, "..", "public")));

await loadState();
startJobQueue();

app.get("/api/config", (_req, res) => {
  res.json(publicConfig());
});

app.get("/api/me", (req, res) => {
  if (isAdminTokenRequest(req)) {
    return res.json({ user: localAdminUser(), oauthConfigured: publicConfig().oauthConfigured });
  }
  res.json({ user: publicUser(req.currentUser), oauthConfigured: publicConfig().oauthConfigured });
});

app.get("/api/public/repositories", (_req, res) => {
  res.json({
    repositories: getState().repositories.filter((repo) => repo.managed && !repo.disabled && !repo.archived)
  });
});

app.get("/auth/github", (req, res) => {
  if (!config.githubOAuthClientId) {
    return res.status(500).send("GitHub OAuth is not configured");
  }

  const stateValue = Math.random().toString(36).slice(2);
  const callbackUrl = new URL("/auth/github/callback", config.appBaseUrl).toString();
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.githubOAuthClientId);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", stateValue);
  res.redirect(url.toString());
});

app.get("/auth/github/callback", asyncHandler(async (req, res) => {
  const code = String(req.query.code || "");
  if (!code) return res.status(400).send("Missing GitHub OAuth code");

  const token = await exchangeOAuthCode(code);
  const profile = await getOAuthUser(token.access_token);
  const user = await createOrUpdateOAuthUser(profile);
  const session = await createSession(user);
  setSessionCookie(res, session);
  res.redirect("/");
}));

app.post("/api/logout", requireLogin, asyncHandler(async (req, res) => {
  await destroySession(req);
  clearSessionCookie(res);
  res.json({ ok: true });
}));

app.get("/api/health", async (_req, res) => {
  const state = getState();
  res.json({
    ok: true,
    config: publicConfig(),
    counts: {
      members: state.members.length,
      repositories: state.repositories.length,
      teams: state.teams.length,
      jobs: state.jobs.length,
      queuedJobs: state.jobs.filter((job) => job.status === "queued").length,
      runningJobs: state.jobs.filter((job) => job.status === "running").length
    }
  });
});

app.get("/api/github/viewer", requireAdmin, asyncHandler(async (_req, res) => {
  res.json(await getViewer());
}));

app.post("/api/apply", asyncHandler(async (req, res) => {
  const githubUsername = normalizeLogin(req.body.githubUsername || req.currentUser?.githubLogin);
  const displayName = String(req.body.displayName || req.currentUser?.name || "").trim();
  const email = String(req.body.email || req.currentUser?.email || "").trim();
  const note = String(req.body.note || "").trim();
  const requestedPermission = normalizePermission(req.body.requestedPermission || getState().settings.defaultPermission);
  const requestedRepositories = resolveRequestedRepositories(req.body.repositories || req.body.requestedRepositories);

  if (!githubUsername) {
    return res.status(400).json({ error: "GitHub 账号必填" });
  }

  let githubProfile = null;
  try {
    githubProfile = await getUser(githubUsername);
  } catch (error) {
    return res.status(400).json({ error: `GitHub user not found: ${error.message}` });
  }

  let member;
  await mutateState((state) => {
    member = state.members.find((item) => item.githubUsername === githubUsername);
    const status = state.settings.requireApproval ? "pending" : "approved";

    if (member) {
      member.displayName = displayName || member.displayName;
      member.email = email || member.email;
      member.note = note || member.note;
      member.requestedPermission = requestedPermission;
      member.requestedRepositories = requestedRepositories;
      member.githubProfile = simplifyGitHubUser(githubProfile);
      member.updatedAt = nowIso();
      if (member.status === "rejected") member.status = "pending";
    } else {
      member = {
        id: `member_${githubUsername}`,
        githubUsername,
        displayName,
        email,
        note,
        requestedPermission,
        requestedRepositories,
        status,
        role: "contributor",
        tags: [],
        repositories: [],
        githubProfile: simplifyGitHubUser(githubProfile),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        approvedAt: status === "approved" ? nowIso() : null,
        approvedBy: status === "approved" ? "auto" : null
      };
      state.members.unshift(member);
    }

    addAudit({
      actor: req.currentUser?.githubLogin || githubUsername,
      action: "member.apply",
      targetType: "member",
      target: githubUsername,
      details: { requestedPermission, requestedRepositories }
    });

    const accessRequest = {
      id: id("request"),
      githubUsername,
      requestedPermission,
      repositories: requestedRepositories,
      note,
      status: "pending",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      decidedAt: null,
      decidedBy: null
    };
    state.accessRequests.unshift(accessRequest);
  });

  res.status(201).json({ member });
}));

app.get("/api/members", requireAdmin, (req, res) => {
  const { status = "", q = "" } = req.query;
  const members = getState().members.filter((member) => {
    if (status && member.status !== status) return false;
    if (q) {
      return [member.githubUsername, member.displayName, member.email, member.note, member.role, ...(member.tags || [])]
        .some((value) => safeIncludes(value, q));
    }
    return true;
  });

  res.json({ members });
});

app.post("/api/members", requireAdmin, asyncHandler(async (req, res) => {
  const githubUsername = normalizeLogin(req.body.githubUsername);
  if (!githubUsername) return res.status(400).json({ error: "GitHub username is required" });

  const member = await upsertMember(req.body, "admin");
  res.status(201).json({ member });
}));

app.post("/api/members/import", requireAdmin, asyncHandler(async (req, res) => {
  const members = Array.isArray(req.body.members) ? req.body.members : [];
  if (members.length === 0) return res.status(400).json({ error: "Members are required" });

  const imported = [];
  for (const input of members) {
    const githubUsername = normalizeLogin(input.githubUsername);
    if (!githubUsername) continue;
    imported.push(await upsertMember({
      ...input,
      githubUsername,
      status: input.status || "approved"
    }, "admin"));
  }

  res.status(201).json({ members: imported });
}));

app.patch("/api/members/:username", requireAdmin, asyncHandler(async (req, res) => {
  const username = normalizeLogin(req.params.username);
  let member;

  await mutateState((state) => {
    member = state.members.find((item) => item.githubUsername === username);
    if (!member) throw new HttpError(404, "Member not found");

    if (req.body.displayName !== undefined) member.displayName = String(req.body.displayName || "").trim();
    if (req.body.email !== undefined) member.email = String(req.body.email || "").trim();
    if (req.body.note !== undefined) member.note = String(req.body.note || "").trim();
    if (req.body.role !== undefined) member.role = String(req.body.role || "contributor").trim();
    if (req.body.tags !== undefined) member.tags = normalizeTags(req.body.tags);
    if (req.body.requestedPermission !== undefined) {
      member.requestedPermission = normalizePermission(req.body.requestedPermission);
    }
    if (req.body.status !== undefined) {
      member.status = normalizeMemberStatus(req.body.status);
    }
    member.updatedAt = nowIso();

    addAudit({
      actor: "admin",
      action: "member.update",
      targetType: "member",
      target: username,
      details: req.body
    });
  });

  res.json({ member });
}));

app.post("/api/members/:username/approve", requireAdmin, asyncHandler(async (req, res) => {
  const username = normalizeLogin(req.params.username);
  const permission = normalizePermission(req.body.permission || getState().settings.defaultPermission);
  let repositories = [];
  let member;

  await mutateState((state) => {
    member = state.members.find((item) => item.githubUsername === username);
    if (!member) throw new HttpError(404, "Member not found");
    repositories = req.body.repositories !== undefined
      ? resolveRepositories(req.body.repositories)
      : resolveRepositories(member.requestedRepositories || []);

    member.status = "approved";
    member.requestedPermission = permission;
    member.approvedAt = nowIso();
    member.approvedBy = "admin";
    member.updatedAt = nowIso();

    addAudit({
      actor: "admin",
      action: "member.approve",
      targetType: "member",
      target: username,
      details: { permission, repositories }
    });

    for (const request of state.accessRequests.filter((item) => item.githubUsername === username && item.status === "pending")) {
      request.status = "approved";
      request.permission = permission;
      request.repositories = repositories;
      request.decidedAt = nowIso();
      request.decidedBy = "admin";
      request.updatedAt = nowIso();
    }
  });

  let job = null;
  if (req.body.invite !== false && getState().settings.autoInviteOnApproval && repositories.length > 0) {
    job = await createJob({
      type: "invite",
      actor: "admin",
      title: `Invite ${username} to ${repositories.length} repositories`,
      payload: {
        usernames: [username],
        repositories,
        permission
      }
    });
  }

  res.json({ member, job });
}));

app.post("/api/members/:username/reject", requireAdmin, asyncHandler(async (req, res) => {
  const username = normalizeLogin(req.params.username);
  let member;

  await mutateState((state) => {
    member = state.members.find((item) => item.githubUsername === username);
    if (!member) throw new HttpError(404, "Member not found");
    member.status = "rejected";
    member.rejectedAt = nowIso();
    member.rejectionReason = String(req.body.reason || "").trim();
    member.updatedAt = nowIso();
    for (const request of state.accessRequests.filter((item) => item.githubUsername === username && item.status === "pending")) {
      request.status = "rejected";
      request.reason = member.rejectionReason;
      request.decidedAt = nowIso();
      request.decidedBy = "admin";
      request.updatedAt = nowIso();
    }
    addAudit({
      actor: "admin",
      action: "member.reject",
      targetType: "member",
      target: username,
      details: { reason: member.rejectionReason }
    });
  });

  res.json({ member });
}));

app.delete("/api/members/:username", requireAdmin, asyncHandler(async (req, res) => {
  const username = normalizeLogin(req.params.username);

  await mutateState((state) => {
    const before = state.members.length;
    state.members = state.members.filter((item) => item.githubUsername !== username);
    if (state.members.length === before) throw new HttpError(404, "Member not found");
    addAudit({
      actor: "admin",
      action: "member.delete",
      targetType: "member",
      target: username
    });
  });

  res.status(204).end();
}));

app.post("/api/members/:username/offboard", requireAdmin, asyncHandler(async (req, res) => {
  const username = normalizeLogin(req.params.username);
  const repositories = resolveRepositories(req.body.repositories);
  const teamSlugs = resolveTeamSlugs(req.body.teamSlugs);
  let member;

  if (repositories.length === 0 && teamSlugs.length === 0) {
    return res.status(400).json({ error: "No managed repositories or teams to offboard" });
  }

  await mutateState((state) => {
    member = state.members.find((item) => item.githubUsername === username);
    if (!member) throw new HttpError(404, "Member not found");
    member.status = "disabled";
    member.offboardedAt = nowIso();
    member.updatedAt = nowIso();
    addAudit({
      actor: "admin",
      action: "member.offboard",
      targetType: "member",
      target: username,
      details: { repositories: repositories.length, teamSlugs: teamSlugs.length, dryRun: Boolean(req.body.dryRun) }
    });
  });

  const job = await createJob({
    type: "offboardMember",
    actor: "admin",
    title: `Offboard ${username}`,
    payload: {
      username,
      repositories,
      teamSlugs,
      dryRun: Boolean(req.body.dryRun)
    }
  });

  res.status(202).json({ member, job });
}));

app.post("/api/members/:username/access/grant", requireAdmin, asyncHandler(async (req, res) => {
  const username = normalizeLogin(req.params.username);
  const repositories = resolveRepositories(req.body.repositories);
  const permission = normalizePermission(req.body.permission || getState().settings.defaultPermission);
  if (repositories.length === 0) return res.status(400).json({ error: "At least one repository is required" });

  await upsertMember({ githubUsername: username, requestedPermission: permission, status: "approved" }, "admin");
  const job = await createJob({
    type: "invite",
    actor: "admin",
    title: `Grant ${permission} to ${username} in ${repositories.length} repositories`,
    payload: {
      usernames: [username],
      repositories,
      permission,
      dryRun: Boolean(req.body.dryRun)
    }
  });

  res.status(202).json({ job });
}));

app.post("/api/members/:username/access/remove", requireAdmin, asyncHandler(async (req, res) => {
  const username = normalizeLogin(req.params.username);
  const repositories = resolveRepositories(req.body.repositories);
  if (repositories.length === 0) return res.status(400).json({ error: "At least one repository is required" });

  const job = await createJob({
    type: "remove",
    actor: "admin",
    title: `Remove ${username} from ${repositories.length} repositories`,
    payload: {
      usernames: [username],
      repositories,
      dryRun: Boolean(req.body.dryRun)
    }
  });

  res.status(202).json({ job });
}));

app.get("/api/repositories", requireLogin, (req, res) => {
  const { q = "", managed = "" } = req.query;
  const repositories = getState().repositories.filter((repo) => {
    if (managed === "true" && !repo.managed) return false;
    if (managed === "false" && repo.managed) return false;
    if (q) return safeIncludes(repo.name, q) || safeIncludes(repo.description, q);
    return true;
  });

  res.json({ repositories });
});

app.post("/api/repositories/sync", requireAdmin, asyncHandler(async (req, res) => {
  const includeArchived = Boolean(req.body.includeArchived ?? getState().settings.includeArchivedRepositories);
  const repos = await listRepositories();
  let repositories;

  await mutateState((state) => {
    const previous = new Map(state.repositories.map((repo) => [repo.name, repo]));
    repositories = repos
      .filter((repo) => includeArchived || !repo.archived)
      .map((repo) => {
        const existing = previous.get(repo.name);
        return {
          id: repo.id,
          name: repo.name,
          fullName: repo.full_name,
          private: repo.private,
          archived: repo.archived,
          disabled: repo.disabled,
          fork: repo.fork,
          description: repo.description || "",
          htmlUrl: repo.html_url,
          defaultBranch: repo.default_branch,
          pushedAt: repo.pushed_at,
          updatedAt: repo.updated_at,
          syncedAt: nowIso(),
          managed: existing?.managed ?? true,
          lastAuditAt: existing?.lastAuditAt || null,
          collaboratorCount: existing?.collaboratorCount || null,
          unexpectedCollaborators: existing?.unexpectedCollaborators || []
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    state.repositories = repositories;
    addAudit({
      actor: "admin",
      action: "repository.sync",
      targetType: "owner",
      target: config.githubOwner,
      details: { count: repositories.length, includeArchived }
    });
  });

  res.json({ repositories });
}));

app.get("/api/teams", requireAdmin, (req, res) => {
  const { q = "", managed = "" } = req.query;
  const teams = getState().teams.filter((team) => {
    if (managed === "true" && !team.managed) return false;
    if (managed === "false" && team.managed) return false;
    if (q) return safeIncludes(team.name, q) || safeIncludes(team.slug, q) || safeIncludes(team.description, q);
    return true;
  });

  res.json({ teams });
});

app.post("/api/teams/sync", requireAdmin, asyncHandler(async (_req, res) => {
  const teamsFromGitHub = await listTeams();
  let teams;

  await mutateState((state) => {
    const previous = new Map(state.teams.map((team) => [team.slug, team]));
    teams = teamsFromGitHub
      .map((team) => {
        const existing = previous.get(team.slug);
        return {
          id: team.id,
          name: team.name,
          slug: team.slug,
          description: team.description || "",
          privacy: team.privacy || "",
          permission: team.permission || "",
          htmlUrl: team.html_url || "",
          membersCount: team.members_count ?? null,
          reposCount: team.repos_count ?? null,
          managed: existing?.managed ?? true,
          repositories: existing?.repositories || [],
          syncedAt: nowIso()
        };
      })
      .sort((a, b) => a.slug.localeCompare(b.slug));

    state.teams = teams;
    addAudit({
      actor: "admin",
      action: "team.sync",
      targetType: "owner",
      target: config.githubOwner,
      details: { count: teams.length }
    });
  });

  res.json({ teams });
}));

app.patch("/api/teams/:teamSlug", requireAdmin, asyncHandler(async (req, res) => {
  const teamSlug = normalizeSlug(req.params.teamSlug);
  let team;

  await mutateState((state) => {
    team = state.teams.find((item) => item.slug === teamSlug);
    if (!team) throw new HttpError(404, "Team not found");
    if (req.body.managed !== undefined) team.managed = Boolean(req.body.managed);
    addAudit({
      actor: "admin",
      action: "team.update",
      targetType: "team",
      target: teamSlug,
      details: req.body
    });
  });

  res.json({ team });
}));

app.patch("/api/repositories/:repo", requireAdmin, asyncHandler(async (req, res) => {
  const repoName = normalizeRepoName(req.params.repo);
  let repository;

  await mutateState((state) => {
    repository = state.repositories.find((item) => item.name === repoName);
    if (!repository) throw new HttpError(404, "Repository not found");
    if (req.body.managed !== undefined) repository.managed = Boolean(req.body.managed);
    addAudit({
      actor: "admin",
      action: "repository.update",
      targetType: "repository",
      target: repoName,
      details: req.body
    });
  });

  res.json({ repository });
}));

app.post("/api/bulk/invite", requireAdmin, asyncHandler(async (req, res) => {
  const usernames = resolveUsernames(req.body.usernames);
  const repositories = resolveRepositories(req.body.repositories);
  const permission = normalizePermission(req.body.permission || getState().settings.defaultPermission);

  if (usernames.length === 0) return res.status(400).json({ error: "At least one username is required" });
  if (repositories.length === 0) return res.status(400).json({ error: "At least one repository is required" });

  for (const username of usernames) {
    await upsertMember({ githubUsername: username, requestedPermission: permission, status: "approved" }, "admin");
  }

  const job = await createJob({
    type: "invite",
    actor: "admin",
    title: `Invite ${usernames.length} member(s) to ${repositories.length} repositories`,
    payload: {
      usernames,
      repositories,
      permission,
      dryRun: Boolean(req.body.dryRun)
    }
  });

  res.status(202).json({ job });
}));

app.post("/api/bulk/remove", requireAdmin, asyncHandler(async (req, res) => {
  const usernames = resolveUsernames(req.body.usernames);
  const repositories = resolveRepositories(req.body.repositories);

  if (usernames.length === 0) return res.status(400).json({ error: "At least one username is required" });
  if (repositories.length === 0) return res.status(400).json({ error: "At least one repository is required" });

  const job = await createJob({
    type: "remove",
    actor: "admin",
    title: `Remove ${usernames.length} member(s) from ${repositories.length} repositories`,
    payload: {
      usernames,
      repositories,
      dryRun: Boolean(req.body.dryRun)
    }
  });

  res.status(202).json({ job });
}));

app.post("/api/teams/:teamSlug/members/add", requireAdmin, asyncHandler(async (req, res) => {
  const teamSlug = normalizeSlug(req.params.teamSlug);
  const usernames = resolveUsernames(req.body.usernames);
  const role = normalizeTeamRole(req.body.role || "member");

  if (usernames.length === 0) return res.status(400).json({ error: "At least one username is required" });

  for (const username of usernames) {
    await upsertMember({ githubUsername: username, status: "approved" }, "admin");
  }

  const job = await createJob({
    type: "addTeamMembers",
    actor: "admin",
    title: `Add ${usernames.length} member(s) to ${teamSlug}`,
    payload: {
      teamSlug,
      usernames,
      role,
      dryRun: Boolean(req.body.dryRun)
    }
  });

  res.status(202).json({ job });
}));

app.post("/api/teams/:teamSlug/members/remove", requireAdmin, asyncHandler(async (req, res) => {
  const teamSlug = normalizeSlug(req.params.teamSlug);
  const usernames = resolveUsernames(req.body.usernames);

  if (usernames.length === 0) return res.status(400).json({ error: "At least one username is required" });

  const job = await createJob({
    type: "removeTeamMembers",
    actor: "admin",
    title: `Remove ${usernames.length} member(s) from ${teamSlug}`,
    payload: {
      teamSlug,
      usernames,
      dryRun: Boolean(req.body.dryRun)
    }
  });

  res.status(202).json({ job });
}));

app.post("/api/teams/:teamSlug/repositories/grant", requireAdmin, asyncHandler(async (req, res) => {
  const teamSlug = normalizeSlug(req.params.teamSlug);
  const repositories = resolveRepositories(req.body.repositories);
  const permission = normalizePermission(req.body.permission || getState().settings.defaultPermission);

  if (repositories.length === 0) return res.status(400).json({ error: "At least one repository is required" });

  const job = await createJob({
    type: "grantTeamRepositories",
    actor: "admin",
    title: `Grant ${teamSlug} access to ${repositories.length} repositories`,
    payload: {
      teamSlug,
      repositories,
      permission,
      dryRun: Boolean(req.body.dryRun)
    }
  });

  res.status(202).json({ job });
}));

app.post("/api/teams/:teamSlug/repositories/remove", requireAdmin, asyncHandler(async (req, res) => {
  const teamSlug = normalizeSlug(req.params.teamSlug);
  const repositories = resolveRepositories(req.body.repositories);

  if (repositories.length === 0) return res.status(400).json({ error: "At least one repository is required" });

  const job = await createJob({
    type: "removeTeamRepositories",
    actor: "admin",
    title: `Remove ${teamSlug} from ${repositories.length} repositories`,
    payload: {
      teamSlug,
      repositories,
      dryRun: Boolean(req.body.dryRun)
    }
  });

  res.status(202).json({ job });
}));

app.post("/api/audit/collaborators", requireAdmin, asyncHandler(async (req, res) => {
  const repositories = resolveRepositories(req.body.repositories);
  if (repositories.length === 0) return res.status(400).json({ error: "At least one repository is required" });

  const job = await createJob({
    type: "auditCollaborators",
    actor: "admin",
    title: `Audit collaborators in ${repositories.length} repositories`,
    payload: { repositories }
  });

  res.status(202).json({ job });
}));

app.get("/api/jobs", requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 200);
  res.json({ jobs: getState().jobs.slice(0, limit) });
});

app.get("/api/jobs/:id", requireAdmin, (req, res) => {
  const job = getState().jobs.find((item) => item.id === req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ job });
});

app.post("/api/jobs/:id/retry", requireAdmin, asyncHandler(async (req, res) => {
  const job = await retryJob(req.params.id, "admin");
  res.status(202).json({ job });
}));

app.get("/api/audit-log", requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  res.json({ auditLog: getState().auditLog.slice(0, limit) });
});

app.get("/api/export/state", requireAdmin, (_req, res) => {
  res.setHeader("Content-Disposition", `attachment; filename="osh-github-manager-state-${Date.now()}.json"`);
  res.json(getState());
});

app.get("/api/export/members.csv", requireAdmin, (_req, res) => {
  const header = ["githubUsername", "displayName", "email", "status", "role", "requestedPermission", "repositories", "tags"];
  const rows = getState().members.map((member) => [
    member.githubUsername,
    member.displayName,
    member.email,
    member.status,
    member.role,
    member.requestedPermission,
    (member.repositories || []).map((item) => `${item.repo}:${item.permission}:${item.status}`).join("|"),
    (member.tags || []).join("|")
  ]);

  const csv = [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="members-${Date.now()}.csv"`);
  res.send(csv);
});

app.patch("/api/settings", requireAdmin, asyncHandler(async (req, res) => {
  await mutateState((state) => {
    if (req.body.defaultPermission !== undefined) {
      state.settings.defaultPermission = normalizePermission(req.body.defaultPermission);
    }
    if (req.body.autoInviteOnApproval !== undefined) {
      state.settings.autoInviteOnApproval = Boolean(req.body.autoInviteOnApproval);
    }
    if (req.body.includeArchivedRepositories !== undefined) {
      state.settings.includeArchivedRepositories = Boolean(req.body.includeArchivedRepositories);
    }
    if (req.body.requireApproval !== undefined) {
      state.settings.requireApproval = Boolean(req.body.requireApproval);
    }

    addAudit({
      actor: "admin",
      action: "settings.update",
      targetType: "settings",
      target: "global",
      details: req.body
    });
  });

  res.json({ settings: getState().settings });
}));

app.get("/api/state", requireLoginOrAdminToken, (req, res) => {
  const state = getState();
  const currentUser = isAdminTokenRequest(req) ? localAdminUser() : publicUser(req.currentUser);
  if (currentUser?.role !== "admin") {
    return res.json({
      members: state.members.filter((member) => member.githubUsername === currentUser.githubLogin),
      repositories: state.repositories.filter((repo) => repo.managed && !repo.disabled),
      teams: [],
      accessRequests: state.accessRequests.filter((request) => request.githubUsername === currentUser.githubLogin),
      jobs: [],
      auditLog: [],
      settings: state.settings,
      config: publicConfig(),
      currentUser
    });
  }

  res.json({
    members: state.members,
    repositories: state.repositories,
    teams: state.teams,
    accessRequests: state.accessRequests,
    jobs: state.jobs.slice(0, 50),
    auditLog: state.auditLog.slice(0, 100),
    settings: state.settings,
    config: publicConfig(),
    currentUser
  });
});

app.use((err, _req, res, _next) => {
  const status = err.statusCode || err.status || 500;
  res.status(status).json({
    error: err.message || "Internal server error",
    status
  });
});

app.listen(config.port, () => {
  console.log(`OSH GitHub Manager listening on http://localhost:${config.port}`);
});

function requireAdmin(req, res, next) {
  const header = req.get("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (config.adminToken && token === config.adminToken) {
    return next();
  }

  return requireAdminUser(req, res, next);
}

function requireLoginOrAdminToken(req, res, next) {
  if (isAdminTokenRequest(req)) return next();
  return requireLogin(req, res, next);
}

function isAdminTokenRequest(req) {
  if (!config.adminToken) return false;
  const header = req.get("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "");
  return token === config.adminToken;
}

function localAdminUser() {
  return {
    githubLogin: config.adminGithubLogins[0] || config.githubOwner || "admin",
    name: "Local Admin",
    avatarUrl: "",
    htmlUrl: config.githubOwner ? `https://github.com/${config.githubOwner}` : "",
    role: "admin"
  };
}

function asyncHandler(callback) {
  return (req, res, next) => Promise.resolve(callback(req, res, next)).catch(next);
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function upsertMember(input, actor) {
  const githubUsername = normalizeLogin(input.githubUsername);
  const status = input.status ? normalizeMemberStatus(input.status) : "approved";
  const requestedPermission = normalizePermission(input.requestedPermission || input.permission || getState().settings.defaultPermission);
  let githubProfile = null;

  try {
    githubProfile = await getUser(githubUsername);
  } catch {
    githubProfile = null;
  }

  let member;
  await mutateState((state) => {
    member = state.members.find((item) => item.githubUsername === githubUsername);
    if (member) {
      member.displayName = String(input.displayName ?? member.displayName ?? "").trim();
      member.email = String(input.email ?? member.email ?? "").trim();
      member.note = String(input.note ?? member.note ?? "").trim();
      member.role = String(input.role ?? member.role ?? "contributor").trim();
      member.tags = input.tags !== undefined ? normalizeTags(input.tags) : member.tags || [];
      member.requestedPermission = requestedPermission;
      member.status = status;
      member.githubProfile = githubProfile ? simplifyGitHubUser(githubProfile) : member.githubProfile;
      member.updatedAt = nowIso();
    } else {
      member = {
        id: `member_${githubUsername}`,
        githubUsername,
        displayName: String(input.displayName || "").trim(),
        email: String(input.email || "").trim(),
        note: String(input.note || "").trim(),
        requestedPermission,
        status,
        role: String(input.role || "contributor").trim(),
        tags: normalizeTags(input.tags),
        repositories: [],
        githubProfile: githubProfile ? simplifyGitHubUser(githubProfile) : null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        approvedAt: status === "approved" ? nowIso() : null,
        approvedBy: status === "approved" ? actor : null
      };
      state.members.unshift(member);
    }

    addAudit({
      actor,
      action: "member.upsert",
      targetType: "member",
      target: githubUsername,
      details: { status, requestedPermission }
    });
  });

  return member;
}

function simplifyGitHubUser(user) {
  return {
    id: user.id,
    login: user.login,
    name: user.name || "",
    avatarUrl: user.avatar_url || "",
    htmlUrl: user.html_url || "",
    company: user.company || "",
    blog: user.blog || "",
    location: user.location || "",
    publicRepos: user.public_repos ?? null,
    followers: user.followers ?? null
  };
}

function normalizePermission(value) {
  const permission = String(value || "").trim().toLowerCase();
  const allowed = new Set(["pull", "triage", "push", "maintain", "admin"]);
  if (!allowed.has(permission)) {
    throw new HttpError(400, "Permission must be one of: pull, triage, push, maintain, admin");
  }
  return permission;
}

function normalizeMemberStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  const allowed = new Set(["pending", "approved", "rejected", "disabled"]);
  if (!allowed.has(status)) {
    throw new HttpError(400, "Status must be one of: pending, approved, rejected, disabled");
  }
  return status;
}

function normalizeTeamRole(value) {
  const role = String(value || "").trim().toLowerCase();
  const allowed = new Set(["member", "maintainer"]);
  if (!allowed.has(role)) {
    throw new HttpError(400, "Team role must be one of: member, maintainer");
  }
  return role;
}

function normalizeSlug(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return unique(tags.map((tag) => String(tag).trim()).filter(Boolean));
  return unique(parseCsvLine(tags));
}

function resolveUsernames(input) {
  const usernames = Array.isArray(input) ? input : parseCsvLine(input);
  return unique(usernames.map(normalizeLogin));
}

function resolveRepositories(input) {
  const state = getState();

  if (!input || input === "managed" || input === "all" || (Array.isArray(input) && input.length === 0)) {
    return state.repositories
      .filter((repo) => repo.managed && !repo.disabled)
      .map((repo) => repo.name);
  }

  const names = Array.isArray(input) ? input : parseCsvLine(input);
  return unique(names.map(normalizeRepoName));
}

function resolveRequestedRepositories(input) {
  const names = Array.isArray(input) ? input : parseCsvLine(input);
  const available = new Set(getState().repositories.map((repo) => repo.name));
  return unique(names.map(normalizeRepoName)).filter((name) => available.has(name));
}

function resolveTeamSlugs(input) {
  const state = getState();

  if (!input || input === "managed" || input === "all" || (Array.isArray(input) && input.length === 0)) {
    return state.teams
      .filter((team) => team.managed)
      .map((team) => team.slug);
  }

  const slugs = Array.isArray(input) ? input : parseCsvLine(input);
  return unique(slugs.map(normalizeSlug));
}
