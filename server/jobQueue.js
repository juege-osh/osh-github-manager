import { config } from "./config.js";
import {
  addTeamMembership,
  addTeamRepository,
  getCollaboratorPermission,
  inviteCollaborator,
  listCollaborators,
  removeCollaborator,
  removeTeamMembership,
  removeTeamRepository
} from "./github.js";
import { addAudit, getState, mutateState, saveState } from "./store.js";
import { id, nowIso, sleep } from "./utils.js";

const handlers = {
  invite: runInviteJob,
  remove: runRemoveJob,
  offboardMember: runOffboardMemberJob,
  addTeamMembers: runAddTeamMembersJob,
  removeTeamMembers: runRemoveTeamMembersJob,
  grantTeamRepositories: runGrantTeamRepositoriesJob,
  removeTeamRepositories: runRemoveTeamRepositoriesJob,
  auditCollaborators: runAuditCollaboratorsJob
};

let active = 0;
let started = false;

export function startJobQueue() {
  if (started) return;
  started = true;
  setInterval(processJobs, 500);
  void processJobs();
}

export async function createJob({ type, actor = "admin", title, payload }) {
  const job = {
    id: id("job"),
    type,
    title: title || type,
    payload,
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    actor,
    progress: {
      total: 0,
      completed: 0,
      failed: 0
    },
    results: []
  };

  await mutateState((state) => {
    state.jobs.unshift(job);
    state.jobs = state.jobs.slice(0, 1000);
    addAudit({
      actor,
      action: `job.${type}.queued`,
      targetType: "job",
      target: job.id,
      details: { title: job.title, payload }
    });
  });

  void processJobs();
  return job;
}

export async function retryJob(jobId, actor = "admin") {
  let clonedJob;

  await mutateState((state) => {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job) throw new Error("Job not found");
    if (!["failed", "completed"].includes(job.status)) {
      throw new Error("Only completed or failed jobs can be retried");
    }

    clonedJob = {
      ...job,
      id: id("job"),
      status: "queued",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      actor,
      progress: {
        total: 0,
        completed: 0,
        failed: 0
      },
      results: []
    };
    state.jobs.unshift(clonedJob);
    addAudit({
      actor,
      action: "job.retry",
      targetType: "job",
      target: jobId,
      details: { newJobId: clonedJob.id }
    });
  });

  void processJobs();
  return clonedJob;
}

async function processJobs() {
  while (active < config.jobConcurrency) {
    const job = getState().jobs.find((item) => item.status === "queued");
    if (!job) return;

    job.status = "running";
    job.startedAt = nowIso();
    job.updatedAt = nowIso();
    await saveState();

    active += 1;
    runJob(job.id).finally(() => {
      active -= 1;
      void processJobs();
    });
  }
}

async function runJob(jobId) {
  const job = getState().jobs.find((item) => item.id === jobId);
  if (!job) return;

  try {
    const handler = handlers[job.type];
    if (!handler) throw new Error(`Unknown job type: ${job.type}`);

    await handler(job);

    await mutateState(() => {
      job.status = job.progress.failed > 0 ? "failed" : "completed";
      job.finishedAt = nowIso();
      job.updatedAt = nowIso();
      addAudit({
        actor: job.actor,
        action: `job.${job.type}.${job.status}`,
        targetType: "job",
        target: job.id,
        details: job.progress
      });
    });
  } catch (error) {
    await mutateState(() => {
      job.status = "failed";
      job.finishedAt = nowIso();
      job.updatedAt = nowIso();
      job.results.push({
        status: "failed",
        message: error.message,
        at: nowIso()
      });
      job.progress.failed += 1;
      addAudit({
        actor: job.actor,
        action: `job.${job.type}.failed`,
        targetType: "job",
        target: job.id,
        details: { message: error.message }
      });
    });
  }
}

async function runInviteJob(job) {
  const { usernames, repositories, permission } = job.payload;
  const operations = [];

  for (const username of usernames) {
    for (const repo of repositories) {
      operations.push({ username, repo, permission });
    }
  }

  await setJobTotal(job, operations.length);

  for (const operation of operations) {
    await runOperation(job, operation, async () => {
      if (job.payload.dryRun) {
        return "Dry run: invitation would be sent";
      }
      const response = await inviteCollaborator(operation.repo, operation.username, operation.permission);
      markMemberRepo(operation.username, operation.repo, operation.permission, response);
      addAudit({
        actor: job.actor,
        action: "collaborator.invite",
        targetType: "repository",
        target: operation.repo,
        details: {
          username: operation.username,
          permission: operation.permission,
          invitationId: response?.id || null
        }
      });
      return response?.html_url ? `Invitation sent: ${response.html_url}` : "Invitation sent or permission updated";
    });
  }
}

async function runRemoveJob(job) {
  const { usernames, repositories } = job.payload;
  const operations = [];

  for (const username of usernames) {
    for (const repo of repositories) {
      operations.push({ username, repo });
    }
  }

  await setJobTotal(job, operations.length);

  for (const operation of operations) {
    await runOperation(job, operation, async () => {
      if (job.payload.dryRun) {
        return "Dry run: collaborator would be removed";
      }
      await removeCollaborator(operation.repo, operation.username);
      unmarkMemberRepo(operation.username, operation.repo);
      addAudit({
        actor: job.actor,
        action: "collaborator.remove",
        targetType: "repository",
        target: operation.repo,
        details: { username: operation.username }
      });
      return "Collaborator removed";
    });
  }
}

async function runOffboardMemberJob(job) {
  const { username, repositories, teamSlugs } = job.payload;
  const operations = [
    ...repositories.map((repo) => ({ kind: "repository", repo, username })),
    ...teamSlugs.map((teamSlug) => ({ kind: "team", teamSlug, username }))
  ];

  await setJobTotal(job, operations.length);

  for (const operation of operations) {
    await runOperation(job, operation, async () => {
      if (job.payload.dryRun) {
        return operation.kind === "repository"
          ? "Dry run: collaborator would be removed"
          : "Dry run: team membership would be removed";
      }

      if (operation.kind === "repository") {
        await removeCollaborator(operation.repo, username);
        unmarkMemberRepo(username, operation.repo);
        addAudit({
          actor: job.actor,
          action: "member.offboard.repository.remove",
          targetType: "repository",
          target: operation.repo,
          details: { username }
        });
        return "Collaborator removed";
      }

      await removeTeamMembership(operation.teamSlug, username);
      unmarkMemberTeam(username, operation.teamSlug);
      addAudit({
        actor: job.actor,
        action: "member.offboard.team.remove",
        targetType: "team",
        target: operation.teamSlug,
        details: { username }
      });
      return "Team membership removed";
    });
  }
}

async function runAddTeamMembersJob(job) {
  const { usernames, teamSlug, role } = job.payload;
  await setJobTotal(job, usernames.length);

  for (const username of usernames) {
    await runOperation(job, { username, teamSlug }, async () => {
      if (job.payload.dryRun) return "Dry run: member would be added to team";
      const response = await addTeamMembership(teamSlug, username, role);
      markMemberTeam(username, teamSlug, role, response?.state || "pending");
      addAudit({
        actor: job.actor,
        action: "team.member.add",
        targetType: "team",
        target: teamSlug,
        details: { username, role, state: response?.state || null }
      });
      return `Team membership ${response?.state || "updated"}`;
    });
  }
}

async function runRemoveTeamMembersJob(job) {
  const { usernames, teamSlug } = job.payload;
  await setJobTotal(job, usernames.length);

  for (const username of usernames) {
    await runOperation(job, { username, teamSlug }, async () => {
      if (job.payload.dryRun) return "Dry run: member would be removed from team";
      await removeTeamMembership(teamSlug, username);
      unmarkMemberTeam(username, teamSlug);
      addAudit({
        actor: job.actor,
        action: "team.member.remove",
        targetType: "team",
        target: teamSlug,
        details: { username }
      });
      return "Team membership removed";
    });
  }
}

async function runGrantTeamRepositoriesJob(job) {
  const { repositories, teamSlug, permission } = job.payload;
  await setJobTotal(job, repositories.length);

  for (const repo of repositories) {
    await runOperation(job, { repo, teamSlug }, async () => {
      if (job.payload.dryRun) return "Dry run: repository would be granted to team";
      await addTeamRepository(teamSlug, repo, permission);
      markTeamRepo(teamSlug, repo, permission);
      addAudit({
        actor: job.actor,
        action: "team.repository.grant",
        targetType: "team",
        target: teamSlug,
        details: { repo, permission }
      });
      return "Team repository permission granted";
    });
  }
}

async function runRemoveTeamRepositoriesJob(job) {
  const { repositories, teamSlug } = job.payload;
  await setJobTotal(job, repositories.length);

  for (const repo of repositories) {
    await runOperation(job, { repo, teamSlug }, async () => {
      if (job.payload.dryRun) return "Dry run: repository would be removed from team";
      await removeTeamRepository(teamSlug, repo);
      unmarkTeamRepo(teamSlug, repo);
      addAudit({
        actor: job.actor,
        action: "team.repository.remove",
        targetType: "team",
        target: teamSlug,
        details: { repo }
      });
      return "Repository removed from team";
    });
  }
}

async function runAuditCollaboratorsJob(job) {
  const { repositories } = job.payload;
  await setJobTotal(job, repositories.length);

  for (const repo of repositories) {
    await runOperation(job, { repo }, async () => {
      const collaborators = await listCollaborators(repo);
      const state = getState();
      const expected = new Set(
        state.members
          .filter((member) => member.status === "approved")
          .filter((member) => (member.repositories || []).some((access) => access.repo === repo))
          .map((member) => member.githubUsername)
      );

      const direct = collaborators.map((user) => ({
        username: user.login,
        permissions: user.permissions || {}
      }));

      const unexpected = direct
        .filter((user) => !expected.has(String(user.username).toLowerCase()))
        .map((user) => user.username);

      await mutateState((draft) => {
        const repository = draft.repositories.find((item) => item.name === repo);
        if (repository) {
          repository.lastAuditAt = nowIso();
          repository.collaboratorCount = direct.length;
          repository.unexpectedCollaborators = unexpected;
        }
      });

      return unexpected.length
        ? `Found ${unexpected.length} unexpected direct collaborators`
        : "No unexpected direct collaborators";
    });
  }
}

async function setJobTotal(job, total) {
  await mutateState(() => {
    job.progress.total = total;
    job.updatedAt = nowIso();
  });
}

async function runOperation(job, operation, callback) {
  try {
    const message = await callback();
    await mutateState(() => {
      job.progress.completed += 1;
      job.updatedAt = nowIso();
      job.results.push({
        ...operation,
        status: "completed",
        message,
        at: nowIso()
      });
    });
  } catch (error) {
    await mutateState(() => {
      job.progress.completed += 1;
      job.progress.failed += 1;
      job.updatedAt = nowIso();
      job.results.push({
        ...operation,
        status: "failed",
        message: error.message,
        statusCode: error.status || null,
        at: nowIso()
      });
    });
  }

  if (config.jobDelayMs > 0) {
    await sleep(config.jobDelayMs);
  }
}

function markMemberRepo(username, repo, permission, response) {
  const state = getState();
  const member = state.members.find((item) => item.githubUsername === username);
  if (!member) return;

  const existing = member.repositories.find((item) => item.repo === repo);
  const access = {
    repo,
    permission,
    invitedAt: nowIso(),
    invitationId: response?.id || null,
    invitationUrl: response?.html_url || null,
    status: response?.id ? "invited" : "active"
  };

  if (existing) {
    Object.assign(existing, access);
  } else {
    member.repositories.push(access);
  }
}

function unmarkMemberRepo(username, repo) {
  const state = getState();
  const member = state.members.find((item) => item.githubUsername === username);
  if (!member) return;
  member.repositories = member.repositories.filter((item) => item.repo !== repo);
}

function markMemberTeam(username, teamSlug, role, status) {
  const state = getState();
  const member = state.members.find((item) => item.githubUsername === username);
  if (!member) return;
  member.teams ||= [];
  const existing = member.teams.find((item) => item.teamSlug === teamSlug);
  const access = {
    teamSlug,
    role,
    status,
    updatedAt: nowIso()
  };
  if (existing) Object.assign(existing, access);
  else member.teams.push(access);
}

function unmarkMemberTeam(username, teamSlug) {
  const state = getState();
  const member = state.members.find((item) => item.githubUsername === username);
  if (!member) return;
  member.teams = (member.teams || []).filter((item) => item.teamSlug !== teamSlug);
}

function markTeamRepo(teamSlug, repo, permission) {
  const state = getState();
  const team = state.teams.find((item) => item.slug === teamSlug);
  if (!team) return;
  team.repositories ||= [];
  const existing = team.repositories.find((item) => item.repo === repo);
  const access = {
    repo,
    permission,
    updatedAt: nowIso()
  };
  if (existing) Object.assign(existing, access);
  else team.repositories.push(access);
}

function unmarkTeamRepo(teamSlug, repo) {
  const state = getState();
  const team = state.teams.find((item) => item.slug === teamSlug);
  if (!team) return;
  team.repositories = (team.repositories || []).filter((item) => item.repo !== repo);
}

export async function refreshMemberPermission(username, repo) {
  const data = await getCollaboratorPermission(repo, username);
  await mutateState((state) => {
    const member = state.members.find((item) => item.githubUsername === username);
    if (!member) return;
    const existing = member.repositories.find((item) => item.repo === repo);
    if (!existing) return;
    existing.permission = data.permission;
    existing.status = "active";
    existing.checkedAt = nowIso();
  });
  await saveState();
  return data;
}
