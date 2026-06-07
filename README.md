# OSH GitHub Manager

一套用于批量管理 GitHub 开源项目协作者权限的本地/服务器工具。它支持 GitHub OAuth 登录、按登录账号区分管理员/普通用户、成员提交多个仓库权限申请、管理员审批后自动邀请、批量发邀请、批量撤销协作者、团队授权、离职回收、仓库同步、审计扫描、失败任务重试和操作日志。

## 快速开始

```bash
npm install
cp .env.example .env
npm run dev
```

打开 `http://localhost:4173`。

Docker Compose 部署文件在 `deploy/docker-compose/`。

`.env` 里至少需要配置：

- `GITHUB_TOKEN`: GitHub token
- `GITHUB_OWNER`: 仓库所属用户或组织
- `ADMIN_GITHUB_LOGINS`: 管理员 GitHub 登录名，例如 `juege-osh`
- `APP_BASE_URL`: 站点访问地址
- `SESSION_SECRET`: 登录会话随机密钥
- `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`: GitHub OAuth App

生产 OAuth 回调地址格式：

```text
${APP_BASE_URL}/auth/github/callback
```

如果部署在 `43.242.200.25:4173`，GitHub OAuth App callback URL 填：

```text
http://43.242.200.25:4173/auth/github/callback
```

`ADMIN_TOKEN` 仅建议用于脚本自动化。正常管理权限由 GitHub OAuth 登录账号判断。

## 主要功能

- 成员提交 GitHub 账号申请
- GitHub OAuth 登录，`juege-osh` 是管理员，其他账号是普通用户
- 普通用户可选择多个仓库申请权限
- 管理员审批成员并自动邀请到仓库
- 支持 `pull`、`triage`、`push`、`maintain`、`admin` 权限
- 按全部仓库或指定仓库批量邀请
- 手动撤销某人的项目协作者权限
- 一键回收成员在管理仓库和管理团队里的权限
- 同步 GitHub 仓库列表，支持归档仓库过滤
- 同步 GitHub Teams
- 批量添加/移除团队成员
- 批量给团队授权或撤销仓库权限，适合大规模仓库管理
- 危险批量操作支持 dry run 预演
- 扫描仓库协作者，发现非预期成员
- 任务队列、逐项结果、失败重试
- 操作审计日志
- 导出成员 CSV 和完整 JSON 状态

## 生产使用建议

这个版本使用 SQLite 存储状态，默认数据库为 `data/app.db`。管理一万项目时建议：

- 部署在内网或受保护的服务器后面
- 使用专门的 GitHub 机器人账号和最小权限 token
- 定期备份 SQLite 数据库
- 后续可将 `server/store.js` 替换为 PostgreSQL
- 将 `server/jobQueue.js` 替换为 Redis/BullMQ 等持久化队列
- 大规模项目优先使用 GitHub Teams 授权，减少逐仓库逐人的邀请数量

## GitHub Token 权限

不同账号和组织配置会影响 GitHub API 权限。通常需要：

- 同步仓库：读取目标 owner 的仓库权限
- 添加/删除协作者：目标仓库 Administration 写权限
- 组织仓库：机器人账号必须有对应组织和仓库的管理权限
- 管理 Teams：组织团队成员和团队仓库权限

GitHub 发送邀请后，被邀请人仍需要在 GitHub 接受邀请。

## API 依据

本工具使用 GitHub REST API 的仓库协作者和组织团队接口：

- `PUT /repos/{owner}/{repo}/collaborators/{username}` 添加协作者或更新权限
- `DELETE /repos/{owner}/{repo}/collaborators/{username}` 删除协作者
- `PUT /orgs/{org}/teams/{team_slug}/memberships/{username}` 添加或更新团队成员
- `PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}` 给团队授权仓库

默认 API 版本头是 `2026-03-10`，可通过 `GITHUB_API_VERSION` 调整。
