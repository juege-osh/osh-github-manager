const state = {
  config: null,
  data: {
    members: [],
    repositories: [],
    teams: [],
    accessRequests: [],
    jobs: [],
    auditLog: [],
    settings: {}
  },
  adminToken: localStorage.getItem("osh_admin_token") || "",
  currentUser: null,
  view: "dashboard",
  filters: {
    memberSearch: "",
    memberStatus: "",
    repoSearch: "",
    repoManaged: "",
    teamSearch: "",
    teamManaged: ""
  }
};

const els = {
  ownerLabel: document.querySelector("#ownerLabel"),
  pageTitle: document.querySelector("#pageTitle"),
  alertHost: document.querySelector("#alertHost"),
  authBox: document.querySelector("#authBox"),
  adminTokenInput: document.querySelector("#adminTokenInput"),
  saveTokenButton: document.querySelector("#saveTokenButton"),
  loginLink: document.querySelector("#loginLink"),
  userMenu: document.querySelector("#userMenu"),
  currentUserLabel: document.querySelector("#currentUserLabel"),
  logoutButton: document.querySelector("#logoutButton"),
  refreshButton: document.querySelector("#refreshButton"),
  navItems: document.querySelectorAll(".nav-item"),
  views: document.querySelectorAll(".view"),
  metricMembers: document.querySelector("#metricMembers"),
  metricPending: document.querySelector("#metricPending"),
  metricRepos: document.querySelector("#metricRepos"),
  metricManaged: document.querySelector("#metricManaged"),
  metricJobs: document.querySelector("#metricJobs"),
  metricRunning: document.querySelector("#metricRunning"),
  metricTeams: document.querySelector("#metricTeams"),
  metricManagedTeams: document.querySelector("#metricManagedTeams"),
  metricUnexpected: document.querySelector("#metricUnexpected"),
  pendingList: document.querySelector("#pendingList"),
  recentJobs: document.querySelector("#recentJobs"),
  memberSearch: document.querySelector("#memberSearch"),
  memberStatusFilter: document.querySelector("#memberStatusFilter"),
  membersTable: document.querySelector("#membersTable"),
  openAddMemberButton: document.querySelector("#openAddMemberButton"),
  memberDialog: document.querySelector("#memberDialog"),
  memberForm: document.querySelector("#memberForm"),
  repoSearch: document.querySelector("#repoSearch"),
  repoManagedFilter: document.querySelector("#repoManagedFilter"),
  reposTable: document.querySelector("#reposTable"),
  syncReposButton: document.querySelector("#syncReposButton"),
  auditAllButton: document.querySelector("#auditAllButton"),
  teamSearch: document.querySelector("#teamSearch"),
  teamManagedFilter: document.querySelector("#teamManagedFilter"),
  teamsTable: document.querySelector("#teamsTable"),
  syncTeamsButton: document.querySelector("#syncTeamsButton"),
  bulkInviteForm: document.querySelector("#bulkInviteForm"),
  bulkRemoveForm: document.querySelector("#bulkRemoveForm"),
  bulkMemberForm: document.querySelector("#bulkMemberForm"),
  teamMemberForm: document.querySelector("#teamMemberForm"),
  teamRepoForm: document.querySelector("#teamRepoForm"),
  reloadJobsButton: document.querySelector("#reloadJobsButton"),
  jobsList: document.querySelector("#jobsList"),
  auditLog: document.querySelector("#auditLog"),
  settingsForm: document.querySelector("#settingsForm"),
  saveSettingsButton: document.querySelector("#saveSettingsButton"),
  applyForm: document.querySelector("#applyForm"),
  applyLoginNotice: document.querySelector("#applyLoginNotice"),
  applyRepoList: document.querySelector("#applyRepoList"),
  configOwner: document.querySelector("#configOwner"),
  configToken: document.querySelector("#configToken"),
  configAdminAuth: document.querySelector("#configAdminAuth"),
  exportMembersLink: document.querySelector("#exportMembersLink"),
  exportStateLink: document.querySelector("#exportStateLink")
};

const pageTitles = {
  dashboard: "总览",
  members: "成员",
  repositories: "仓库",
  teams: "团队",
  bulk: "批量",
  jobs: "任务",
  audit: "审计",
  settings: "设置",
  apply: "申请入口"
};

init();

async function init() {
  bindEvents();
  await loadConfig();
  await loadMe();
  await loadState();
  render();
  setInterval(refreshJobsQuietly, 2500);
}

function bindEvents() {
  els.navItems.forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  document.querySelectorAll("[data-view-shortcut]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.viewShortcut));
  });

  els.refreshButton.addEventListener("click", () => loadState(true));
  els.saveTokenButton.addEventListener("click", saveAdminToken);
  els.logoutButton.addEventListener("click", logout);

  els.memberSearch.addEventListener("input", () => {
    state.filters.memberSearch = els.memberSearch.value;
    renderMembers();
  });

  els.memberStatusFilter.addEventListener("change", () => {
    state.filters.memberStatus = els.memberStatusFilter.value;
    renderMembers();
  });

  els.repoSearch.addEventListener("input", () => {
    state.filters.repoSearch = els.repoSearch.value;
    renderRepositories();
  });

  els.repoManagedFilter.addEventListener("change", () => {
    state.filters.repoManaged = els.repoManagedFilter.value;
    renderRepositories();
  });

  els.teamSearch.addEventListener("input", () => {
    state.filters.teamSearch = els.teamSearch.value;
    renderTeams();
  });

  els.teamManagedFilter.addEventListener("change", () => {
    state.filters.teamManaged = els.teamManagedFilter.value;
    renderTeams();
  });

  els.openAddMemberButton.addEventListener("click", () => {
    els.memberForm.reset();
    els.memberDialog.showModal();
  });

  els.memberForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = formData(els.memberForm);
    await api("/api/members", { method: "POST", body: payload });
    els.memberDialog.close();
    showAlert("成员已保存", "success");
    await loadState();
  });

  els.syncReposButton.addEventListener("click", async () => {
    const includeArchived = state.data.settings.includeArchivedRepositories;
    const { repositories } = await api("/api/repositories/sync", {
      method: "POST",
      body: { includeArchived }
    });
    showAlert(`已同步 ${repositories.length} 个仓库`, "success");
    await loadState();
  });

  els.auditAllButton.addEventListener("click", async () => {
    const repositories = managedRepositories().map((repo) => repo.name);
    if (!repositories.length) return showAlert("没有纳入管理的仓库", "error");
    await api("/api/audit/collaborators", { method: "POST", body: { repositories } });
    showAlert("审计任务已创建", "success");
    await loadState();
    switchView("jobs");
  });

  els.syncTeamsButton.addEventListener("click", async () => {
    const { teams } = await api("/api/teams/sync", {
      method: "POST",
      body: {}
    });
    showAlert(`已同步 ${teams.length} 个团队`, "success");
    await loadState();
  });

  els.bulkInviteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = formData(els.bulkInviteForm);
    await api("/api/bulk/invite", { method: "POST", body: normalizeBulkPayload(payload) });
    showAlert("邀请任务已创建", "success");
    els.bulkInviteForm.reset();
    await loadState();
    switchView("jobs");
  });

  els.bulkRemoveForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = formData(els.bulkRemoveForm);
    await api("/api/bulk/remove", { method: "POST", body: normalizeBulkPayload(payload) });
    showAlert("撤销任务已创建", "success");
    els.bulkRemoveForm.reset();
    await loadState();
    switchView("jobs");
  });

  els.bulkMemberForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = formData(els.bulkMemberForm);
    const members = parseMemberImport(payload.members, payload.permission);
    if (!members.length) return showAlert("没有可导入的成员", "error");
    await api("/api/members/import", { method: "POST", body: { members } });
    showAlert(`已导入 ${members.length} 个成员`, "success");
    els.bulkMemberForm.reset();
    await loadState();
    switchView("members");
  });

  els.teamMemberForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitter = event.submitter;
    const action = submitter?.dataset.teamMemberAction || "add";
    const payload = formData(els.teamMemberForm);
    const teamSlug = String(payload.teamSlug || "").trim();
    if (!teamSlug) return showAlert("Team slug 必填", "error");
    const url = `/api/teams/${encodeURIComponent(teamSlug)}/members/${action}`;
    await api(url, {
      method: "POST",
      body: {
        usernames: splitLines(payload.usernames),
        role: payload.role,
        dryRun: Boolean(payload.dryRun)
      }
    });
    showAlert(action === "add" ? "团队成员任务已创建" : "移出团队任务已创建", "success");
    await loadState();
    switchView("jobs");
  });

  els.teamRepoForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitter = event.submitter;
    const action = submitter?.dataset.teamRepoAction || "grant";
    const payload = formData(els.teamRepoForm);
    const teamSlug = String(payload.teamSlug || "").trim();
    if (!teamSlug) return showAlert("Team slug 必填", "error");
    const url = `/api/teams/${encodeURIComponent(teamSlug)}/repositories/${action}`;
    await api(url, {
      method: "POST",
      body: {
        repositories: splitLines(payload.repositories),
        permission: payload.permission,
        dryRun: Boolean(payload.dryRun)
      }
    });
    showAlert(action === "grant" ? "团队仓库授权任务已创建" : "团队仓库撤销任务已创建", "success");
    await loadState();
    switchView("jobs");
  });

  els.reloadJobsButton.addEventListener("click", () => loadState(true));

  els.saveSettingsButton.addEventListener("click", async () => {
    const payload = formData(els.settingsForm);
    payload.autoInviteOnApproval = Boolean(payload.autoInviteOnApproval);
    payload.includeArchivedRepositories = Boolean(payload.includeArchivedRepositories);
    payload.requireApproval = Boolean(payload.requireApproval);
    await api("/api/settings", { method: "PATCH", body: payload });
    showAlert("设置已保存", "success");
    await loadState();
  });

  els.applyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = formData(els.applyForm);
    payload.repositories = selectedApplyRepositories();
    await api("/api/apply", { method: "POST", body: payload, admin: false });
    showAlert("申请已提交", "success");
    els.applyForm.reset();
    await loadState();
  });

  els.exportMembersLink.addEventListener("click", downloadWithAuth);
  els.exportStateLink.addEventListener("click", downloadWithAuth);

  document.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;

    const action = target.dataset.action;
    const username = target.dataset.username;
    const repo = target.dataset.repo;
    const jobId = target.dataset.job;

    if (action === "approve-member") {
      await approveMember(username);
    }
    if (action === "reject-member") {
      await rejectMember(username);
    }
    if (action === "invite-member") {
      await inviteMember(username);
    }
    if (action === "revoke-member") {
      await revokeMember(username);
    }
    if (action === "offboard-member") {
      await offboardMember(username);
    }
    if (action === "disable-member") {
      await updateMember(username, { status: "disabled" });
    }
    if (action === "enable-member") {
      await updateMember(username, { status: "approved" });
    }
    if (action === "delete-member") {
      await deleteMember(username);
    }
    if (action === "toggle-repo") {
      await toggleRepository(repo, target.dataset.managed !== "true");
    }
    if (action === "audit-repo") {
      await api("/api/audit/collaborators", { method: "POST", body: { repositories: [repo] } });
      showAlert("仓库审计任务已创建", "success");
      await loadState();
      switchView("jobs");
    }
    if (action === "toggle-team") {
      await toggleTeam(target.dataset.team, target.dataset.managed !== "true");
    }
    if (action === "use-team") {
      useTeam(target.dataset.team);
    }
    if (action === "retry-job") {
      await api(`/api/jobs/${jobId}/retry`, { method: "POST", body: {} });
      showAlert("任务已重新排队", "success");
      await loadState();
    }
  });
}

async function loadMe() {
  try {
    const { user } = await api("/api/me", { admin: false });
    state.currentUser = user;
  } catch {
    state.currentUser = null;
  }
}

async function loadConfig() {
  state.config = await api("/api/config", { admin: false });
  els.ownerLabel.textContent = state.config.githubOwner || "未配置 GitHub Owner";
  els.configOwner.textContent = state.config.githubOwner || "未配置";
  els.configToken.textContent = state.config.tokenConfigured ? "已配置" : "未配置";
  els.configAdminAuth.textContent = state.config.adminAuthEnabled ? "开启" : "关闭";

  els.authBox.classList.toggle("hidden", !state.config.adminAuthEnabled);
  if (state.config.adminAuthEnabled) {
    els.adminTokenInput.value = state.adminToken;
  }
}

async function loadState(withAlert = false) {
  try {
    state.data = await api("/api/state");
    state.currentUser = state.data.currentUser || state.currentUser;
    render();
    if (withAlert) showAlert("数据已刷新", "success");
  } catch (error) {
    if (error.status === 401) {
      const { repositories } = await api("/api/public/repositories", { admin: false });
      state.data = {
        members: [],
        repositories,
        teams: [],
        accessRequests: [],
        jobs: [],
        auditLog: [],
        settings: { defaultPermission: "push" },
        config: state.config,
        currentUser: null
      };
      render();
      return;
    }
    showAlert(error.message, "error");
  }
}

async function refreshJobsQuietly() {
  const hasActive = state.data.jobs.some((job) => ["queued", "running"].includes(job.status));
  if (!hasActive) return;
  try {
    state.data = await api("/api/state");
    renderDashboard();
    renderJobs();
  } catch {
    // Keep background polling quiet.
  }
}

async function api(url, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {})
  };

  if (options.admin !== false && state.adminToken) {
    headers.Authorization = `Bearer ${state.adminToken}`;
  }

  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const contentType = response.headers.get("Content-Type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    const message = typeof data === "string" ? data : data.error || "请求失败";
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return data;
}

function saveAdminToken() {
  state.adminToken = els.adminTokenInput.value.trim();
  if (state.adminToken) {
    localStorage.setItem("osh_admin_token", state.adminToken);
  } else {
    localStorage.removeItem("osh_admin_token");
  }
  showAlert("Admin Token 已保存", "success");
  void loadState();
}

function render() {
  renderAuth();
  applyRoleVisibility();
  renderDashboard();
  renderMembers();
  renderRepositories();
  renderTeams();
  renderApplyRepositories();
  renderJobs();
  renderAuditLog();
  renderSettings();
  updateExportLinks();
}

function renderAuth() {
  const user = state.currentUser;
  els.loginLink.classList.toggle("hidden", Boolean(user));
  els.userMenu.classList.toggle("hidden", !user);
  els.currentUserLabel.textContent = user ? `${user.githubLogin} · ${user.role === "admin" ? "管理员" : "普通用户"}` : "";
  els.applyForm.classList.toggle("hidden", !user);
  els.applyLoginNotice.classList.toggle("hidden", Boolean(user));
}

function applyRoleVisibility() {
  const isAdmin = state.currentUser?.role === "admin";
  document.querySelectorAll(".nav-item").forEach((button) => {
    const view = button.dataset.view;
    const allowed = isAdmin || view === "apply";
    button.classList.toggle("hidden", !allowed);
  });
  if (!isAdmin && state.view !== "apply") {
    switchView("apply");
  }
}

function switchView(view) {
  state.view = view;
  els.pageTitle.textContent = pageTitles[view] || view;

  els.navItems.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });

  els.views.forEach((section) => {
    section.classList.toggle("active", section.id === `view-${view}`);
  });
}

function renderDashboard() {
  const members = state.data.members;
  const repos = state.data.repositories;
  const jobs = state.data.jobs;
  const teams = state.data.teams || [];
  const pending = members.filter((member) => member.status === "pending");
  const managed = managedRepositories();
  const managedTeams = teams.filter((team) => team.managed);
  const activeJobs = jobs.filter((job) => ["queued", "running"].includes(job.status));
  const unexpected = repos.reduce((sum, repo) => sum + (repo.unexpectedCollaborators || []).length, 0);

  els.metricMembers.textContent = members.length;
  els.metricPending.textContent = `${pending.length} 待审批`;
  els.metricRepos.textContent = repos.length;
  els.metricManaged.textContent = `${managed.length} 纳入管理`;
  els.metricJobs.textContent = jobs.length;
  els.metricRunning.textContent = `${activeJobs.length} 运行中`;
  els.metricTeams.textContent = teams.length;
  els.metricManagedTeams.textContent = `${managedTeams.length} 纳入管理`;
  els.metricUnexpected.textContent = unexpected;

  els.pendingList.innerHTML = pending.length
    ? pending.slice(0, 8).map(renderPendingItem).join("")
    : `<div class="empty">没有待审批成员</div>`;

  els.recentJobs.innerHTML = jobs.length
    ? jobs.slice(0, 6).map(renderJobListItem).join("")
    : `<div class="empty">没有任务记录</div>`;
}

function renderPendingItem(member) {
  const requested = member.requestedRepositories?.length
    ? `申请项目：${member.requestedRepositories.join(", ")}`
    : "申请项目：全部管理仓库";
  return `
    <article class="list-item">
      <div>
        <div class="item-title">
          <span>${escapeHtml(member.githubUsername)}</span>
          ${statusBadge(member.status)}
        </div>
        <div class="item-meta">${escapeHtml(member.displayName || member.email || member.note || "无备注")}</div>
        <div class="item-meta">${escapeHtml(requested)}</div>
      </div>
      <div class="row-actions">
        <button class="button small" data-action="approve-member" data-username="${escapeAttr(member.githubUsername)}">批准</button>
        <button class="button small ghost" data-action="reject-member" data-username="${escapeAttr(member.githubUsername)}">拒绝</button>
      </div>
    </article>
  `;
}

function renderJobListItem(job) {
  return `
    <article class="list-item">
      <div>
        <div class="item-title">
          <span>${escapeHtml(job.title)}</span>
          ${statusBadge(job.status)}
        </div>
        <div class="item-meta">${job.progress.completed}/${job.progress.total || 0} 完成，${job.progress.failed} 失败</div>
      </div>
      <button class="button small ghost" data-view-shortcut="jobs">查看</button>
    </article>
  `;
}

function renderMembers() {
  let members = state.data.members;
  const q = state.filters.memberSearch.trim().toLowerCase();
  const status = state.filters.memberStatus;

  if (status) members = members.filter((member) => member.status === status);
  if (q) {
    members = members.filter((member) => {
      return [member.githubUsername, member.displayName, member.email, member.note, member.role, ...(member.tags || [])]
        .some((value) => String(value || "").toLowerCase().includes(q));
    });
  }

  if (!members.length) {
    els.membersTable.innerHTML = `<div class="empty">没有匹配的成员</div>`;
    return;
  }

  els.membersTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>成员</th>
          <th>状态</th>
          <th>权限</th>
          <th>仓库</th>
          <th>标签</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${members.map(renderMemberRow).join("")}
      </tbody>
    </table>
  `;
}

function renderMemberRow(member) {
  const profileUrl = member.githubProfile?.htmlUrl || `https://github.com/${member.githubUsername}`;
  const repositoryCount = (member.repositories || []).length;
  const disableAction = member.status === "disabled" ? "enable-member" : "disable-member";
  const disableLabel = member.status === "disabled" ? "启用" : "禁用";

  return `
    <tr>
      <td>
        <a class="link" href="${escapeAttr(profileUrl)}" target="_blank" rel="noreferrer">${escapeHtml(member.githubUsername)}</a>
        <div class="item-meta">${escapeHtml(member.displayName || member.email || member.note || "")}</div>
        <div class="item-meta">${escapeHtml((member.requestedRepositories || []).join(", ") || "未指定申请项目")}</div>
      </td>
      <td>${statusBadge(member.status)}</td>
      <td>${permissionBadge(member.requestedPermission)}</td>
      <td>${repositoryCount}</td>
      <td>${(member.tags || []).map((tag) => `<span class="badge">${escapeHtml(tag)}</span>`).join(" ")}</td>
      <td>
        <div class="row-actions">
          ${member.status === "pending" ? `<button class="button small" data-action="approve-member" data-username="${escapeAttr(member.githubUsername)}">批准</button>` : ""}
          <button class="button small ghost" data-action="invite-member" data-username="${escapeAttr(member.githubUsername)}">邀请</button>
          <button class="button small ghost" data-action="revoke-member" data-username="${escapeAttr(member.githubUsername)}">撤销</button>
          <button class="button small ghost" data-action="offboard-member" data-username="${escapeAttr(member.githubUsername)}">回收</button>
          <button class="button small ghost" data-action="${disableAction}" data-username="${escapeAttr(member.githubUsername)}">${disableLabel}</button>
          <button class="button small danger" data-action="delete-member" data-username="${escapeAttr(member.githubUsername)}">删除</button>
        </div>
      </td>
    </tr>
  `;
}

function renderRepositories() {
  let repos = state.data.repositories;
  const q = state.filters.repoSearch.trim().toLowerCase();
  const managed = state.filters.repoManaged;

  if (managed) repos = repos.filter((repo) => String(repo.managed) === managed);
  if (q) {
    repos = repos.filter((repo) => {
      return [repo.name, repo.description, repo.fullName].some((value) => String(value || "").toLowerCase().includes(q));
    });
  }

  if (!repos.length) {
    els.reposTable.innerHTML = `<div class="empty">没有仓库。先同步 GitHub 仓库。</div>`;
    return;
  }

  els.reposTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>仓库</th>
          <th>状态</th>
          <th>协作者</th>
          <th>最后同步</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${repos.map(renderRepositoryRow).join("")}
      </tbody>
    </table>
  `;
}

function renderApplyRepositories() {
  const repos = managedRepositories();
  if (!repos.length) {
    els.applyRepoList.innerHTML = `<div class="empty">暂无可申请仓库</div>`;
    return;
  }
  els.applyRepoList.innerHTML = repos.map((repo) => `
    <label class="checkbox-item">
      <input type="checkbox" name="repositories" value="${escapeAttr(repo.name)}" checked />
      <span>${escapeHtml(repo.name)}</span>
    </label>
  `).join("");
}

function renderRepositoryRow(repo) {
  const unexpected = repo.unexpectedCollaborators || [];
  return `
    <tr>
      <td>
        <a class="link" href="${escapeAttr(repo.htmlUrl || "#")}" target="_blank" rel="noreferrer">${escapeHtml(repo.name)}</a>
        <div class="item-meta">${escapeHtml(repo.description || repo.fullName || "")}</div>
      </td>
      <td>
        ${repo.managed ? `<span class="badge active">管理</span>` : `<span class="badge disabled">跳过</span>`}
        ${repo.private ? `<span class="badge">private</span>` : `<span class="badge">public</span>`}
        ${repo.archived ? `<span class="badge rejected">archived</span>` : ""}
      </td>
      <td>
        <strong>${repo.collaboratorCount ?? "-"}</strong>
        ${unexpected.length ? `<div class="item-meta">${unexpected.length} 异常：${escapeHtml(unexpected.slice(0, 3).join(", "))}</div>` : ""}
      </td>
      <td>${formatDate(repo.syncedAt)}</td>
      <td>
        <div class="row-actions">
          <button class="button small ghost" data-action="toggle-repo" data-repo="${escapeAttr(repo.name)}" data-managed="${repo.managed}">${repo.managed ? "跳过" : "纳入"}</button>
          <button class="button small ghost" data-action="audit-repo" data-repo="${escapeAttr(repo.name)}">审计</button>
        </div>
      </td>
    </tr>
  `;
}

function renderJobs() {
  const jobs = state.data.jobs;
  if (!jobs.length) {
    els.jobsList.innerHTML = `<div class="empty">没有任务</div>`;
    return;
  }

  els.jobsList.innerHTML = jobs.map(renderJobCard).join("");
}

function renderTeams() {
  let teams = state.data.teams || [];
  const q = state.filters.teamSearch.trim().toLowerCase();
  const managed = state.filters.teamManaged;

  if (managed) teams = teams.filter((team) => String(team.managed) === managed);
  if (q) {
    teams = teams.filter((team) => {
      return [team.name, team.slug, team.description].some((value) => String(value || "").toLowerCase().includes(q));
    });
  }

  if (!teams.length) {
    els.teamsTable.innerHTML = `<div class="empty">没有团队。组织 owner 配置后可同步 GitHub Teams。</div>`;
    return;
  }

  els.teamsTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>团队</th>
          <th>状态</th>
          <th>成员/仓库</th>
          <th>最后同步</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${teams.map(renderTeamRow).join("")}
      </tbody>
    </table>
  `;
}

function renderTeamRow(team) {
  return `
    <tr>
      <td>
        <a class="link" href="${escapeAttr(team.htmlUrl || "#")}" target="_blank" rel="noreferrer">${escapeHtml(team.name || team.slug)}</a>
        <div class="item-meta">${escapeHtml(team.slug)} · ${escapeHtml(team.description || "")}</div>
      </td>
      <td>
        ${team.managed ? `<span class="badge active">管理</span>` : `<span class="badge disabled">跳过</span>`}
        ${team.privacy ? `<span class="badge">${escapeHtml(team.privacy)}</span>` : ""}
      </td>
      <td>
        <strong>${team.membersCount ?? "-"}</strong> 成员 / <strong>${team.reposCount ?? "-"}</strong> 仓库
        <div class="item-meta">本地记录仓库 ${(team.repositories || []).length} 个</div>
      </td>
      <td>${formatDate(team.syncedAt)}</td>
      <td>
        <div class="row-actions">
          <button class="button small ghost" data-action="use-team" data-team="${escapeAttr(team.slug)}">使用</button>
          <button class="button small ghost" data-action="toggle-team" data-team="${escapeAttr(team.slug)}" data-managed="${team.managed}">${team.managed ? "跳过" : "纳入"}</button>
        </div>
      </td>
    </tr>
  `;
}

function renderJobCard(job) {
  const total = job.progress.total || 0;
  const completed = job.progress.completed || 0;
  const percent = total ? Math.round((completed / total) * 100) : 0;
  const retry = ["failed", "completed"].includes(job.status)
    ? `<button class="button small ghost" data-action="retry-job" data-job="${escapeAttr(job.id)}">重试</button>`
    : "";

  return `
    <article class="job-card">
      <div class="job-head">
        <div>
          <h3>${escapeHtml(job.title)}</h3>
          <div class="item-meta">${escapeHtml(job.type)} · ${formatDate(job.createdAt)}</div>
        </div>
        <div class="row-actions">
          ${statusBadge(job.status)}
          ${retry}
        </div>
      </div>
      <div class="progress" aria-label="任务进度"><span style="width:${percent}%"></span></div>
      <div class="item-meta">${completed}/${total} 完成，${job.progress.failed || 0} 失败</div>
      <div class="job-results">
        ${(job.results || []).slice(-30).reverse().map(renderJobResult).join("")}
      </div>
    </article>
  `;
}

function renderJobResult(result) {
  const target = [result.username, result.repo].filter(Boolean).join(" / ") || "operation";
  return `
    <div class="job-result">
      ${statusBadge(result.status)}
      <span><strong>${escapeHtml(target)}</strong> ${escapeHtml(result.message || "")}</span>
    </div>
  `;
}

function renderAuditLog() {
  const logs = state.data.auditLog;
  if (!logs.length) {
    els.auditLog.innerHTML = `<div class="empty">没有审计日志</div>`;
    return;
  }

  els.auditLog.innerHTML = logs.map((entry) => `
    <article class="timeline-item">
      <time>${formatDate(entry.createdAt)}</time>
      <div>
        <strong>${escapeHtml(entry.action)} · ${escapeHtml(entry.actor)}</strong>
        <code>${escapeHtml(entry.targetType || "-")} / ${escapeHtml(entry.target || "-")}</code>
      </div>
    </article>
  `).join("");
}

function renderSettings() {
  const settings = state.data.settings || {};
  els.settingsForm.defaultPermission.value = settings.defaultPermission || "push";
  els.settingsForm.autoInviteOnApproval.checked = Boolean(settings.autoInviteOnApproval);
  els.settingsForm.includeArchivedRepositories.checked = Boolean(settings.includeArchivedRepositories);
  els.settingsForm.requireApproval.checked = Boolean(settings.requireApproval);
}

function updateExportLinks() {
  const suffix = state.adminToken ? `?token_hint=${encodeURIComponent("use-auth-header")}` : "";
  els.exportMembersLink.href = `/api/export/members.csv${suffix}`;
  els.exportStateLink.href = `/api/export/state${suffix}`;
}

async function approveMember(username) {
  const member = state.data.members.find((item) => item.githubUsername === username);
  const repositories = member?.requestedRepositories?.length
    ? member.requestedRepositories
    : managedRepositories().map((repo) => repo.name);
  await api(`/api/members/${encodeURIComponent(username)}/approve`, {
    method: "POST",
    body: {
      permission: member?.requestedPermission || state.data.settings.defaultPermission || "push",
      repositories,
      invite: true
    }
  });
  showAlert(`已批准 ${username}，邀请任务已创建`, "success");
  await loadState();
}

async function logout() {
  await api("/api/logout", { method: "POST", body: {}, admin: false });
  state.currentUser = null;
  showAlert("已退出", "success");
  await loadMe();
  await loadState();
}

async function rejectMember(username) {
  await api(`/api/members/${encodeURIComponent(username)}/reject`, {
    method: "POST",
    body: { reason: "Rejected in admin console" }
  });
  showAlert(`已拒绝 ${username}`, "success");
  await loadState();
}

async function inviteMember(username) {
  const member = state.data.members.find((item) => item.githubUsername === username);
  const repositories = managedRepositories().map((repo) => repo.name);
  if (!repositories.length) return showAlert("没有纳入管理的仓库", "error");

  await api("/api/bulk/invite", {
    method: "POST",
    body: {
      usernames: [username],
      repositories,
      permission: member?.requestedPermission || state.data.settings.defaultPermission || "push"
    }
  });
  showAlert(`已创建 ${username} 的邀请任务`, "success");
  await loadState();
  switchView("jobs");
}

async function updateMember(username, payload) {
  await api(`/api/members/${encodeURIComponent(username)}`, {
    method: "PATCH",
    body: payload
  });
  showAlert("成员状态已更新", "success");
  await loadState();
}

async function revokeMember(username) {
  const repositories = managedRepositories().map((repo) => repo.name);
  if (!repositories.length) return showAlert("没有纳入管理的仓库", "error");
  const confirmed = window.confirm(`撤销 ${username} 在全部管理仓库里的协作者权限？`);
  if (!confirmed) return;

  await api("/api/bulk/remove", {
    method: "POST",
    body: {
      usernames: [username],
      repositories
    }
  });
  showAlert(`已创建 ${username} 的撤销任务`, "success");
  await loadState();
  switchView("jobs");
}

async function offboardMember(username) {
  const repositories = managedRepositories().map((repo) => repo.name);
  const teamSlugs = (state.data.teams || []).filter((team) => team.managed).map((team) => team.slug);
  const confirmed = window.confirm(`回收 ${username} 的全部管理仓库和管理团队权限，并禁用成员？`);
  if (!confirmed) return;

  await api(`/api/members/${encodeURIComponent(username)}/offboard`, {
    method: "POST",
    body: {
      repositories,
      teamSlugs
    }
  });
  showAlert(`已创建 ${username} 的权限回收任务`, "success");
  await loadState();
  switchView("jobs");
}

async function deleteMember(username) {
  const confirmed = window.confirm(`删除成员 ${username}？这不会自动撤销 GitHub 协作者权限。`);
  if (!confirmed) return;
  await api(`/api/members/${encodeURIComponent(username)}`, { method: "DELETE" });
  showAlert("成员已删除", "success");
  await loadState();
}

async function toggleRepository(repo, managed) {
  await api(`/api/repositories/${encodeURIComponent(repo)}`, {
    method: "PATCH",
    body: { managed }
  });
  showAlert(managed ? "仓库已纳入管理" : "仓库已设为跳过", "success");
  await loadState();
}

async function toggleTeam(teamSlug, managed) {
  await api(`/api/teams/${encodeURIComponent(teamSlug)}`, {
    method: "PATCH",
    body: { managed }
  });
  showAlert(managed ? "团队已纳入管理" : "团队已设为跳过", "success");
  await loadState();
}

function useTeam(teamSlug) {
  switchView("bulk");
  els.teamMemberForm.elements.teamSlug.value = teamSlug;
  els.teamRepoForm.elements.teamSlug.value = teamSlug;
  showAlert(`已填入 Team slug: ${teamSlug}`, "success");
}

function managedRepositories() {
  return state.data.repositories.filter((repo) => repo.managed && !repo.disabled && !repo.archived);
}

function selectedApplyRepositories() {
  return [...els.applyRepoList.querySelectorAll("input[name='repositories']:checked")]
    .map((input) => input.value);
}

function normalizeBulkPayload(payload) {
  return {
    usernames: splitLines(payload.usernames),
    repositories: splitLines(payload.repositories),
    permission: payload.permission,
    dryRun: Boolean(payload.dryRun)
  };
}

function splitLines(value) {
  return String(value || "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseMemberImport(value, permission) {
  return String(value || "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [githubUsername, displayName = "", email = "", tags = ""] = line.split(",").map((item) => item.trim());
      return {
        githubUsername,
        displayName,
        email,
        tags,
        requestedPermission: permission,
        status: "approved"
      };
    })
    .filter((member) => member.githubUsername);
}

async function downloadWithAuth(event) {
  if (!state.config?.adminAuthEnabled) return;

  event.preventDefault();
  try {
    const response = await fetch(event.currentTarget.getAttribute("href"), {
      headers: state.adminToken ? { Authorization: `Bearer ${state.adminToken}` } : {}
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "下载失败");
    }

    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match?.[1] || "download";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    showAlert(error.message, "error");
  }
}

function formData(form) {
  const data = {};
  const fd = new FormData(form);
  for (const [key, value] of fd.entries()) {
    data[key] = value;
  }

  form.querySelectorAll("input[type='checkbox']").forEach((checkbox) => {
    data[checkbox.name] = checkbox.checked;
  });

  return data;
}

function statusBadge(status) {
  return `<span class="badge ${escapeAttr(status)}">${escapeHtml(status || "-")}</span>`;
}

function permissionBadge(permission) {
  return `<span class="badge">${escapeHtml(permission || "-")}</span>`;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function showAlert(message, type = "info") {
  const alert = document.createElement("div");
  alert.className = `alert ${type}`;
  alert.textContent = message;
  els.alertHost.append(alert);
  window.setTimeout(() => alert.remove(), 4500);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
