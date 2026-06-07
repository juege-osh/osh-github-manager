import crypto from "node:crypto";
import { config } from "./config.js";
import { addAudit, getState, mutateState } from "./store.js";
import { id, normalizeLogin, nowIso } from "./utils.js";

const cookieName = "osh_session";
const maxAgeMs = 1000 * 60 * 60 * 24 * 30;

export function authMiddleware(req, _res, next) {
  const token = readCookie(req.headers.cookie || "", cookieName);
  req.currentUser = null;

  if (token) {
    const session = getState().sessions.find((item) => item.token === token && new Date(item.expiresAt).getTime() > Date.now());
    if (session) {
      req.currentUser = getState().users.find((user) => user.id === session.userId) || null;
    }
  }

  next();
}

export function requireLogin(req, res, next) {
  if (req.currentUser) return next();
  res.status(401).json({ error: "Login required" });
}

export function requireAdminUser(req, res, next) {
  if (req.currentUser?.role === "admin") return next();
  res.status(403).json({ error: "Admin access required" });
}

export async function createOrUpdateOAuthUser(profile) {
  const login = normalizeLogin(profile.login);
  const role = config.adminGithubLogins.includes(login) ? "admin" : "user";
  let user;

  await mutateState((state) => {
    user = state.users.find((item) => item.githubLogin === login);
    if (user) {
      user.name = profile.name || user.name || "";
      user.avatarUrl = profile.avatar_url || user.avatarUrl || "";
      user.htmlUrl = profile.html_url || user.htmlUrl || "";
      user.email = profile.email || user.email || "";
      user.role = role;
      user.lastLoginAt = nowIso();
      user.updatedAt = nowIso();
    } else {
      user = {
        id: id("user"),
        githubId: profile.id,
        githubLogin: login,
        name: profile.name || "",
        email: profile.email || "",
        avatarUrl: profile.avatar_url || "",
        htmlUrl: profile.html_url || "",
        role,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        lastLoginAt: nowIso()
      };
      state.users.unshift(user);
    }

    addAudit({
      actor: login,
      action: "auth.login",
      targetType: "user",
      target: login,
      details: { role }
    });
  });

  return user;
}

export async function createSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  const session = {
    id: id("session"),
    userId: user.id,
    token,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + maxAgeMs).toISOString()
  };

  await mutateState((state) => {
    state.sessions = state.sessions.filter((item) => new Date(item.expiresAt).getTime() > Date.now());
    state.sessions.unshift(session);
  });

  return session;
}

export async function destroySession(req) {
  const token = readCookie(req.headers.cookie || "", cookieName);
  if (!token) return;
  await mutateState((state) => {
    state.sessions = state.sessions.filter((item) => item.token !== token);
  });
}

export function setSessionCookie(res, session) {
  res.setHeader("Set-Cookie", serializeCookie(cookieName, session.token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: config.appBaseUrl.startsWith("https://"),
    path: "/",
    maxAge: Math.floor(maxAgeMs / 1000)
  }));
}

export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", serializeCookie(cookieName, "", {
    httpOnly: true,
    sameSite: "Lax",
    secure: config.appBaseUrl.startsWith("https://"),
    path: "/",
    maxAge: 0
  }));
}

export function publicUser(user) {
  if (!user) return null;
  return {
    githubLogin: user.githubLogin,
    name: user.name,
    avatarUrl: user.avatarUrl,
    htmlUrl: user.htmlUrl,
    role: user.role
  };
}

function readCookie(header, name) {
  return header
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1) || "";
}

function serializeCookie(name, value, options) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join("; ");
}
