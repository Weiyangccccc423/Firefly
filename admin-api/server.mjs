import crypto from "node:crypto";
import http from "node:http";

const cfg = {
	port: Number(process.env.ADMIN_PORT || 4322),
	origin: (process.env.ADMIN_PUBLIC_ORIGIN || "https://wiyac5.xyz").replace(
		/\/$/,
		"",
	),
	clientId: process.env.ADMIN_GITHUB_CLIENT_ID || "",
	clientSecret: process.env.ADMIN_GITHUB_CLIENT_SECRET || "",
	allowedUser: process.env.ADMIN_GITHUB_USER || "Weiyangccccc423",
	repo: process.env.ADMIN_GITHUB_REPO || "Weiyangccccc423/Firefly",
	branch: process.env.ADMIN_GITHUB_BRANCH || "master",
	sessionSecret: process.env.ADMIN_SESSION_SECRET || "",
	umamiUrl: (
		process.env.ADMIN_UMAMI_API_URL || "https://api.umami.is/v1"
	).replace(/\/$/, ""),
	umamiWebsiteId: process.env.ADMIN_UMAMI_WEBSITE_ID || "",
	umamiToken: process.env.ADMIN_UMAMI_API_TOKEN || "",
};

const SESSION_COOKIE = "firefly_admin_session";
const STATE_COOKIE = "firefly_admin_oauth_state";
const CONFIG_PATH = "src/config/adminOverrides.json";
const POSTS_PREFIX = "src/content/posts/";
const PAGE_KEYS = [
	"friends",
	"sponsor",
	"guestbook",
	"bangumi",
	"gallery",
	"anime",
	"dynamic",
];
const DEFAULT_CONFIG = {
	music: { enabled: true },
	pages: {
		friends: false,
		sponsor: false,
		guestbook: true,
		bangumi: false,
		gallery: true,
		anime: true,
		dynamic: true,
	},
	sidebar: { enabled: true },
};
const limits = new Map();

class HttpError extends Error {
	constructor(status, message, details) {
		super(message);
		this.status = status;
		this.details = details;
	}
}

const b64 = (value) => Buffer.from(value).toString("base64url");
const unb64 = (value) => Buffer.from(value, "base64url");
const callbackUrl = () => `${cfg.origin}/admin-api/auth/callback`;

function key() {
	return cfg.sessionSecret
		? crypto.createHash("sha256").update(cfg.sessionSecret).digest()
		: null;
}

function encrypt(value) {
	const secret = key();
	if (!secret) return null;
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", secret, iv);
	const data = Buffer.concat([
		cipher.update(JSON.stringify(value), "utf8"),
		cipher.final(),
	]);
	return `${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(data)}`;
}

function decrypt(value) {
	try {
		const secret = key();
		const [iv, tag, data] = value.split(".");
		if (!secret || !iv || !tag || !data) return null;
		const decipher = crypto.createDecipheriv("aes-256-gcm", secret, unb64(iv));
		decipher.setAuthTag(unb64(tag));
		const result = Buffer.concat([
			decipher.update(unb64(data)),
			decipher.final(),
		]);
		const session = JSON.parse(result.toString("utf8"));
		return session.exp > Date.now() &&
			session.login === cfg.allowedUser &&
			session.token
			? session
			: null;
	} catch {
		return null;
	}
}

function parseCookies(request) {
	const cookies = {};
	for (const part of (request.headers.cookie || "").split(";")) {
		const index = part.indexOf("=");
		if (index >= 0)
			cookies[part.slice(0, index).trim()] = decodeURIComponent(
				part.slice(index + 1).trim(),
			);
	}
	return cookies;
}

function setCookie(name, value, maxAge) {
	return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function send(response, status, body, headers = {}) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		...headers,
	});
	response.end(JSON.stringify(body));
}

function redirect(response, location, headers = {}) {
	response.writeHead(302, { location, ...headers });
	response.end();
}

async function body(request, maxBytes = 1_600_000) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > maxBytes) throw new HttpError(413, "Request body is too large");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function session(request) {
	const value = parseCookies(request)[SESSION_COOKIE];
	return value ? decrypt(value) : null;
}

function requireSession(request, response) {
	const value = session(request);
	if (!value) {
		send(response, 401, { error: "unauthorized" });
		return null;
	}
	return value;
}

function repoPath(value) {
	if (
		typeof value !== "string" ||
		!value.startsWith(POSTS_PREFIX) ||
		value.includes("..") ||
		value.includes("\\") ||
		value.includes("\0") ||
		!/\.(md|mdx)$/i.test(value)
	) {
		throw new HttpError(400, "Only safe Markdown paths are allowed");
	}
	return value;
}

const encodePath = (value) =>
	value.split("/").map(encodeURIComponent).join("/");

async function fetchWithRetry(url, options = {}, attempts = 3) {
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			return await fetch(url, {
				...options,
				signal: AbortSignal.timeout(20_000),
			});
		} catch (error) {
			lastError = error;
			if (attempt < attempts) {
				await new Promise((resolve) => setTimeout(resolve, attempt * 300));
			}
		}
	}
	throw lastError;
}

async function github(path, token, options = {}) {
	const response = await fetchWithRetry(`https://api.github.com${path}`, {
		...options,
		headers: {
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...(options.headers || {}),
		},
	});
	const text = await response.text();
	let data = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = { message: text.slice(0, 200) };
	}
	if (!response.ok)
		throw new HttpError(
			response.status,
			data?.message || "GitHub API request failed",
			data,
		);
	return data;
}

async function readFile(path, token) {
	try {
		const result = await github(
			`/repos/${cfg.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(cfg.branch)}`,
			token,
		);
		return {
			path,
			sha: result.sha,
			content: Buffer.from(
				result.content.replace(/\n/g, ""),
				"base64",
			).toString("utf8"),
		};
	} catch (error) {
		if (error instanceof HttpError && error.status === 404) return null;
		throw error;
	}
}

async function writeFile(path, content, sha, message, token) {
	return github(`/repos/${cfg.repo}/contents/${encodePath(path)}`, token, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			message,
			content: Buffer.from(content).toString("base64"),
			branch: cfg.branch,
			...(sha ? { sha } : {}),
		}),
	});
}

async function deleteFile(path, sha, message, token) {
	return github(`/repos/${cfg.repo}/contents/${encodePath(path)}`, token, {
		method: "DELETE",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message, sha, branch: cfg.branch }),
	});
}

function sanitizeConfig(value, current = DEFAULT_CONFIG) {
	if (!value || typeof value !== "object")
		throw new HttpError(400, "Invalid config payload");
	const next = {
		music: { enabled: value.music?.enabled ?? current.music.enabled },
		pages: { ...current.pages },
		sidebar: { enabled: value.sidebar?.enabled ?? current.sidebar.enabled },
	};
	if (
		typeof next.music.enabled !== "boolean" ||
		typeof next.sidebar.enabled !== "boolean"
	)
		throw new HttpError(400, "Feature toggles must be booleans");
	for (const name of PAGE_KEYS) {
		if (value.pages && Object.hasOwn(value.pages, name)) {
			if (typeof value.pages[name] !== "boolean")
				throw new HttpError(400, `Page toggle ${name} must be a boolean`);
			next.pages[name] = value.pages[name];
		}
	}
	return next;
}

async function listPosts(token) {
	const result = await github(
		`/repos/${cfg.repo}/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`,
		token,
	);
	return (result.tree || [])
		.filter(
			(item) =>
				item.type === "blob" &&
				item.path.startsWith(POSTS_PREFIX) &&
				/\.(md|mdx)$/i.test(item.path),
		)
		.map((item) => ({
			path: item.path,
			sha: item.sha,
			size: item.size || 0,
			title: item.path
				.split("/")
				.pop()
				.replace(/\.(md|mdx)$/i, ""),
		}))
		.sort((a, b) => a.path.localeCompare(b.path));
}

async function getConfig(token) {
	const file = await readFile(CONFIG_PATH, token);
	if (!file) return { ...DEFAULT_CONFIG, _sha: null };
	try {
		return { ...sanitizeConfig(JSON.parse(file.content)), _sha: file.sha };
	} catch {
		throw new HttpError(500, "Stored admin config is invalid JSON");
	}
}

async function analytics(url) {
	if (!cfg.umamiWebsiteId || !cfg.umamiToken)
		return {
			configured: false,
			message: "Umami is not configured on the admin API",
		};
	const endAt = Number(url.searchParams.get("endAt")) || Date.now();
	const startAt =
		Number(url.searchParams.get("startAt")) || endAt - 7 * 24 * 60 * 60 * 1000;
	const result = await fetchWithRetry(
		`${cfg.umamiUrl}/websites/${encodeURIComponent(cfg.umamiWebsiteId)}/stats?startAt=${startAt}&endAt=${endAt}`,
		{
			headers: {
				accept: "application/json",
				authorization: `Bearer ${cfg.umamiToken}`,
				"x-umami-api-key": cfg.umamiToken,
			},
		},
	);
	const data = await result.json().catch(() => ({}));
	if (!result.ok)
		throw new HttpError(result.status, data.message || "Umami request failed");
	return {
		configured: true,
		startAt,
		endAt,
		pageviews: data.pageviews ?? data.pageViews ?? 0,
		visitors: data.visitors ?? 0,
		visits: data.visits ?? 0,
		bounces: data.bounces ?? 0,
	};
}

function rateLimit(request) {
	const ip =
		request.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
		request.socket.remoteAddress ||
		"unknown";
	const now = Date.now();
	const record = limits.get(ip) || { start: now, count: 0 };
	if (now - record.start > 60_000) {
		record.start = now;
		record.count = 0;
	}
	record.count += 1;
	limits.set(ip, record);
	return record.count <= 120;
}

async function route(request, response) {
	if (!rateLimit(request)) throw new HttpError(429, "Too many requests");
	const url = new URL(request.url, cfg.origin);
	const method = request.method || "GET";

	if (method === "GET" && url.pathname === "/auth/github") {
		if (!cfg.clientId || !cfg.clientSecret || !cfg.sessionSecret)
			return send(response, 503, { error: "Admin OAuth is not configured" });
		const state = b64(crypto.randomBytes(24));
		return redirect(
			response,
			`https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(cfg.clientId)}&redirect_uri=${encodeURIComponent(callbackUrl())}&scope=${encodeURIComponent("repo")}&state=${encodeURIComponent(state)}`,
			{ "set-cookie": setCookie(STATE_COOKIE, state, 600) },
		);
	}

	if (method === "GET" && url.pathname === "/auth/callback") {
		const state = url.searchParams.get("state");
		if (!state || state !== parseCookies(request)[STATE_COOKIE])
			throw new HttpError(400, "Invalid OAuth state");
		const code = url.searchParams.get("code");
		if (!code) throw new HttpError(400, "Missing OAuth code");
		const tokenResponse = await fetchWithRetry(
			"https://github.com/login/oauth/access_token",
			{
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					client_id: cfg.clientId,
					client_secret: cfg.clientSecret,
					code,
					redirect_uri: callbackUrl(),
				}),
			},
		);
		const token = await tokenResponse.json();
		if (!tokenResponse.ok || !token.access_token)
			throw new HttpError(502, "GitHub OAuth exchange failed");
		const user = await github("/user", token.access_token);
		if (user.login !== cfg.allowedUser)
			throw new HttpError(403, "This GitHub account is not allowed");
		const value = encrypt({
			login: user.login,
			token: token.access_token,
			exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
		});
		if (!value)
			throw new HttpError(503, "Admin session secret is not configured");
		return redirect(response, "/admin/", {
			"set-cookie": [
				setCookie(SESSION_COOKIE, value, 604800),
				setCookie(STATE_COOKIE, "", 0),
			],
		});
	}

	if (method === "POST" && url.pathname === "/auth/logout")
		return send(
			response,
			200,
			{ ok: true },
			{ "set-cookie": setCookie(SESSION_COOKIE, "", 0) },
		);
	if (method === "GET" && url.pathname === "/auth/session") {
		const value = session(request);
		return send(response, 200, {
			authenticated: Boolean(value),
			login: value?.login || null,
		});
	}

	const value = requireSession(request, response);
	if (!value) return;

	if (method === "GET" && url.pathname === "/api/posts")
		return send(response, 200, { posts: await listPosts(value.token) });
	if (method === "GET" && url.pathname === "/api/post") {
		const path = repoPath(url.searchParams.get("path"));
		const file = await readFile(path, value.token);
		if (!file) throw new HttpError(404, "Post not found");
		return send(response, 200, file);
	}
	if (method === "PUT" && url.pathname === "/api/post") {
		const payload = JSON.parse(await body(request));
		const path = repoPath(payload.path);
		if (
			typeof payload.content !== "string" ||
			payload.content.length > 1_500_000
		)
			throw new HttpError(400, "Markdown content is invalid or too large");
		const result = await writeFile(
			path,
			payload.content,
			payload.sha || undefined,
			payload.message || `docs: update ${path.split("/").pop()}`,
			value.token,
		);
		return send(response, 200, {
			ok: true,
			commit: result.commit?.html_url || null,
		});
	}
	if (method === "DELETE" && url.pathname === "/api/post") {
		const payload = JSON.parse(await body(request));
		const path = repoPath(payload.path);
		if (!payload.sha)
			throw new HttpError(400, "File SHA is required for deletion");
		const result = await deleteFile(
			path,
			payload.sha,
			payload.message || `docs: delete ${path.split("/").pop()}`,
			value.token,
		);
		return send(response, 200, {
			ok: true,
			commit: result.commit?.html_url || null,
		});
	}
	if (url.pathname === "/api/config") {
		if (method === "GET")
			return send(response, 200, await getConfig(value.token));
		if (method === "PUT") {
			const payload = JSON.parse(await body(request));
			const current = await getConfig(value.token);
			const next = sanitizeConfig(payload, current);
			const file = await readFile(CONFIG_PATH, value.token);
			const result = await writeFile(
				CONFIG_PATH,
				`${JSON.stringify(next, null, "\t")}\n`,
				file?.sha,
				payload.message || "chore: update site feature settings",
				value.token,
			);
			return send(response, 200, {
				...next,
				ok: true,
				commit: result.commit?.html_url || null,
			});
		}
	}
	if (method === "GET" && url.pathname === "/api/deploy/status") {
		const result = await github(
			`/repos/${cfg.repo}/actions/runs?per_page=8`,
			value.token,
		);
		return send(response, 200, {
			runs: (result.workflow_runs || []).map((run) => ({
				id: run.id,
				name: run.name,
				status: run.status,
				conclusion: run.conclusion,
				createdAt: run.created_at,
				url: run.html_url,
			})),
		});
	}
	if (method === "POST" && url.pathname === "/api/deploy") {
		await github(
			`/repos/${cfg.repo}/actions/workflows/deploy-oss.yml/dispatches`,
			value.token,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ref: cfg.branch }),
			},
		);
		return send(response, 202, { ok: true });
	}
	if (method === "GET" && url.pathname === "/api/analytics/summary")
		return send(response, 200, await analytics(url));
	throw new HttpError(404, "Not found");
}

http
	.createServer(async (request, response) => {
		try {
			await route(request, response);
		} catch (error) {
			const status = error instanceof HttpError ? error.status : 500;
			if (status >= 500) console.error(error);
			if (!response.headersSent)
				send(response, status, {
					error: error instanceof Error ? error.message : "Request failed",
					details: error instanceof HttpError ? error.details : undefined,
				});
			else response.end();
		}
	})
	.listen(cfg.port, "127.0.0.1", () =>
		console.log(`Firefly admin API listening on 127.0.0.1:${cfg.port}`),
	);
