// Offline inbox snapshot and outbox, shared by the page and the service worker (via importScripts),
// so it must not touch the DOM. Everything lives in IndexedDB on this device and is wiped on sign-out.
(() => {
    "use strict";

    const DB_NAME = "odyssey-offline";
    const DB_VERSION = 1;
    const LOCK_NAME = "odyssey-outbox";
    const ENDPOINTS = { send: "/api/compose", draft: "/api/compose", action: "/api/mail-action" };
    let dbPromise = null;

    function openDb() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, DB_VERSION);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
                    if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "id" });
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => {
                    dbPromise = null;
                    reject(request.error);
                };
            });
        }
        return dbPromise;
    }

    async function run(storeName, mode, operation) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, mode);
            const request = operation(transaction.objectStore(storeName));
            transaction.oncomplete = () => resolve(request ? request.result : undefined);
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
        });
    }

    const get = (key) => run("kv", "readonly", (store) => store.get(key));
    const set = (key, value) => run("kv", "readwrite", (store) => store.put(value, key));
    const outboxPut = (item) => run("outbox", "readwrite", (store) => store.put(item));
    const outboxDelete = (id) => run("outbox", "readwrite", (store) => store.delete(id));

    async function outboxAll() {
        const items = (await run("outbox", "readonly", (store) => store.getAll())) || [];
        return items.sort((a, b) => a.createdAt - b.createdAt);
    }

    async function clearAll() {
        await run("kv", "readwrite", (store) => store.clear());
        await run("outbox", "readwrite", (store) => store.clear());
    }

    // Saved mail and queued items belong to one Google account; drop them if another account signs in.
    async function bindAccount(email) {
        const current = await get("account");
        if (current && current !== email) await clearAll();
        await set("account", email);
    }

    function withLock(task) {
        // The page and the service worker may both try to sync; only one may deliver at a time.
        return globalThis.navigator?.locks ? navigator.locks.request(LOCK_NAME, task) : task();
    }

    function requestBody(item) {
        if (item.kind === "action") {
            return { operation: item.operation, ids: item.ids, snoozeUntil: item.snoozeUntil, confirm: true, account: item.account };
        }
        return {
            ...item.payload,
            mode: item.kind,
            confirm: item.kind === "send",
            clientId: item.id,
            // After an earlier attempt the server checks Gmail first, so a lost response can't cause a double send.
            retry: item.attempts > 1,
            account: item.account,
        };
    }

    async function markFailed(item, error) {
        item.status = "failed";
        item.error = error;
        await outboxPut(item);
        return { state: "failed", error };
    }

    async function deliverUnlocked(item) {
        if (item.kind === "action" && item.operation === "snooze" && Date.parse(item.snoozeUntil) <= Date.now() + 60000) {
            return markFailed(item, "The snooze time passed while you were offline.");
        }
        item.attempts = (item.attempts || 0) + 1;
        item.status = "pending";
        await outboxPut(item);
        let response;
        try {
            response = await fetch(ENDPOINTS[item.kind], {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody(item)),
            });
        } catch {
            return { state: "offline" };
        }
        let data = {};
        try {
            data = await response.json();
        } catch {
            // Non-JSON responses are treated by status code alone.
        }
        if (response.ok) {
            await outboxDelete(item.id);
            return { state: "done", data };
        }
        if (response.status === 401 || data.code === "ACCOUNT_MISMATCH" || data.code === "RECONSENT") {
            return { state: "blocked", error: data.error, code: data.code || "AUTH_REQUIRED" };
        }
        if (response.status >= 500 || response.status === 429) return { state: "retry", error: data.error };
        return markFailed(item, data.error || "Gmail rejected this item.");
    }

    async function flushUnlocked() {
        const report = { done: [], failed: [], stopped: null };
        for (const item of await outboxAll()) {
            if (item.status === "failed") continue;
            const result = await deliverUnlocked(item);
            if (result.state === "done") report.done.push(item);
            else if (result.state === "failed") report.failed.push(item);
            else {
                // Keep order: later items (e.g. an undo) must not overtake an earlier one that couldn't go yet.
                report.stopped = result.code || result.state;
                break;
            }
        }
        return report;
    }

    globalThis.odysseyStore = {
        get,
        set,
        bindAccount,
        clearAll,
        outboxAll,
        outboxPut,
        outboxDelete,
        deliver: (item) => withLock(() => deliverUnlocked(item)),
        flush: () => withLock(flushUnlocked),
    };
})();
