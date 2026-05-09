import https from "https";
import fs from "fs";
import path from "path";
import { timingSafeEqual } from "node:crypto";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

import { log } from "./config/logger.js";
import { corsConfig } from "./config/cors.js";
import { ratelimit } from "./config/ratelimit.js";
import { execGracefulShutdown } from "./utils.js";
import { DeploymentEnv, env, SERVERLESS_ENVIRONMENTS } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./config/errorHandler.js";
import type { ServerContext } from "./config/context.js";

import { hianimeRouter } from "./routes/hianime.js";
import { streamRouter } from "./routes/stream.js";
import { proxyRouter } from "./routes/proxy.js";
import { mediaRouter } from "./routes/media.js";
import { animeRoutes } from "./providers/route.js";
import { mangaRoutes } from "./providers/manga/route.js";
import { logging } from "./middleware/logging.js";
import { cacheConfigSetter, cacheControl } from "./middleware/cache.js";
import { dailyResponseCache } from "./middleware/dailyResponseCache.js";
import { providerJsonSnapshot } from "./middleware/providerJsonSnapshot.js";
import { startCanonicalBackgroundJobs } from "./services/canonicalJobs.js";

import pkgJson from "../package.json" with { type: "json" };

//
const BASE_PATH = "/api/v2" as const;
const DOC_SECTIONS = ["intro", "endpoints"] as const;
type DocSection = (typeof DOC_SECTIONS)[number];

const ADMIN_SECRET_HEADER = "x-admin-secret";

const isPublicPath = (pathname: string) => {
    const normalized = pathname.toLowerCase();

    if (normalized === "/" || normalized === "/index.html") return true;
    if (normalized === "/docs" || normalized.startsWith("/docs/")) return true;
    if (normalized.startsWith("/docs-content/")) return true;
    if (normalized.startsWith(`${BASE_PATH}/docs`)) return true;

    // Manga provider image routes must stay public because image tags cannot send custom headers.
    if (/^\/api\/v\d+\/manga\/(?:adult\/)?[^/]+\/image\/.+/.test(normalized)) return true;
    if (/^\/manga\/(?:adult\/)?[^/]+\/image\/.+/.test(normalized)) return true;

    return false;
};

const isAuthorizedWithAdminSecret = (provided: string, configured: string) => {
    const providedBuffer = Buffer.from(provided);
    const configuredBuffer = Buffer.from(configured);
    if (providedBuffer.length !== configuredBuffer.length) return false;

    try {
        return timingSafeEqual(providedBuffer, configuredBuffer);
    } catch {
        return false;
    }
};

const readDocSection = (section: DocSection) => {
    const docsDir = path.join(process.cwd(), "src", "docs");
    return fs.readFileSync(path.join(docsDir, `${section}.md`), "utf-8");
};

const buildEndpointsMarkdown = () => {
    const filePath = path.join(process.cwd(), "endpoints.json");
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as {
        generatedAt?: string;
        service?: string;
        compatibility?: Array<{ method?: string; path?: string; description?: string }>;
        proxy?: Array<{ method?: string; path?: string; description?: string }>;
        v2?: {
            hianime?: Array<{ method?: string; path?: string }>;
            other?: Array<{ method?: string; path?: string }>;
        };
        providers?: {
            catalog?: Array<{ method?: string; path?: string }>;
        };
    };

    const lines: string[] = [];
    lines.push("# TatakaiCore Endpoint Catalog");
    lines.push("");
    lines.push(`Generated: ${data.generatedAt || "unknown"}`);
    lines.push("");
    lines.push("## Compatibility");
    lines.push("");
    for (const endpoint of data.compatibility || []) {
        lines.push(`- ${endpoint.method || "GET"} ${endpoint.path || ""}${endpoint.description ? ` - ${endpoint.description}` : ""}`);
    }
    lines.push("");
    lines.push("## Proxy");
    lines.push("");
    for (const endpoint of data.proxy || []) {
        lines.push(`- ${endpoint.method || "GET"} ${endpoint.path || ""}${endpoint.description ? ` - ${endpoint.description}` : ""}`);
    }
    lines.push("");
    lines.push("## V2 HiAnime");
    lines.push("");
    for (const endpoint of data.v2?.hianime || []) {
        lines.push(`- ${endpoint.method || "GET"} ${endpoint.path || ""}`);
    }
    lines.push("");
    lines.push("## V2 Other");
    lines.push("");
    for (const endpoint of data.v2?.other || []) {
        lines.push(`- ${endpoint.method || "GET"} ${endpoint.path || ""}`);
    }
    lines.push("");
    lines.push("## Providers (/api/v2/anime)");
    lines.push("");
    for (const endpoint of data.providers?.catalog || []) {
        lines.push(`- ${endpoint.method || "GET"} ${endpoint.path || ""}`);
    }
    lines.push("");
    lines.push("Machine-readable source: /api/v2/docs/endpoints-json");

    return lines.join("\n");
};

const app = new Hono<ServerContext>();

app.use(logging);
app.use(corsConfig);
app.use(cacheControl);
app.use("*", async (c, next) => {
    const pathname = new URL(c.req.url).pathname;

    if (isPublicPath(pathname)) {
        await next();
        return;
    }

    const configuredSecret = String(env.TATAKAI_ADMIN_API_SECRET || "").trim();
    if (!configuredSecret) {
        return c.json(
            {
                success: false,
                message: "API locked: admin secret not configured",
            },
            503
        );
    }

    const providedSecret = String(c.req.header(ADMIN_SECRET_HEADER) || "").trim();
    if (!providedSecret || !isAuthorizedWithAdminSecret(providedSecret, configuredSecret)) {
        return c.json(
            {
                success: false,
                message: "Unauthorized: X-Admin-Secret required",
            },
            401
        );
    }

    await next();
});

/*
    CAUTION: 
    Having the "ANIWATCH_API_HOSTNAME" env will
    enable rate limitting for the deployment.
    WARNING:
    If you are using any serverless environment, you must set the
    "ANIWATCH_API_DEPLOYMENT_ENV" to that environment's name, 
    otherwise you may face issues.
*/
const isPersonalDeployment = Boolean(env.ANIWATCH_API_HOSTNAME);
if (isPersonalDeployment) {
    app.use(ratelimit);
}

// if (env.ANIWATCH_API_DEPLOYMENT_ENV === DeploymentEnv.NODEJS) {
app.use("/", serveStatic({ root: "public" }));
// }

app.get("/health", (c) => c.text("daijoubu", { status: 200 }));
app.get("/v", async (c) =>
    c.text(
        `aniwatch-api: v${"version" in pkgJson && pkgJson?.version ? pkgJson.version : "-1"}\n` +
            `aniwatch-package: local-vendored`
    )
);

app.get(`${BASE_PATH}/docs/llm`, async (c) => {
        try {
                const intro = readDocSection("intro");
                const endpoints = buildEndpointsMarkdown();
                const payload = [
                        "TatakaiCore API - FULL DOCUMENTATION",
                        "",
                        "=== BEGIN FILE: intro.md ===",
                        "",
                        intro,
                        "",
                        "=== END FILE: intro.md ===",
                        "",
                        "=== BEGIN FILE: endpoints.md ===",
                        "",
                        endpoints,
                        "",
                        "=== END FILE: endpoints.md ===",
                ].join("\n");
                return c.text(payload);
        } catch {
                return c.text("Failed to generate documentation", 500);
        }
});

app.get(`${BASE_PATH}/docs/endpoints-json`, (c) => {
        try {
                const filePath = path.join(process.cwd(), "endpoints.json");
                const raw = fs.readFileSync(filePath, "utf-8");
                return c.json(JSON.parse(raw));
        } catch {
                return c.json({ status: 500, message: "Failed to load endpoints.json" }, 500);
        }
});

app.get("/docs-content/:section", async (c) => {
        const section = c.req.param("section");
        if (![...DOC_SECTIONS, "llm"].includes(section as DocSection | "llm")) {
                return c.json({ error: "Invalid section" }, 404);
        }

        try {
                if (section === "llm") {
                        const llmContent = await (await fetch(new URL(`${BASE_PATH}/docs/llm`, c.req.url).toString())).text();
                        return c.json({ content: llmContent });
                }

                if (section === "endpoints") {
                        return c.json({ content: buildEndpointsMarkdown() });
                }

                return c.json({ content: readDocSection(section as DocSection) });
        } catch {
                return c.json({ error: "Documentation not found" }, 404);
        }
});

app.get("/docs/:section?", (c) => {
        const sectionParam = c.req.param("section") || "intro";
        return c.html(`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TatakaiCore | Developer Documentation</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/tokyo-night-dark.min.css">
    <script>
    tailwind.config={
        theme: {
            extend: {
                fontFamily: {
                    sans: ['Outfit', 'sans-serif'],
                    mono: ['JetBrains Mono', 'monospace'],
                },
            }
        }
    }
    </script>
    <style>
        :root {
            --brand-color: #0ea5e9;
            --bg-main: #050505;
            --bg-alt: #0a0a0a;
            --zinc-400: #a1a1aa;
            --zinc-800: #27272a;
            --zinc-900: #18181b;
            --scrollbar-track: #09090b;
            --scrollbar-thumb: #27272a;
            --scrollbar-thumb-hover: #3f3f46;
        }

        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: var(--scrollbar-track); }
        ::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: var(--scrollbar-thumb-hover); }

        body { background-color: var(--bg-main); color: #e4e4e7; font-family: 'Outfit', sans-serif; }
        .markdown-body h1 { font-size: 2.25rem; font-weight: 800; margin-bottom: 2rem; color: white; letter-spacing: -0.025em; }
        .markdown-body h2 { font-size: 1.5rem; font-weight: 700; margin-top: 4rem; margin-bottom: 1.5rem; color: white; border-bottom: 1px solid rgba(39, 39, 42, 0.5); padding-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem; scroll-margin-top: 100px; }
        .markdown-body h3 { font-size: 1.25rem; font-weight: 700; margin-top: 2.5rem; margin-bottom: 1rem; color: #f4f4f5; scroll-margin-top: 100px; }
        .markdown-body p { color: var(--zinc-400); margin-bottom: 1.5rem; line-height: 1.625; font-size: 0.95rem; }
        .markdown-body ul { list-style-type: disc; list-style-position: inside; margin-bottom: 1.5rem; color: var(--zinc-400); padding-left: 1rem; }
        .markdown-body li { margin-bottom: 0.5rem; }
        .markdown-body code:not(pre code) { background-color: var(--zinc-900); border: 1px solid var(--zinc-800); color: var(--brand-color); padding: 0.125rem 0.375rem; border-radius: 0.25rem; font-weight: 500; font-size: 0.85em; }
        .markdown-body pre { position: relative; background-color: var(--bg-alt); border: 1px solid rgba(39, 39, 42, 0.5); border-radius: 0.75rem; padding: 1.25rem; margin: 2rem 0; overflow-x: auto; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5); backdrop-filter: blur(4px); }
        .markdown-body pre code { background: transparent; padding: 0; border: none; font-size: 0.85em; line-height: 1.625; display: block; font-family: 'JetBrains Mono', monospace; }
        .markdown-body table { width: 100%; border-collapse: collapse; margin-bottom: 2.5rem; font-size: 0.875rem; border-radius: 0.5rem; overflow: hidden; }
        .markdown-body th { text-align: left; border-bottom: 1px solid var(--zinc-800); padding: 1rem; font-weight: 600; color: #e4e4e7; background-color: rgba(24, 24, 27, 0.5); }
        .markdown-body td { border-bottom: 1px solid var(--zinc-900); padding: 1rem; color: var(--zinc-400); }
        .markdown-body hr { border: 0; border-top: 1px solid var(--zinc-800); margin: 3rem 0; opacity: 0.3; }
        .sidebar-link.active { background: linear-gradient(90deg, rgba(14, 165, 233, 0.1) 0%, transparent 100%); border-left: 2px solid var(--brand-color); color: white; box-shadow: 0 0 20px rgba(14, 165, 233, 0.05); }
        .toc-link.active { color: var(--brand-color); border-left: 2px solid var(--brand-color); padding-left: 0.75rem; margin-left: -1px; }
        .copy-btn { position: absolute; top: 0.75rem; right: 0.75rem; background-color: rgba(24, 24, 27, 0.8); border: 1px solid var(--zinc-800); color: #71717a; font-size: 0.75rem; padding: 0.375rem 0.5rem; border-radius: 0.375rem; transition: all 0.2s; opacity: 0; backdrop-filter: blur(8px); cursor: pointer; }
        .group:hover .copy-btn { opacity: 1; }
        .copy-btn:hover { color: white; border-color: #3f3f46; }
    </style>
</head>
<body class="antialiased overflow-hidden flex h-screen font-sans selection:bg-brand-500/30 selection:text-brand-400">
    <div id="mobileOverlay" class="fixed inset-0 bg-black/80 backdrop-blur-sm z-[90] hidden transition-opacity duration-300"></div>
    <aside id="sidebar" class="fixed inset-y-0 left-0 w-72 border-r border-zinc-800 flex flex-col bg-[#050505] z-[100] lg:relative lg:translate-x-0 -translate-x-full transition-transform duration-300 lg:transition-none">
        <div class="p-6 border-b border-zinc-800 flex items-center justify-between">
            <a href="/" class="flex items-center gap-2 group whitespace-nowrap">
                <div class="w-8 h-8 bg-gradient-to-tr from-brand-400 to-purple-500 rounded-lg flex items-center justify-center text-black font-bold transform transition-transform group-hover:rotate-6">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                </div>
                <span class="font-bold text-lg tracking-tight">Tatakai<span class="text-zinc-600 font-normal ml-0.5 uppercase text-xs">Core</span></span>
            </a>
            <button onclick="toggleMobileNav()" class="lg:hidden p-2 text-zinc-500 hover:text-white">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
        </div>

        <div class="p-4 border-b border-zinc-800/10">
            <div class="relative group">
                <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600 group-focus-within:text-brand-400 transition-colors" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                <input type="text" id="searchInput" placeholder="Jump to..." class="w-full bg-zinc-900/50 border border-zinc-800 text-sm pl-9 pr-4 py-2 rounded-xl focus:outline-none focus:border-brand-500/50 focus:bg-zinc-900 transition-all placeholder:text-zinc-600">
            </div>
        </div>

        <nav class="flex-1 overflow-y-auto py-6 px-4 space-y-1" id="navLinks">
            <div class="text-[10px] uppercase tracking-[0.2em] text-zinc-600 font-bold px-3 mb-3 mt-1">Foundations</div>
            <button onclick="loadSection('intro')" class="sidebar-link w-full text-left px-3 py-2 rounded-lg text-sm font-medium text-zinc-400 border border-transparent hover:bg-zinc-900 hover:text-zinc-200 transition-all flex items-center gap-3">Introduction</button>
            <div class="text-[10px] uppercase tracking-[0.2em] text-zinc-600 font-bold px-3 mb-3 mt-8">Endpoints</div>
            <button onclick="loadSection('endpoints')" class="sidebar-link w-full text-left px-3 py-2 rounded-lg text-sm font-medium text-zinc-400 border border-transparent hover:bg-zinc-900 hover:text-zinc-200 transition-all flex items-center gap-3">All Endpoints</button>
            <div class="text-[10px] uppercase tracking-[0.2em] text-zinc-600 font-bold px-3 mb-3 mt-8">Resources</div>
            <button onclick="loadSection('llm')" class="sidebar-link w-full text-left px-3 py-2 rounded-lg text-sm font-medium text-zinc-400 border border-transparent hover:bg-zinc-900 hover:text-zinc-200 transition-all flex items-center gap-3">LLM Context</button>
        </nav>

        <div class="p-5 border-t border-zinc-900 bg-[#050505]">
            <a href="/" class="flex items-center justify-center gap-2 w-full py-2.5 bg-zinc-900 border border-zinc-800 rounded-xl text-xs font-bold text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-all">Home Page</a>
        </div>
    </aside>

    <div class="flex-1 flex flex-col min-w-0 bg-[#050505] overflow-hidden">
        <header class="lg:hidden h-14 border-b border-zinc-800 bg-black/50 backdrop-blur-xl flex items-center px-4 justify-between z-50">
            <button onclick="toggleMobileNav()" class="p-2 text-zinc-400">Menu</button>
            <span class="font-bold text-sm tracking-tight">Tatakai Docs</span>
            <div class="w-10"></div>
        </header>

        <main class="flex-1 flex overflow-hidden">
            <div class="flex-1 overflow-y-auto scroll-smooth relative" id="scrollContainer">
                <div class="sticky top-0 z-40 bg-[#050505]/80 backdrop-blur-md border-b border-white/5 px-8 h-12 flex items-center gap-2 text-xs text-zinc-500 overflow-hidden hidden lg:flex">
                    <span>Docs</span>
                    <span id="breadcrumbCurrent" class="text-zinc-200 font-medium">Introduction</span>
                </div>

                <div class="max-w-4xl mx-auto px-6 py-12 lg:px-12 lg:py-16 relative z-10 min-h-screen">
                    <article id="content" class="markdown-body transition-opacity duration-300">
                        <div class="flex items-center justify-center h-64"><div class="text-xs text-zinc-500 font-mono">synchronizing context...</div></div>
                    </article>
                    <div class="mt-20 pt-10 border-t border-zinc-900 flex justify-between gap-4 overflow-hidden">
                        <button id="prevBtn" class="flex flex-col items-start p-4 border border-zinc-900 rounded-xl hover:border-zinc-700 transition-colors w-1/2 group"><span class="text-[10px] text-zinc-600 uppercase font-bold mb-1">Previous</span><span class="text-sm font-semibold group-hover:text-brand-400"><span id="prevText">Introduction</span></span></button>
                        <button id="nextBtn" class="flex flex-col items-end p-4 border border-zinc-900 rounded-xl hover:border-zinc-700 transition-colors w-1/2 group"><span class="text-[10px] text-zinc-600 uppercase font-bold mb-1 text-right">Next</span><span class="text-sm font-semibold group-hover:text-brand-400"><span id="nextText">All Endpoints</span></span></button>
                    </div>
                </div>
            </div>

            <aside class="hidden xl:flex w-64 border-l border-zinc-800 flex-col p-8 sticky top-0 h-screen overflow-y-auto">
                <div class="text-xs font-bold text-zinc-100 uppercase tracking-widest mb-6 border-b border-zinc-900 pb-2">On this page</div>
                <nav id="toc" class="space-y-4"></nav>
            </aside>
        </main>
    </div>

    <div id="toast" class="fixed bottom-8 right-8 bg-zinc-900 border border-zinc-800 px-4 py-3 rounded-2xl text-xs text-white shadow-2xl translate-y-20 transition-transform opacity-0 pointer-events-none z-[200]">Copied to clipboard</div>

    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
    <script>
        const sections=['intro', 'endpoints', 'llm'];
        let currentSection='${sectionParam}';

        const searchInput=document.getElementById('searchInput');
        const navButtons=document.querySelectorAll('.sidebar-link');
        const contentDiv=document.getElementById('content');
        const sidebar=document.getElementById('sidebar');
        const mobileOverlay=document.getElementById('mobileOverlay');
        const scrollContainer=document.getElementById('scrollContainer');

        function toggleMobileNav() {
            sidebar.classList.toggle('-translate-x-full');
            mobileOverlay.classList.toggle('hidden');
        }

        mobileOverlay.onclick=toggleMobileNav;
        window.addEventListener('load', () => { loadSection(currentSection); });

        searchInput.addEventListener('input', (e) => {
            const term=e.target.value.toLowerCase();
            navButtons.forEach(btn => {
                const text=btn.innerText.toLowerCase();
                btn.style.display=text.includes(term) ? 'flex' : 'none';
            });
        });

        async function loadSection(section) {
            currentSection=section;
            if (window.innerWidth <1024) {
                try { sidebar.classList.add('-translate-x-full'); mobileOverlay.classList.add('hidden'); } catch (e) {}
            }

            navButtons.forEach(btn => btn.classList.remove('active'));
            const activeBtn=Array.from(navButtons).find(btn => btn.innerText.toLowerCase().includes(section));
            if (activeBtn) activeBtn.classList.add('active');

            const breadcrumb=document.getElementById('breadcrumbCurrent');
            if (breadcrumb) breadcrumb.innerText=activeBtn ? activeBtn.innerText.trim() : section;

            contentDiv.style.opacity='0';
            setTimeout(async () => {
                try {
                    const res = await fetch('/docs-content/' + section);
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    const data = await res.json();
                    if (!data.content) throw new Error('No content found');

                    contentDiv.innerHTML = marked.parse(data.content);
                    hljs.highlightAll();
                    wrapCodeBlocks();
                    generateTOC();
                    contentDiv.style.opacity = '1';
                    scrollContainer.scrollTop = 0;
                    updateNextPrev();
                    history.replaceState({}, '', '/docs/' + section);
                } catch (e) {
                    contentDiv.innerHTML = '<div class="text-red-400 text-sm">Error loading documentation</div>';
                    contentDiv.style.opacity = '1';
                }
            }, 120);
        }

        function wrapCodeBlocks() {
            document.querySelectorAll('pre code').forEach((block) => {
                const pre=block.parentElement;
                pre.classList.add('group');
                if (pre.querySelector('.copy-btn')) return;
                const button=document.createElement('button');
                button.className='copy-btn font-sans';
                button.textContent='Copy';
                button.addEventListener('click', () => {
                    navigator.clipboard.writeText(block.innerText).then(() => showToast());
                });
                pre.appendChild(button);
            });
        }

        function showToast() {
            const toast=document.getElementById('toast');
            if(!toast) return;
            toast.classList.remove('translate-y-20', 'opacity-0');
            setTimeout(() => toast.classList.add('translate-y-20', 'opacity-0'), 1500);
        }

        function generateTOC() {
            const toc=document.getElementById('toc');
            if(!toc) return;
            toc.innerHTML='';
            const headers=contentDiv.querySelectorAll('h2, h3');
            headers.forEach((header, index) => {
                const id='heading-' + index;
                header.id=id;
                const link=document.createElement('a');
                link.href='#' + id;
                link.innerText=header.innerText;
                link.className='toc-link block text-xs text-zinc-400 hover:text-white transition-all';
                toc.appendChild(link);
            });
        }

        function updateNextPrev() {
            const index=sections.indexOf(currentSection);
            const prev=sections[index - 1];
            const next=sections[index + 1];
            const prevBtn=document.getElementById('prevBtn');
            const nextBtn=document.getElementById('nextBtn');
            if(!prevBtn || !nextBtn) return;

            if(prev) {
                prevBtn.style.display='flex';
                const text=document.getElementById('prevText');
                if(text) text.innerText=prev;
                prevBtn.onclick=() => loadSection(prev);
            } else {
                prevBtn.style.display='none';
            }

            if(next) {
                nextBtn.style.display='flex';
                const text=document.getElementById('nextText');
                if(text) text.innerText=next;
                nextBtn.onclick=() => loadSection(next);
            } else {
                nextBtn.style.display='none';
            }
        }
    </script>
</body>
</html>`);
});

// hianime-api compatibility endpoints
app.route("/api", streamRouter);
app.route("/api/proxy", proxyRouter);
app.route("/api/v2/hianime/proxy", proxyRouter);
app.route("/api/v2/anime/hianime/proxy", proxyRouter);

app.use(cacheConfigSetter(BASE_PATH.length));
app.use(`${BASE_PATH}/hianime`, providerJsonSnapshot("hianime"));
app.use(`${BASE_PATH}/hianime/*`, providerJsonSnapshot("hianime"));
app.use(`${BASE_PATH}/anime`, providerJsonSnapshot("anime"));
app.use(`${BASE_PATH}/anime/*`, providerJsonSnapshot("anime"));
app.use(`${BASE_PATH}/manga`, providerJsonSnapshot("manga"));
app.use(`${BASE_PATH}/manga/*`, providerJsonSnapshot("manga"));
app.use(`${BASE_PATH}/anime`, dailyResponseCache("anime"));
app.use(`${BASE_PATH}/anime/*`, dailyResponseCache("anime"));
app.use(`${BASE_PATH}/manga`, dailyResponseCache("manga"));
app.use(`${BASE_PATH}/manga/*`, dailyResponseCache("manga"));

app.basePath(BASE_PATH).route("/hianime", hianimeRouter);
app.basePath(BASE_PATH).route("/anime", animeRoutes);
app.basePath(BASE_PATH).route("/manga", mangaRoutes);
app.basePath(BASE_PATH).route("/media", mediaRouter);
app.basePath(BASE_PATH).get("/anicrush", (c) =>
    c.text("Anicrush could be implemented in future.")
);

app.notFound(notFoundHandler);
app.onError(errorHandler);

//
(function () {
    /*
        NOTE:
        "ANIWATCH_API_DEPLOYMENT_MODE" env must be set to
        its supported name for serverless deployments
        Eg: "vercel" for vercel deployments
    */
    if (SERVERLESS_ENVIRONMENTS.includes(env.ANIWATCH_API_DEPLOYMENT_ENV)) {
        return;
    }

    const server = serve({
        port: env.ANIWATCH_API_PORT,
        fetch: app.fetch,
    }).addListener("listening", () => {
        const origin = `http://localhost:${env.ANIWATCH_API_PORT}`;
        log.info(`aniwatch-api RUNNING at ${origin}`);
        startCanonicalBackgroundJobs(origin);
    });

    process.on("SIGINT", () => execGracefulShutdown(server));
    process.on("SIGTERM", () => execGracefulShutdown(server));
    process.on("uncaughtException", (err) => {
        log.error(`Uncaught Exception: ${err.message}`);
        execGracefulShutdown(server);
    });
    process.on("unhandledRejection", (reason, promise) => {
        log.error(
            `Unhandled Rejection at: ${promise}, reason: ${reason instanceof Error ? reason.message : reason}`
        );
        execGracefulShutdown(server);
    });

    /*
        CAUTION:
        The `if` below block is for `render free deployments` only,
        as their free tier has an approx 10 or 15 minute sleep time.
        This is to keep the server awake and prevent it from sleeping.
        You can enable the automatic health check by setting the
        environment variables "ANIWATCH_API_HOSTNAME" to your deployment's hostname,
        and "ANIWATCH_API_DEPLOYMENT_ENV" to "render" in your environment variables.
        If you are not using render, you can remove the below `if` block.
    */
    if (
        isPersonalDeployment &&
        env.ANIWATCH_API_DEPLOYMENT_ENV === DeploymentEnv.RENDER
    ) {
        const INTERVAL_DELAY = 8 * 60 * 1000; // 8mins
        const url = new URL(`https://${env.ANIWATCH_API_HOSTNAME}/health`);

        // don't sleep
        setInterval(() => {
            https
                .get(url.href)
                .on("response", () => {
                    log.info(
                        `aniwatch-api HEALTH_CHECK at ${new Date().toISOString()}`
                    );
                })
                .on("error", (err) =>
                    log.warn(
                        `aniwatch-api HEALTH_CHECK failed; ${err.message.trim()}`
                    )
                );
        }, INTERVAL_DELAY);
    }
})();

export default app;
