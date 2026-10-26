importScripts("/offline-store.js");

const CACHE_NAME = "odyssey-shell-v11";
// The signed-in dashboard page; kept separately so sign-out can delete it (app.js clears it by name).
const PAGE_CACHE = "odyssey-pages";
const SHELL = ["/app.css", "/app.js", "/theme.js", "/offline-store.js", "/login.js", "/login.css", "/icon.svg", "/manifest.webmanifest"];
const SYNC_TAG = "odyssey-outbox";

self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((key) => key !== CACHE_NAME && key !== PAGE_CACHE).map((key) => caches.delete(key)))
        )
    );
    self.clients.claim();
});

async function dashboardPage(request) {
    try {
        const response = await fetch(request);
        // Only keep a real dashboard page, never the login page a signed-out redirect lands on.
        if (response.ok && !response.redirected && new URL(response.url).pathname === "/dashboard") {
            const cache = await caches.open(PAGE_CACHE);
            await cache.put("/dashboard", response.clone());
        }
        return response;
    } catch {
        const cached = await caches.match("/dashboard", { cacheName: PAGE_CACHE });
        return cached || Response.error();
    }
}

self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET") return;
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;
    if (event.request.mode === "navigate" && (url.pathname === "/dashboard" || url.pathname === "/")) {
        // Online, "/" redirects signed-in users to the dashboard; offline, fall back to the saved dashboard.
        event.respondWith(url.pathname === "/dashboard" ? dashboardPage(event.request) : fetch(event.request).catch(() => dashboardPage(event.request)));
        return;
    }
    if (SHELL.includes(url.pathname)) {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
    }
});

async function syncOutbox() {
    const report = await self.odysseyStore.flush();
    const clients = await self.clients.matchAll({ type: "window" });
    clients.forEach((client) => client.postMessage({ type: "outbox-synced", sent: report.done.length, failed: report.failed.length }));
    // Throwing tells the browser to retry the sync later.
    if (report.stopped === "offline" || report.stopped === "retry") throw new Error("Outbox not fully synced");
}

// Background Sync (Chrome, Edge, Android): delivers queued mail even if Odyssey was closed when the connection returned.
self.addEventListener("sync", (event) => {
    if (event.tag === SYNC_TAG) event.waitUntil(syncOutbox());
});
