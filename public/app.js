(() => {
    "use strict";

    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
    const messageStream = $("#message-stream");
    const promptInput = $("#prompt-input");
    const chatForm = $("#chat-form");
    const sendButton = $("#send-prompt");
    const sidebar = $("#sidebar");
    const scrim = $("#mobile-scrim");
    const storagePanel = $("#storage-panel");
    const composeDialog = $("#compose-dialog");
    const confirmDialog = $("#confirm-dialog");
    const jumpButton = $("#jump-latest");
    const themeToggle = $("#theme-toggle");
    const inboxPanel = $("#inbox-panel");
    const initialWelcome = $("#welcome").cloneNode(true);
    const HISTORY_KEY = "odyssey_conversations_v1";
    // Must match PAGE_CACHE in sw.js; deleted on sign-out so the saved dashboard doesn't outlive the session.
    const PAGE_CACHE = "odyssey-pages";
    const SYNC_INTERVAL_MS = 2 * 60 * 1000;
    const store = window.odysseyStore;
    const account = document.body.dataset.account || "";

    const state = {
        conversations: readHistory(),
        currentId: null,
        overview: null,
        storage: null,
        installPrompt: null,
        inbox: { messages: [], syncedAt: null },
        outbox: [],
        readerId: null,
        composeOutboxId: null,
        syncing: false,
    };

    function readHistory() {
        try {
            const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
            return Array.isArray(parsed) ? parsed.slice(0, 20) : [];
        } catch {
            return [];
        }
    }

    function writeHistory() {
        try {
            localStorage.setItem(HISTORY_KEY, JSON.stringify(state.conversations.slice(0, 20)));
        } catch {
            // A private browsing policy may block storage; the live chat still works.
        }
        renderHistory();
    }

    function isOnline() {
        return navigator.onLine !== false;
    }

    async function api(url, options = {}) {
        let response;
        try {
            response = await fetch(url, {
                credentials: "same-origin",
                headers: { "Content-Type": "application/json", ...(options.headers || {}) },
                ...options,
            });
        } catch {
            const error = new Error("You’re offline. Check your connection and try again.");
            error.code = "OFFLINE";
            throw error;
        }
        let data;
        try {
            data = await response.json();
        } catch {
            // Non-JSON bodies come from the platform (e.g. a function timeout), not from Odyssey.
            data = {
                error: response.status >= 500
                    ? "Odyssey took too long to respond. Please try again in a moment."
                    : "The server returned an unexpected response.",
            };
        }
        if (response.status === 401) {
            window.location.assign("/");
            throw new Error("Your Google session expired.");
        }
        if (!response.ok) {
            const error = new Error(data.error || "Something went wrong.");
            error.code = data.code;
            throw error;
        }
        return data;
    }

    function formatCount(value) {
        const number = Number(value || 0);
        return number > 999 ? new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(number) : String(number);
    }

    function formatBytes(value) {
        if (value === null || value === undefined) return "Unlimited";
        let number = Number(value);
        const units = ["B", "KB", "MB", "GB", "TB"];
        let unit = 0;
        while (number >= 1024 && unit < units.length - 1) {
            number /= 1024;
            unit += 1;
        }
        return `${number.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
    }

    function shortSender(value) {
        return (value || "Unknown sender").replace(/<[^>]+>/g, "").replace(/^"|"$/g, "").trim() || "Unknown sender";
    }

    function shortDate(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "";
        const today = new Date();
        if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        return date.toLocaleDateString([], { month: "short", day: "numeric" });
    }

    function setText(selector, value, root = document) {
        const element = $(selector, root);
        if (element) element.textContent = value;
    }

    function hydrateWelcome(root = document) {
        const period = new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "afternoon" : "evening";
        setText("#day-period", period, root);
        if (state.overview) {
            setText("#unread-count", formatCount(state.overview.mailbox.unread), root);
            setText("#message-count", formatCount(state.overview.mailbox.messages), root);
            const recent = $("#recent-mail", root);
            const list = $("#recent-mail-list", root);
            if (recent && list && state.overview.recent?.length) {
                list.replaceChildren();
                state.overview.recent.slice(0, 3).forEach((mail) => {
                    const row = document.createElement("div");
                    row.className = "mail-row";
                    const sender = shortSender(mail.from);
                    const avatar = document.createElement("span");
                    avatar.className = "mail-row-avatar";
                    avatar.textContent = sender.charAt(0).toUpperCase();
                    const senderNode = document.createElement("span");
                    senderNode.className = "mail-row-sender";
                    senderNode.textContent = sender;
                    const subject = document.createElement("span");
                    subject.className = "mail-row-subject";
                    subject.textContent = mail.subject;
                    const date = document.createElement("span");
                    date.className = "mail-row-date";
                    date.textContent = shortDate(mail.date);
                    row.append(avatar, senderNode, subject, date);
                    list.append(row);
                });
                recent.hidden = false;
            }
        }
        if (state.storage) {
            setText("#storage-percent", state.storage.percent === null ? "No limit" : `${Math.round(state.storage.percent)}%`, root);
        }
    }

    function setConnection(mode) {
        const status = $("#connection-status");
        status.classList.toggle("ready", mode === "ready");
        status.classList.toggle("error", mode === "error");
        status.classList.toggle("offline", mode === "offline");
        $("strong", status).textContent = { ready: "Gmail connected", error: "Connection issue", offline: "Offline" }[mode];
        document.body.classList.toggle("is-offline", mode === "offline");
    }

    async function loadDashboard() {
        if (!isOnline()) {
            setConnection("offline");
            return;
        }
        const [overviewResult, storageResult] = await Promise.allSettled([api("/api/overview"), api("/api/storage")]);
        if (overviewResult.status === "fulfilled") {
            state.overview = overviewResult.value;
            setConnection("ready");
            if (state.overview.unsnoozed) toast(`${countLabel(state.overview.unsnoozed)} you snoozed ${state.overview.unsnoozed === 1 ? "is" : "are"} back in your inbox.`);
            hydrateWelcome();
            saveOffline("overview", { mailbox: state.overview.mailbox, recent: state.overview.recent });
        } else if (overviewResult.reason.code === "OFFLINE") {
            setConnection("offline");
        } else {
            setConnection("error");
            toast(overviewResult.reason.message, true);
        }
        if (storageResult.status === "fulfilled") {
            state.storage = storageResult.value;
            renderStorage();
            hydrateWelcome();
        }
    }

    function renderStorage() {
        if (!state.storage) return;
        const item = state.storage;
        const percent = item.percent === null ? 0 : Math.min(item.percent, 100);
        $("#storage-ring").style.setProperty("--percent", String(percent));
        setText("#panel-percent", item.percent === null ? "∞" : `${Math.round(item.percent)}%`);
        setText("#storage-used", `${formatBytes(item.used)} used`);
        setText("#storage-limit", item.limit ? `of ${formatBytes(item.limit)}` : "No fixed limit reported");
        setText("#drive-used", formatBytes(item.driveUsed));
        setText("#other-used", formatBytes(item.otherUsed));
    }

    function isNearBottom() {
        return messageStream.scrollHeight - messageStream.scrollTop - messageStream.clientHeight < 80;
    }

    function scrollToLatest(smooth = true) {
        // Wait a frame so newly appended nodes are laid out before measuring.
        requestAnimationFrame(() => {
            messageStream.scrollTo({ top: messageStream.scrollHeight, behavior: smooth ? "smooth" : "auto" });
        });
    }

    function updateJumpButton() {
        jumpButton.hidden = !$(".chat-turn", messageStream) || isNearBottom();
    }

    function restoreWelcome() {
        const welcome = initialWelcome.cloneNode(true);
        messageStream.replaceChildren(welcome);
        hydrateWelcome(welcome);
        messageStream.scrollTop = 0;
        updateJumpButton();
    }

    function newConversation() {
        state.currentId = null;
        restoreWelcome();
        promptInput.value = "";
        resizeInput();
        promptInput.focus();
        closeMobileSidebar();
    }

    function getCurrentConversation(create = false, firstPrompt = "") {
        let conversation = state.conversations.find((item) => item.id === state.currentId);
        if (!conversation && create) {
            conversation = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                title: firstPrompt.replace(/\s+/g, " ").trim().slice(0, 48) || "New conversation",
                messages: [],
                updated: Date.now(),
            };
            state.currentId = conversation.id;
            state.conversations.unshift(conversation);
        }
        return conversation;
    }

    function saveMessage(role, text, sources = []) {
        const conversation = getCurrentConversation(true, text);
        // Keep every shown message (not just the 4 chips) so "delete the fifth one" can resolve later.
        const kept = sources.slice(0, 25).map(({ id, from, subject, date }) => ({ id, from, subject, date }));
        conversation.messages.push({ role, text, sources: kept });
        conversation.updated = Date.now();
        state.conversations = [conversation, ...state.conversations.filter((item) => item.id !== conversation.id)].slice(0, 20);
        writeHistory();
    }

    function createAvatar() {
        const avatar = document.createElement("span");
        avatar.className = "assistant-avatar";
        avatar.innerHTML = '<svg aria-hidden="true" viewBox="0 0 32 32"><use href="#i-logo"></use></svg>';
        return avatar;
    }

    function appendMessage(role, text, sources = [], persist = true, scroll = true, showSources = true) {
        // Follow new replies only if the reader hasn't scrolled up; their own messages always scroll.
        const follow = role === "user" || isNearBottom() || Boolean($("#welcome"));
        $("#welcome")?.remove();
        const turn = document.createElement("div");
        turn.className = `chat-turn ${role}`;
        if (role === "assistant") turn.append(createAvatar());
        const bubble = document.createElement("div");
        bubble.className = "message-bubble";
        bubble.textContent = text;
        if (role === "assistant" && showSources && sources.length) {
            const list = document.createElement("div");
            list.className = "source-list";
            sources.slice(0, 4).forEach((source) => {
                const chip = document.createElement("span");
                chip.className = "source-chip";
                chip.textContent = `${shortSender(source.from)} · ${source.subject || "No subject"}`;
                chip.title = source.subject || "No subject";
                list.append(chip);
            });
            bubble.append(list);
        }
        turn.append(bubble);
        messageStream.append(turn);
        if (persist) saveMessage(role, text, sources);
        if (scroll && follow) scrollToLatest();
        else updateJumpButton();
        return bubble;
    }

    const ACTIONS = {
        trash: { title: "Move to Trash", button: (n) => `Move ${n} to Trash`, done: (n) => `Moved ${n} to Trash.`, undo: "untrash", danger: true, icon: "i-trash" },
        untrash: { title: "Restore from Trash", button: (n) => `Restore ${n}`, done: (n) => `Restored ${n} from Trash.`, undo: "trash", icon: "i-inbox" },
        star: { title: "Star messages", button: (n) => `Star ${n}`, done: (n) => `Starred ${n}.`, undo: "unstar", icon: "i-star" },
        unstar: { title: "Remove stars", button: (n) => `Unstar ${n}`, done: (n) => `Removed the star from ${n}.`, undo: "star", icon: "i-star" },
        snooze: { title: "Snooze", button: (n) => `Snooze ${n}`, done: (n) => `Snoozed ${n}.`, undo: "unsnooze", icon: "i-clock" },
        unsnooze: { title: "Unsnooze", button: (n) => `Bring back ${n}`, done: (n) => `Moved ${n} back to your inbox.`, icon: "i-inbox" },
    };

    function countLabel(n) {
        return `${n} message${n === 1 ? "" : "s"}`;
    }

    function formatSnooze(iso) {
        const date = new Date(iso);
        return date.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    }

    async function runMailAction(operation, ids, snoozeUntil) {
        return api("/api/mail-action", {
            method: "POST",
            body: JSON.stringify({ operation, ids, snoozeUntil, confirm: true }),
        });
    }

    function renderActionCard(bubble, proposal) {
        const config = ACTIONS[proposal.operation];
        if (!config) return;
        const card = document.createElement("div");
        card.className = "action-card";

        const head = document.createElement("div");
        head.className = "action-card-head";
        const icon = document.createElement("span");
        icon.className = `action-icon${config.danger ? " danger" : ""}`;
        icon.innerHTML = `<svg aria-hidden="true"><use href="#${config.icon}"></use></svg>`;
        const heading = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = config.title;
        const subtitle = document.createElement("small");
        subtitle.textContent = proposal.snoozeUntil ? `Until ${formatSnooze(proposal.snoozeUntil)}` : countLabel(proposal.messages.length);
        heading.append(title, subtitle);
        head.append(icon, heading);

        const list = document.createElement("ul");
        list.className = "action-list";
        proposal.messages.forEach((message) => {
            const item = document.createElement("li");
            const label = document.createElement("label");
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = true;
            checkbox.value = message.id;
            const sender = document.createElement("span");
            sender.className = "action-sender";
            sender.textContent = shortSender(message.from);
            const subject = document.createElement("span");
            subject.className = "action-subject";
            subject.textContent = message.subject || "(No subject)";
            const date = document.createElement("span");
            date.className = "action-date";
            date.textContent = shortDate(message.date);
            label.append(checkbox, sender, subject, date);
            item.append(label);
            list.append(item);
        });

        const foot = document.createElement("div");
        foot.className = "action-card-foot";
        const status = document.createElement("span");
        status.className = "action-status";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "secondary-button";
        cancel.textContent = "Cancel";
        const confirm = document.createElement("button");
        confirm.type = "button";
        confirm.className = `primary-button${config.danger ? " danger-button" : ""}`;
        foot.append(status, cancel, confirm);

        const selectedIds = () => $$("input:checked", list).map((input) => input.value);
        const syncButton = () => {
            const count = selectedIds().length;
            confirm.textContent = config.button(count);
            confirm.disabled = count === 0;
        };
        list.addEventListener("change", syncButton);
        syncButton();

        const finish = (message, undoOperation, ids) => {
            $$("input", list).forEach((input) => { input.disabled = true; });
            foot.replaceChildren(status);
            status.textContent = message;
            if (undoOperation) {
                const undo = document.createElement("button");
                undo.type = "button";
                undo.className = "secondary-button";
                undo.textContent = "Undo";
                undo.addEventListener("click", async () => {
                    undo.disabled = true;
                    try {
                        await runMailAction(undoOperation, ids, null);
                        status.textContent = "Undone. Everything is back the way it was.";
                        undo.remove();
                        saveMessage("assistant", `Undid the last change to ${countLabel(ids.length)}.`);
                        loadDashboard();
                    } catch (error) {
                        undo.disabled = false;
                        toast(error.message, true);
                    }
                });
                foot.append(undo);
            }
        };

        cancel.addEventListener("click", () => finish("Cancelled. Nothing was changed."));
        confirm.addEventListener("click", async () => {
            const ids = selectedIds();
            confirm.disabled = true;
            cancel.disabled = true;
            status.textContent = "Working…";
            try {
                await runMailAction(proposal.operation, ids, proposal.snoozeUntil);
                const chosen = proposal.messages.filter((message) => ids.includes(message.id));
                let text = config.done(countLabel(ids.length));
                if (proposal.operation === "snooze") text = `Snoozed ${countLabel(ids.length)} until ${formatSnooze(proposal.snoozeUntil)}. They’ll return to your inbox the next time you open Odyssey after that.`;
                finish(text, config.undo, ids);
                saveMessage("assistant", text, chosen);
                loadDashboard();
            } catch (error) {
                status.textContent = error.message;
                cancel.disabled = false;
                syncButton();
                if (error.code === "RECONSENT") {
                    const reconnect = document.createElement("button");
                    reconnect.type = "button";
                    reconnect.className = "primary-button";
                    reconnect.textContent = "Sign in again";
                    reconnect.addEventListener("click", () => logout(reconnect));
                    foot.replaceChildren(status, reconnect);
                }
            }
        });

        card.append(head, list, foot);
        bubble.append(card);
    }

    function appendTyping() {
        const turn = document.createElement("div");
        turn.className = "chat-turn assistant";
        turn.id = "typing-turn";
        turn.append(createAvatar());
        const bubble = document.createElement("div");
        bubble.className = "message-bubble typing";
        bubble.setAttribute("aria-label", "Odyssey is thinking");
        bubble.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
        turn.append(bubble);
        messageStream.append(turn);
        scrollToLatest();
    }

    async function sendPrompt(prompt) {
        const text = prompt.trim();
        if (!text || sendButton.dataset.busy === "true") return;
        // Recent turns let the assistant follow up ("what about last week?") without repeating context.
        const history = (getCurrentConversation()?.messages || []).slice(-10).map(({ role, text: content, sources }) => ({ role, text: content, sources }));
        appendMessage("user", text);
        promptInput.value = "";
        resizeInput();
        if (!isOnline()) {
            appendMessage(
                "assistant",
                "You’re offline, and I need a connection to understand requests. Meanwhile you can read your saved inbox, write emails and save drafts, or delete, star and snooze saved messages. Everything queues and syncs automatically when you’re back online.",
                [],
                false
            );
            return;
        }
        sendButton.dataset.busy = "true";
        sendButton.disabled = true;
        appendTyping();
        try {
            const data = await api("/api/chat", { method: "POST", body: JSON.stringify({ prompt: text, history, localTime: new Date().toString() }) });
            $("#typing-turn")?.remove();
            const bubble = appendMessage("assistant", data.reply || "I’m ready when you are.", data.sources || [], true, true, !data.proposal);
            if (data.proposal) {
                renderActionCard(bubble, data.proposal);
                scrollToLatest();
            }
            if (data.compose) openCompose(data.compose);
            if (data.storage) {
                state.storage = data.storage;
                renderStorage();
            }
        } catch (error) {
            $("#typing-turn")?.remove();
            appendMessage("assistant", error.message, [], false);
            toast(error.message, true);
        } finally {
            sendButton.dataset.busy = "false";
            sendButton.disabled = !promptInput.value.trim();
        }
    }

    function renderHistory() {
        const list = $("#history-list");
        list.replaceChildren();
        if (!state.conversations.length) {
            const empty = document.createElement("p");
            empty.className = "history-empty";
            empty.textContent = "Your conversations will appear here.";
            list.append(empty);
            return;
        }
        state.conversations.forEach((conversation) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "history-item";
            button.dataset.conversationId = conversation.id;
            const title = document.createElement("span");
            title.textContent = conversation.title;
            button.append(title);
            list.append(button);
        });
    }

    function openConversation(id) {
        const conversation = state.conversations.find((item) => item.id === id);
        if (!conversation) return;
        state.currentId = id;
        messageStream.replaceChildren();
        conversation.messages.forEach((message) => appendMessage(message.role, message.text, message.sources || [], false, false));
        scrollToLatest(false);
        closeMobileSidebar();
    }

    function closeMenus(except = null) {
        $$("[data-menu]").forEach((button) => {
            const menu = document.getElementById(button.dataset.menu);
            if (!menu || menu === except) return;
            menu.hidden = true;
            button.setAttribute("aria-expanded", "false");
        });
    }

    function toggleMenu(button) {
        const menu = document.getElementById(button.dataset.menu);
        const open = menu.hidden;
        closeMenus(menu);
        menu.hidden = !open;
        button.setAttribute("aria-expanded", String(open));
        if (open) $("button", menu)?.focus();
    }

    async function clearOfflineData() {
        try {
            await store?.clearAll();
            await caches.delete(PAGE_CACHE);
        } catch {
            // Storage may be unavailable; nothing was saved in that case.
        }
    }

    async function logout(button) {
        const waiting = state.outbox.filter((item) => item.status !== "failed").length;
        if (waiting && !window.confirm(`${countLabel(waiting)} in your outbox ${waiting === 1 ? "hasn’t" : "haven’t"} synced yet. Signing out deletes ${waiting === 1 ? "it" : "them"} from this device. Sign out anyway?`)) {
            return;
        }
        button.disabled = true;
        try {
            const result = await api("/auth/logout", { method: "POST", body: "{}" });
            // Saved mail must not stay readable on this device after signing out.
            await clearOfflineData();
            window.location.assign(result.redirect || "/");
        } catch (error) {
            button.disabled = false;
            toast(error.message, true);
        }
    }

    function syncThemeToggle() {
        const next = window.odysseyTheme?.current() === "light" ? "dark" : "light";
        const label = `Switch to ${next} mode`;
        themeToggle.setAttribute("aria-label", label);
        themeToggle.title = label;
    }

    function resizeInput() {
        promptInput.style.height = "auto";
        promptInput.style.height = `${Math.min(promptInput.scrollHeight, 150)}px`;
        sendButton.disabled = !promptInput.value.trim() || sendButton.dataset.busy === "true";
    }

    function openMobileSidebar() {
        sidebar.classList.add("is-open");
        scrim.hidden = false;
    }

    function closeMobileSidebar() {
        sidebar.classList.remove("is-open");
        scrim.hidden = true;
    }

    function openStorage() {
        storagePanel.classList.add("is-open");
        storagePanel.setAttribute("aria-hidden", "false");
        closeMobileSidebar();
    }

    function closeStorage() {
        storagePanel.classList.remove("is-open");
        storagePanel.setAttribute("aria-hidden", "true");
    }

    function openCompose(prefill = {}, outboxId = null) {
        state.composeOutboxId = outboxId;
        $("#compose-to").value = prefill.to || "";
        $("#compose-subject").value = prefill.subject || "";
        $("#compose-body").value = prefill.body || "";
        setText("#compose-status", "");
        if (!composeDialog.open) composeDialog.showModal();
        setTimeout(() => (prefill.to ? $("#compose-body") : $("#compose-to")).focus(), 40);
        closeMobileSidebar();
    }

    function composePayload() {
        return {
            to: $("#compose-to").value.trim(),
            subject: $("#compose-subject").value.trim(),
            body: $("#compose-body").value.trim(),
        };
    }

    function validateCompose() {
        const fields = [$("#compose-to"), $("#compose-subject"), $("#compose-body")];
        const invalid = fields.find((field) => !field.reportValidity());
        return !invalid;
    }

    function closeComposeDialogs() {
        if (confirmDialog.open) confirmDialog.close();
        composeDialog.close();
        state.composeOutboxId = null;
    }

    async function composeAction(mode) {
        if (!validateCompose()) return;
        const existing = state.outbox.find((item) => item.id === state.composeOutboxId);
        // Every email goes through the outbox, so a dropped connection mid-send leaves it queued rather than lost.
        const item = {
            ...(existing || { id: newId(), createdAt: Date.now(), attempts: 0 }),
            kind: mode,
            payload: composePayload(),
            account,
            status: "pending",
            error: null,
        };
        if (!isOnline()) {
            await queue(item);
            closeComposeDialogs();
            toast(mode === "send"
                ? "You’re offline. This email will send automatically when you’re back online."
                : "Draft saved on this device. It will be added to your Gmail drafts when you’re back online.");
            return;
        }
        const button = mode === "send" ? $("#confirm-send") : $("#save-draft");
        button.disabled = true;
        setText("#compose-status", mode === "send" ? "Sending…" : "Saving…");
        try {
            await store.outboxPut(item);
            const result = await store.deliver(item);
            if (result.state === "done") {
                closeComposeDialogs();
                toast(result.data.status === "sent" ? "Message sent with Gmail." : "Draft saved to Gmail.");
            } else if (result.state === "offline" || result.state === "retry") {
                closeComposeDialogs();
                requestBackgroundSync();
                toast(mode === "send" ? "Connection dropped. Your email is in the outbox and will send automatically." : "Connection dropped. Your draft is in the outbox and will sync automatically.");
            } else {
                // Rejected (e.g. invalid address): keep the dialog open to fix it instead of leaving it queued.
                await store.outboxDelete(item.id);
                if (confirmDialog.open) confirmDialog.close();
                setText("#compose-status", result.error || "Gmail could not save or send this message.");
                toast(result.error || "Gmail could not save or send this message.", true);
            }
        } catch (error) {
            setText("#compose-status", error.message);
            toast(error.message, true);
        } finally {
            button.disabled = false;
            refreshOutbox();
        }
    }

    function toast(message, isError = false, action = null) {
        const item = document.createElement("div");
        item.className = `toast${isError ? " error" : ""}`;
        const text = document.createElement("span");
        text.textContent = message;
        item.append(text);
        if (action) {
            // Toasts are otherwise non-interactive; re-enable pointer events for the action button.
            item.classList.add("has-action");
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = action.label;
            button.addEventListener("click", () => {
                item.remove();
                action.onClick();
            });
            item.append(button);
        }
        $("#toast-region").append(item);
        setTimeout(() => item.remove(), action ? 7000 : 4200);
    }

    /* Offline inbox and outbox */

    function newId() {
        return crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    }

    function saveOffline(key, value) {
        store?.set(key, value).catch(() => {});
    }

    function requestBackgroundSync() {
        navigator.serviceWorker?.ready.then((registration) => registration.sync?.register("odyssey-outbox")).catch(() => {});
    }

    async function queue(item) {
        await store.outboxPut(item);
        await refreshOutbox();
        requestBackgroundSync();
        if (isOnline()) syncNow();
    }

    async function refreshOutbox() {
        try {
            state.outbox = store ? await store.outboxAll() : [];
        } catch {
            state.outbox = [];
        }
        renderOutbox();
        renderInbox();
    }

    // Queued actions are shown as already applied, so the saved inbox matches what the user did offline.
    function visibleMessages() {
        const pending = state.outbox.filter((item) => item.kind === "action" && item.status !== "failed");
        return state.inbox.messages
            .filter((message) => !pending.some((item) => ["trash", "snooze"].includes(item.operation) && item.ids.includes(message.id)))
            .map((message) => {
                const starChange = pending.filter((item) => ["star", "unstar"].includes(item.operation) && item.ids.includes(message.id)).pop();
                return {
                    ...message,
                    starred: starChange ? starChange.operation === "star" : message.starred,
                    pending: pending.some((item) => item.ids.includes(message.id)),
                };
            });
    }

    function relativeTime(iso) {
        const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
        if (minutes < 1) return "just now";
        if (minutes < 60) return `${minutes} min ago`;
        if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
        return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    }

    function renderSyncStatus() {
        const synced = state.inbox.syncedAt ? relativeTime(state.inbox.syncedAt) : null;
        let text;
        if (!isOnline()) text = synced ? `Offline · saved ${synced}` : "Offline · nothing saved yet";
        else if (state.syncing) text = "Checking for new mail…";
        else text = synced ? `Updated ${synced}` : "Not synced yet";
        setText("#inbox-sync-status", text);
    }

    function renderInbox() {
        renderSyncStatus();
        const list = $("#inbox-list");
        const messages = visibleMessages();
        list.replaceChildren();
        if (!messages.length) {
            const empty = document.createElement("p");
            empty.className = "inbox-empty";
            empty.textContent = state.inbox.syncedAt
                ? "No messages in your saved inbox."
                : isOnline() ? "Loading your inbox…" : "Your inbox hasn’t been saved on this device yet. Connect once to make it available offline.";
            list.append(empty);
        }
        messages.forEach((message) => {
            const row = document.createElement("button");
            row.type = "button";
            row.className = `inbox-row${message.unread ? " unread" : ""}`;
            row.dataset.messageId = message.id;
            const avatar = document.createElement("span");
            avatar.className = "mail-row-avatar";
            avatar.textContent = shortSender(message.from).charAt(0).toUpperCase();
            const main = document.createElement("span");
            main.className = "inbox-row-main";
            const top = document.createElement("span");
            top.className = "inbox-row-top";
            const sender = document.createElement("strong");
            sender.textContent = shortSender(message.from);
            const date = document.createElement("small");
            date.textContent = shortDate(message.date);
            top.append(sender);
            if (message.starred) {
                const star = document.createElement("span");
                star.className = "inbox-star";
                star.setAttribute("aria-label", "Starred");
                star.innerHTML = '<svg aria-hidden="true"><use href="#i-star"></use></svg>';
                top.append(star);
            }
            if (message.pending) {
                const badge = document.createElement("span");
                badge.className = "pending-badge";
                badge.textContent = "Waiting to sync";
                top.append(badge);
            }
            top.append(date);
            const subject = document.createElement("span");
            subject.className = "inbox-row-subject";
            subject.textContent = message.subject || "(No subject)";
            const snippet = document.createElement("span");
            snippet.className = "inbox-row-snippet";
            snippet.textContent = message.snippet;
            main.append(top, subject, snippet);
            row.append(avatar, main);
            list.append(row);
        });
        if (state.readerId) renderReader();
        const unread = messages.filter((message) => message.unread).length;
        $$(".inbox-count").forEach((badge) => {
            badge.textContent = unread > 99 ? "99+" : String(unread);
            badge.hidden = !unread;
        });
    }

    const OUTBOX_LABELS = {
        send: "Email",
        draft: "Draft",
        trash: "Delete",
        untrash: "Restore",
        star: "Star",
        unstar: "Unstar",
        snooze: "Snooze",
        unsnooze: "Unsnooze",
    };

    function renderOutbox() {
        const section = $("#outbox");
        const list = $("#outbox-list");
        list.replaceChildren();
        section.hidden = !state.outbox.length;
        const waiting = state.outbox.filter((item) => item.status !== "failed").length;
        setText("#outbox-note", isOnline() ? "Syncing" : "Sends when you’re back online");
        $$(".outbox-count").forEach((badge) => {
            badge.textContent = String(state.outbox.length);
            badge.hidden = !state.outbox.length;
            badge.classList.toggle("has-failed", waiting < state.outbox.length);
        });
        state.outbox.forEach((item) => {
            const row = document.createElement("div");
            row.className = `outbox-row${item.status === "failed" ? " failed" : ""}`;
            const kind = document.createElement("span");
            kind.className = "outbox-kind";
            kind.textContent = OUTBOX_LABELS[item.kind === "action" ? item.operation : item.kind];
            const copy = document.createElement("span");
            copy.className = "outbox-copy";
            const title = document.createElement("strong");
            title.textContent = item.kind === "action" ? item.label : item.payload.subject || "(No subject)";
            const detail = document.createElement("small");
            if (item.status === "failed") detail.textContent = item.error;
            else if (item.kind === "action") detail.textContent = item.operation === "snooze" ? `Until ${formatSnooze(item.snoozeUntil)}` : "Waiting to sync";
            else detail.textContent = `To ${item.payload.to}${item.kind === "send" ? " · sends automatically" : " · saves to Gmail drafts"}`;
            copy.append(title, detail);
            const actions = document.createElement("span");
            actions.className = "outbox-actions";
            const addButton = (label, handler) => {
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = label;
                button.addEventListener("click", handler);
                actions.append(button);
            };
            if (item.kind !== "action") addButton("Edit", () => openCompose(item.payload, item.id));
            if (item.status === "failed") {
                addButton("Retry", async () => {
                    await store.outboxPut({ ...item, status: "pending", error: null });
                    await refreshOutbox();
                    syncNow();
                });
            }
            addButton(item.kind === "action" ? "Cancel" : "Discard", async () => {
                await store.outboxDelete(item.id);
                refreshOutbox();
            });
            row.append(kind, copy, actions);
            list.append(row);
        });
    }

    function readerMessage() {
        return visibleMessages().find((message) => message.id === state.readerId);
    }

    function renderReader() {
        const message = readerMessage();
        if (!message) {
            closeReader();
            return;
        }
        setText("#reader-subject", message.subject || "(No subject)");
        setText("#reader-from", shortSender(message.from));
        setText("#reader-date", new Date(message.date).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }));
        setText("#reader-body", (message.body || message.snippet || "").trim() || "This email has no plain-text content. Open it in Gmail to view it.");
        const star = $("#reader-star");
        star.textContent = message.starred ? "Unstar" : "Star";
        star.setAttribute("aria-pressed", String(message.starred));
    }

    function openReader(id) {
        state.readerId = id;
        $("#inbox-list-view").hidden = true;
        $("#mail-reader").hidden = false;
        renderReader();
        $("#mail-reader").scrollTop = 0;
        $("#reader-back").focus();
    }

    function closeReader() {
        state.readerId = null;
        $("#mail-reader").hidden = true;
        $("#inbox-list-view").hidden = false;
    }

    function openInbox() {
        inboxPanel.classList.add("is-open");
        inboxPanel.setAttribute("aria-hidden", "false");
        closeStorage();
        closeMobileSidebar();
        renderInbox();
        if (isOnline() && (!state.inbox.syncedAt || Date.now() - Date.parse(state.inbox.syncedAt) > 60000)) syncNow();
    }

    function closeInbox() {
        inboxPanel.classList.remove("is-open");
        inboxPanel.setAttribute("aria-hidden", "true");
        closeReader();
    }

    async function queueAction(operation, message, snoozeUntil = null) {
        const verb = OUTBOX_LABELS[operation];
        const item = {
            id: newId(),
            kind: "action",
            operation,
            ids: [message.id],
            snoozeUntil,
            label: `${verb} “${message.subject || "(No subject)"}”`,
            account,
            createdAt: Date.now(),
            attempts: 0,
            status: "pending",
        };
        await queue(item);
        const undoOperation = { trash: "untrash", star: "unstar", unstar: "star", snooze: "unsnooze" }[operation];
        const done = { trash: "Moved to Trash", star: "Starred", unstar: "Star removed", snooze: `Snoozed until ${formatSnooze(snoozeUntil)}` }[operation];
        toast(isOnline() ? `${done}.` : `${done}. It will sync when you’re back online.`, false, undoOperation && {
            label: "Undo",
            onClick: async () => {
                // If it hasn't synced yet, just drop it; otherwise queue the opposite change.
                const stillQueued = (await store.outboxAll()).some((queued) => queued.id === item.id);
                if (stillQueued) {
                    await store.outboxDelete(item.id);
                    refreshOutbox();
                } else {
                    queueAction(undoOperation, message);
                }
            },
        });
    }

    function snoozeTime(choice) {
        const date = new Date();
        if (choice === "later") return new Date(date.getTime() + 3 * 60 * 60 * 1000);
        date.setHours(8, 0, 0, 0);
        if (choice === "tomorrow") date.setDate(date.getDate() + 1);
        if (choice === "weekend") date.setDate(date.getDate() + (((6 - date.getDay()) + 7) % 7 || 7));
        if (choice === "nextweek") date.setDate(date.getDate() + (((1 - date.getDay()) + 7) % 7 || 7));
        return date;
    }

    function replyDraft(message) {
        const address = (message.from.match(/<([^>]+)>/) || [null, message.from])[1].trim();
        const subject = /^re:/i.test(message.subject || "") ? message.subject : `Re: ${message.subject || ""}`.trim();
        const quoted = (message.body || message.snippet || "").trim().slice(0, 1500).split("\n").map((line) => `> ${line}`).join("\n");
        return { to: address, subject, body: `\n\nOn ${message.date}, ${shortSender(message.from)} wrote:\n${quoted}` };
    }

    async function syncInbox() {
        const previous = new Set(state.inbox.messages.map((message) => message.id));
        const data = await api("/api/inbox");
        const fresh = state.inbox.syncedAt ? data.messages.filter((message) => !previous.has(message.id)).length : 0;
        state.inbox = { messages: data.messages, syncedAt: data.syncedAt };
        saveOffline("inbox", state.inbox);
        if (fresh) toast(`${countLabel(fresh)} new in your inbox.`);
    }

    async function syncNow() {
        if (!store || state.syncing || !isOnline()) return;
        state.syncing = true;
        renderSyncStatus();
        try {
            const report = await store.flush();
            const sent = report.done.filter((item) => item.kind === "send").length;
            if (sent) toast(`Sent ${countLabel(sent).replace("message", "email")} that ${sent === 1 ? "was" : "were"} waiting in your outbox.`);
            if (report.failed.length) toast(`${countLabel(report.failed.length)} in your outbox couldn’t sync. Open your inbox to review.`, true);
            if (report.stopped === "RECONSENT") toast("Sign out and sign in again so Odyssey can sync your queued changes.", true);
            else if (report.stopped === "AUTH_REQUIRED") toast("Your Google session expired. Sign in again to sync your outbox.", true);
            await refreshOutbox();
            await syncInbox();
        } catch (error) {
            if (error.code !== "OFFLINE") toast(error.message, true);
        } finally {
            state.syncing = false;
            renderInbox();
        }
    }

    async function initOffline() {
        if (!store) return;
        try {
            await store.bindAccount(account);
            const [inbox, overview] = await Promise.all([store.get("inbox"), store.get("overview")]);
            if (inbox) state.inbox = inbox;
            if (overview && !state.overview) {
                state.overview = overview;
                hydrateWelcome();
            }
        } catch {
            // IndexedDB can be unavailable (e.g. some private modes); Odyssey then works online only.
        }
        await refreshOutbox();
        if (isOnline()) syncNow();
        else setConnection("offline");
    }

    chatForm.addEventListener("submit", (event) => {
        event.preventDefault();
        sendPrompt(promptInput.value);
    });
    promptInput.addEventListener("input", resizeInput);
    promptInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            chatForm.requestSubmit();
        }
    });
    messageStream.addEventListener("click", (event) => {
        const card = event.target.closest("[data-prompt]");
        if (card) sendPrompt(card.dataset.prompt);
    });
    $("#history-list").addEventListener("click", (event) => {
        const button = event.target.closest("[data-conversation-id]");
        if (button) openConversation(button.dataset.conversationId);
    });
    $("#new-chat").addEventListener("click", newConversation);
    $("#clear-history").addEventListener("click", () => {
        state.conversations = [];
        state.currentId = null;
        writeHistory();
        restoreWelcome();
    });
    $("#open-sidebar").addEventListener("click", openMobileSidebar);
    $("#close-sidebar").addEventListener("click", closeMobileSidebar);
    scrim.addEventListener("click", closeMobileSidebar);
    $("#open-storage").addEventListener("click", openStorage);
    $("#close-storage").addEventListener("click", closeStorage);
    [$("#open-compose"), $("#inbox-compose")].forEach((button) => button.addEventListener("click", () => openCompose()));
    $("#close-compose").addEventListener("click", () => composeDialog.close());
    $("#save-draft").addEventListener("click", () => composeAction("draft"));
    $("#request-send").addEventListener("click", () => {
        if (!validateCompose()) return;
        const summary = `“${$("#compose-subject").value.trim()}” to ${$("#compose-to").value.trim()}`;
        setText("#confirm-copy", isOnline()
            ? `Send ${summary}?`
            : `You’re offline. Odyssey will send ${summary} automatically as soon as you’re back online.`);
        setText("#confirm-send", isOnline() ? "Send now" : "Send when online");
        confirmDialog.showModal();
    });
    $$("[data-open-inbox]").forEach((button) => button.addEventListener("click", openInbox));
    $("#close-inbox").addEventListener("click", closeInbox);
    $("#refresh-inbox").addEventListener("click", () => {
        if (isOnline()) syncNow();
        else toast("You’re offline. Odyssey will check for new mail as soon as you reconnect.");
    });
    $("#inbox-list").addEventListener("click", (event) => {
        const row = event.target.closest("[data-message-id]");
        if (row) openReader(row.dataset.messageId);
    });
    $("#reader-back").addEventListener("click", closeReader);
    $("#reader-reply").addEventListener("click", () => {
        const message = readerMessage();
        if (message) openCompose(replyDraft(message));
    });
    $("#reader-star").addEventListener("click", () => {
        const message = readerMessage();
        if (message) queueAction(message.starred ? "unstar" : "star", message);
    });
    $("#reader-trash").addEventListener("click", () => {
        const message = readerMessage();
        if (!message) return;
        closeReader();
        queueAction("trash", message);
    });
    $("#snooze-menu").addEventListener("click", (event) => {
        const choice = event.target.closest("[data-snooze]")?.dataset.snooze;
        const message = readerMessage();
        if (!choice || !message) return;
        closeMenus();
        closeReader();
        queueAction("snooze", message, snoozeTime(choice).toISOString());
    });
    window.addEventListener("online", () => {
        setConnection("ready");
        toast("Back online. Syncing your mail…");
        loadDashboard();
        syncNow();
    });
    window.addEventListener("offline", () => {
        setConnection("offline");
        renderInbox();
        renderOutbox();
        toast("You’re offline. You can still read saved mail and queue emails and actions.");
    });
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") syncNow();
    });
    setInterval(() => {
        if (document.visibilityState === "visible") syncNow();
        else renderSyncStatus();
    }, SYNC_INTERVAL_MS);
    navigator.serviceWorker?.addEventListener("message", (event) => {
        if (event.data?.type !== "outbox-synced") return;
        refreshOutbox();
        if (event.data.sent) toast("Your queued emails were sent.");
    });
    // Google profile photos can't load offline; show the initial instead of a broken image.
    $$(".account-button img").forEach((image) => {
        const swap = () => {
            const fallback = document.createElement("span");
            fallback.className = "avatar-fallback";
            fallback.textContent = (document.body.dataset.name || "O").charAt(0).toUpperCase();
            image.replaceWith(fallback);
        };
        if (image.complete && image.naturalWidth === 0) swap();
        else image.addEventListener("error", swap);
    });
    $("#cancel-send").addEventListener("click", () => confirmDialog.close());
    $("#confirm-send").addEventListener("click", () => composeAction("send"));
    $$("[data-menu]").forEach((button) => button.addEventListener("click", () => toggleMenu(button)));
    $$('[data-action="logout"]').forEach((button) => button.addEventListener("click", () => logout(button)));
    document.addEventListener("click", (event) => {
        if (!event.target.closest(".account-popover, [data-menu]")) closeMenus();
    });
    themeToggle.addEventListener("click", () => {
        window.odysseyTheme?.set(window.odysseyTheme.current() === "light" ? "dark" : "light");
        syncThemeToggle();
    });
    messageStream.addEventListener("scroll", updateJumpButton, { passive: true });
    jumpButton.addEventListener("click", () => scrollToLatest());

    document.addEventListener("keydown", (event) => {
        const inField = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
            event.preventDefault();
            newConversation();
        } else if (!inField && !event.metaKey && !event.ctrlKey && event.key.toLowerCase() === "c") {
            openCompose();
        } else if (event.key === "Escape") {
            closeMenus();
            if (state.readerId) closeReader();
            else closeInbox();
            closeStorage();
            closeMobileSidebar();
        }
    });

    window.addEventListener("beforeinstallprompt", (event) => {
        event.preventDefault();
        state.installPrompt = event;
        $("#install-app").hidden = false;
    });
    $("#install-app").addEventListener("click", async () => {
        if (!state.installPrompt) return;
        state.installPrompt.prompt();
        await state.installPrompt.userChoice;
        state.installPrompt = null;
        $("#install-app").hidden = true;
    });

    if ("serviceWorker" in navigator) {
        window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
    }

    renderHistory();
    syncThemeToggle();
    hydrateWelcome();
    resizeInput();
    loadDashboard();
    initOffline();
})();
