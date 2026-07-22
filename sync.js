// --------------------------------------------------------------------------
// Cloud sync — optional autosave of the whole local profile.
//
// The app stays fully usable with no sync API reachable: init() probes for one and,
// if nothing answers, returns silently and the sync UI is never revealed.
//
// A profile is identified by four words. They are the only credential, they are the
// only way back into a profile, and they are stored on this device in localStorage
// under keys prefixed `sync_` — which snapshotLocalData() deliberately skips, so a
// pull never overwrites this device's own key with another device's.
// --------------------------------------------------------------------------

const SyncClient = (() => {

    const K_KEY = "sync_key";
    const K_REV = "sync_rev";
    const K_API = "sync_api_base";
    const K_DIRTY = "sync_dirty_since";

    const MAX_BLOB_BYTES = 64 * 1024;
    const PUSH_DEBOUNCE_MS = 3000;
    const HEALTH_TIMEOUT_MS = 2500;

    let available = false;   // an API answered /health
    let applying = false;    // a pull is writing localStorage — suppress pushes
    let pushing = false;     // a push is in flight — don't race a second one
    let authFailed = false;  // key rejected — stop retrying until the user acts
    let suppressDirty = false; // taking a snapshot, which itself calls saveConfig()
    let pushTimer = null;
    let state = "off";       // off | synced | pending | syncing | error | conflict
    let detail = "";
    let cloudRev = null;     // set when a 409 tells us the cloud moved ahead

    // ----------------------------------------------------------------------
    // API base — derived from the current location, never hard-coded.
    // ----------------------------------------------------------------------

    function apiBase() {
        const q = new URLSearchParams(location.search).get("api");
        if (q) localStorage.setItem(K_API, q);
        const override = q || localStorage.getItem(K_API);
        if (override) return override.replace(/\/+$/, "");

        const host = location.hostname;
        if (!host) return null; // opened as a file:// page — no API to talk to
        if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
            return `${location.protocol}//${host}:3000/api/classpicker`;
        }
        // Strip the leftmost label, so app.example.com talks to example.com.
        const parts = host.split(".");
        const apex = parts.length > 2 ? parts.slice(1).join(".") : host;
        return `${location.protocol}//${apex}/api/classpicker`;
    }

    // ----------------------------------------------------------------------
    // Local sync state
    // ----------------------------------------------------------------------

    function getKey() { return localStorage.getItem(K_KEY) || ""; }
    function getRev() { return Number.parseInt(localStorage.getItem(K_REV), 10) || 0; }
    function setRev(r) { localStorage.setItem(K_REV, String(r)); }
    function isConfigured() { return !!getKey(); }
    function isDirty() { return !!localStorage.getItem(K_DIRTY); }
    function markClean() { localStorage.removeItem(K_DIRTY); }

    // ----------------------------------------------------------------------
    // Compression
    // ----------------------------------------------------------------------

    async function gzip(text) {
        const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    async function gunzip(buffer) {
        const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
        return await new Response(stream).text();
    }

    // ----------------------------------------------------------------------
    // Requests — all failures are surfaced as state, never thrown at the caller.
    // ----------------------------------------------------------------------

    function authHeaders(extra) {
        return Object.assign({"X-Sync-Key": getKey()}, extra || {});
    }

    async function request(path, opts, timeoutMs) {
        const base = apiBase();
        if (!base) return null;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs || 10000);
        try {
            return await fetch(base + path, Object.assign({signal: controller.signal}, opts));
        } catch (e) {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    // ----------------------------------------------------------------------
    // Indicator
    // ----------------------------------------------------------------------

    const DOT_CLASSES = {
        synced: "bg-emerald-500",
        pending: "bg-amber-400",
        syncing: "bg-accent-500 animate-pulse",
        error: "bg-rose-500",
        conflict: "bg-amber-500"
    };

    const DOT_LABELS = {
        off: "Cloud sync is off",
        synced: "Cloud sync on — up to date",
        pending: "Cloud sync on — unsaved changes",
        syncing: "Syncing…",
        error: "Sync problem",
        conflict: "Sync conflict — needs attention"
    };

    function setState(next, note) {
        state = next;
        detail = note || "";
        const dot = document.getElementById("sync_dot");
        const btn = document.getElementById("sync_btn");
        if (dot) {
            dot.className = "absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-white dark:ring-slate-900 " +
                (DOT_CLASSES[next] || "");
            dot.classList.toggle("hidden", next === "off");
        }
        if (btn) btn.setAttribute("data-tip", detail || DOT_LABELS[next] || "Cloud sync");
        renderPanel();
    }

    function revealUi() {
        const wrap = document.getElementById("sync_wrap");
        if (wrap) wrap.classList.remove("hidden");
    }

    // ----------------------------------------------------------------------
    // Push / pull
    // ----------------------------------------------------------------------

    // Called from saveConfig() on every local mutation, so it must stay cheap and
    // debounced — the search box calls saveConfig() on each keystroke.
    function markDirty() {
        if (!available || !isConfigured() || applying || suppressDirty) return;
        // Always record that there are unsaved changes, even if we can't send them
        // right now — the marker is what makes a later push pick them up.
        localStorage.setItem(K_DIRTY, new Date().toISOString());
        // A rejected key won't start working because we asked again; retrying on
        // every keystroke would just pile up failed attempts against this address.
        if (authFailed) return;
        if (state !== "conflict") setState("pending");
        if (pushTimer) clearTimeout(pushTimer);
        pushTimer = setTimeout(() => { push(); }, PUSH_DEBOUNCE_MS);
    }

    async function push(opts) {
        const force = opts && opts.force;
        if (!available || !isConfigured() || applying) return false;
        if (state === "conflict" && !force) return false;
        if (authFailed && !force) return false;
        // A second push racing the first would send the same base revision and get
        // itself rejected as stale. Let the in-flight one finish and retry after.
        if (pushing) {
            if (pushTimer) clearTimeout(pushTimer);
            pushTimer = setTimeout(() => { push(); }, PUSH_DEBOUNCE_MS);
            return false;
        }
        if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }

        pushing = true;
        setState("syncing");
        let blob;
        let dirtyAtSnapshot;
        try {
            // snapshotLocalData() calls saveConfig(), which calls markDirty() —
            // without this guard every push would schedule another one, forever.
            suppressDirty = true;
            let payload;
            try {
                payload = snapshotLocalData();
            } finally {
                suppressDirty = false;
            }
            dirtyAtSnapshot = localStorage.getItem(K_DIRTY);
            blob = await gzip(JSON.stringify(payload));
        } catch (e) {
            pushing = false;
            console.warn("Could not compress profile for sync.", e);
            setState("error", "Could not prepare data for sync");
            return false;
        }
        if (blob.length > MAX_BLOB_BYTES) {
            pushing = false;
            setState("error", `Profile is too large to sync (${Math.round(blob.length / 1024)} KB of ${MAX_BLOB_BYTES / 1024} KB)`);
            return false;
        }

        // On a forced overwrite, adopt whatever revision the cloud is at so the
        // write is accepted rather than rejected as stale.
        let baseRev = getRev();
        if (force) {
            const meta = await fetchMeta();
            if (meta) baseRev = meta.rev;
        }

        const res = await request("/profile", {
            method: "PUT",
            headers: authHeaders({"Content-Type": "application/octet-stream", "X-Base-Rev": String(baseRev)}),
            body: blob
        });
        pushing = false;
        if (!res) { setState("error", "Could not reach the sync server"); return false; }

        if (res.status === 409) {
            const body = await res.json().catch(() => ({}));
            cloudRev = body.rev;
            setState("conflict", "Another device saved newer data");
            return false;
        }
        if (res.status === 401) { authFailed = true; setState("error", "Sync key was not accepted — reconnect to fix"); return false; }
        if (res.status === 429) { authFailed = true; setState("error", "Too many attempts — reconnect to try again"); return false; }
        if (res.status === 413) { setState("error", "Profile is too large to sync"); return false; }
        if (!res.ok) { setState("error", `Sync failed (${res.status})`); return false; }

        const body = await res.json().catch(() => null);
        if (body && typeof body.rev === "number") setRev(body.rev);
        cloudRev = null;

        // If an edit landed while this push was in flight, it isn't in the snapshot
        // that was just uploaded — stay dirty and send another.
        if (localStorage.getItem(K_DIRTY) !== dirtyAtSnapshot) {
            setState("pending");
            if (pushTimer) clearTimeout(pushTimer);
            pushTimer = setTimeout(() => { push(); }, PUSH_DEBOUNCE_MS);
            return true;
        }
        markClean();
        setState("synced");
        return true;
    }

    async function fetchMeta() {
        const res = await request("/meta", {headers: authHeaders()});
        if (!res || !res.ok) return null;
        return await res.json().catch(() => null);
    }

    // Replaces all local data with the cloud copy, then reloads so the page picks
    // it up — the same way importLocalData() does.
    async function pull() {
        if (!available || !isConfigured()) return false;
        setState("syncing");

        const res = await request("/profile", {headers: authHeaders()});
        if (!res) { setState("error", "Could not reach the sync server"); return false; }
        if (res.status === 404) {
            // Profile exists but has never been written to — push instead of pulling.
            setState("pending");
            return await push();
        }
        if (res.status === 401) { authFailed = true; setState("error", "Sync key was not accepted — reconnect to fix"); return false; }
        if (!res.ok) { setState("error", `Could not download profile (${res.status})`); return false; }

        try {
            const buffer = await res.arrayBuffer();
            const payload = JSON.parse(await gunzip(buffer));
            applying = true;
            applyLocalDataPayload(payload);
            applying = false;
            const rev = Number.parseInt(res.headers.get("X-Rev"), 10);
            if (Number.isInteger(rev)) setRev(rev);
            markClean();
            cloudRev = null;
            setState("synced");
        } catch (e) {
            applying = false;
            console.warn("Could not apply the downloaded profile.", e);
            setState("error", "Downloaded profile could not be read");
            return false;
        }

        // Local data has already rendered by now (boot doesn't wait on sync), so a
        // fresh copy only takes effect after a reload — same as a manual pull.
        window.setTimeout(() => window.location.reload(), 300);
        return true;
    }

    // ----------------------------------------------------------------------
    // Account actions
    // ----------------------------------------------------------------------

    async function setupNew() {
        setState("syncing");
        const res = await request("/new", {method: "POST"});
        if (!res || !res.ok) { setState("error", "Could not create a sync profile"); return; }
        const body = await res.json().catch(() => null);
        if (!body || !body.words) { setState("error", "Could not create a sync profile"); return; }

        localStorage.setItem(K_KEY, body.words);
        setRev(body.rev || 0);
        authFailed = false;
        panelMode = "new_key";
        await push();
        renderPanel();
    }

    async function connectExisting(words) {
        const cleaned = String(words || "").trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
        if (cleaned.split(" ").length !== 4) {
            setState("error", "Enter all four words");
            return;
        }
        const previousKey = getKey();
        const previousRev = getRev();
        localStorage.setItem(K_KEY, cleaned);
        setRev(0);
        authFailed = false;

        const meta = await fetchMeta();
        if (!meta) {
            // Put the old credential back rather than stranding the device.
            if (previousKey) { localStorage.setItem(K_KEY, previousKey); setRev(previousRev); }
            else { localStorage.removeItem(K_KEY); localStorage.removeItem(K_REV); }
            setState(previousKey ? "synced" : "off", "That sync key was not recognized");
            return;
        }
        panelMode = "connected";
        await pull();
    }

    async function disconnect() {
        const ok = await uiConfirm({
            title: "Stop syncing this device?",
            message: "Your schedules stay on this computer, and the cloud copy is left untouched.",
            confirmLabel: "Stop syncing"
        });
        if (!ok) return;
        localStorage.removeItem(K_KEY);
        localStorage.removeItem(K_REV);
        localStorage.removeItem(K_DIRTY);
        cloudRev = null;
        authFailed = false;
        panelMode = "setup";
        setState("off");
    }

    // ----------------------------------------------------------------------
    // Panel
    // ----------------------------------------------------------------------

    let panelMode = "setup"; // setup | new_key | connect | connected

    function panelHtml() {
        const key = getKey();

        if (panelMode === "new_key" && key) {
            return `
                <div class="p-3.5 space-y-3">
                    <div>
                        <div class="text-sm font-semibold text-slate-800 dark:text-slate-100">Save these four words</div>
                        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                            They are the only way to reach this profile from another device. There is no reset —
                            if they are lost, the synced data is unreachable.
                        </p>
                    </div>
                    <form id="sync_key_form" autocomplete="on" class="space-y-2">
                        <input type="text" name="username" value="Schedule Picker sync" autocomplete="username" class="hidden" readonly>
                        <input id="sync_key_field" name="password" type="password" value="${escapeAttr(key)}" autocomplete="new-password" readonly
                               class="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-sm font-mono tracking-wide text-slate-800 dark:text-slate-100">
                        <div class="flex items-center gap-1.5">
                            <button type="submit" class="btn-press flex-1 text-xs font-medium px-2.5 py-1.5 rounded-md bg-accent-600 text-white hover:bg-accent-700 transition-colors">Save to password manager</button>
                            <button type="button" id="sync_reveal" class="btn-press text-xs font-medium px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition-colors">Reveal</button>
                            <button type="button" id="sync_copy" class="btn-press text-xs font-medium px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition-colors">Copy</button>
                        </div>
                    </form>
                    <button type="button" id="sync_done" class="w-full text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors">I've saved them</button>
                </div>`;
        }

        if (panelMode === "connect") {
            return `
                <div class="p-3.5 space-y-3">
                    <div>
                        <div class="text-sm font-semibold text-slate-800 dark:text-slate-100">Connect an existing profile</div>
                        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                            Enter the four words from your other device. This replaces the schedules saved on this computer.
                        </p>
                    </div>
                    <form id="sync_connect_form" autocomplete="on" class="space-y-2">
                        <input type="text" name="username" value="Schedule Picker sync" autocomplete="username" class="hidden" readonly>
                        <input id="sync_connect_field" name="password" type="password" autocomplete="current-password" placeholder="four words"
                               class="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-sm font-mono text-slate-800 dark:text-slate-100 placeholder:text-slate-400">
                        <div class="flex items-center gap-1.5">
                            <button type="submit" class="btn-press flex-1 text-xs font-medium px-2.5 py-1.5 rounded-md bg-accent-600 text-white hover:bg-accent-700 transition-colors">Connect &amp; pull</button>
                            <button type="button" id="sync_cancel" class="btn-press text-xs font-medium px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition-colors">Cancel</button>
                        </div>
                    </form>
                    ${statusLineHtml()}
                </div>`;
        }

        if (key) {
            const conflict = state === "conflict";
            return `
                <div class="p-3.5 space-y-3">
                    <div class="flex items-start justify-between gap-2">
                        <div>
                            <div class="text-sm font-semibold text-slate-800 dark:text-slate-100">Cloud sync is on</div>
                            <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Changes save automatically.</p>
                        </div>
                    </div>
                    ${authFailed ? `
                    <div class="rounded-lg border border-rose-300 dark:border-rose-500/40 bg-rose-50 dark:bg-rose-500/10 p-2.5 space-y-2">
                        <p class="text-xs text-rose-800 dark:text-rose-200">
                            This device's sync words are no longer accepted, so changes aren't being saved
                            to the cloud. They're still safe on this computer.
                        </p>
                        <div class="flex items-center gap-1.5">
                            <button type="button" id="sync_reconnect" class="btn-press flex-1 text-xs font-medium px-2.5 py-1.5 rounded-md bg-rose-600 text-white hover:bg-rose-700 transition-colors">Enter different words</button>
                            <button type="button" id="sync_start_fresh" class="btn-press flex-1 text-xs font-medium px-2.5 py-1.5 rounded-md border border-rose-300 dark:border-rose-500/40 text-rose-800 dark:text-rose-200 hover:bg-rose-100 dark:hover:bg-rose-500/20 transition-colors">Start a new profile</button>
                        </div>
                    </div>` : ""}
                    ${conflict ? `
                    <div class="rounded-lg border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 p-2.5 space-y-2">
                        <p class="text-xs text-amber-800 dark:text-amber-200">
                            Another device saved newer data. Choose which copy to keep.
                        </p>
                        <div class="flex items-center gap-1.5">
                            <button type="button" id="sync_take_cloud" class="btn-press flex-1 text-xs font-medium px-2.5 py-1.5 rounded-md bg-amber-600 text-white hover:bg-amber-700 transition-colors">Use cloud version</button>
                            <button type="button" id="sync_take_local" class="btn-press flex-1 text-xs font-medium px-2.5 py-1.5 rounded-md border border-amber-300 dark:border-amber-500/40 text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-500/20 transition-colors">Keep this device's</button>
                        </div>
                    </div>` : ""}
                    <div class="flex items-center gap-1.5">
                        <button type="button" id="sync_now" class="btn-press flex-1 text-xs font-medium px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition-colors">Sync now</button>
                        <button type="button" id="sync_pull" class="btn-press flex-1 text-xs font-medium px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition-colors">Pull from cloud</button>
                    </div>
                    <div class="flex items-center justify-between gap-2 pt-0.5">
                        <button type="button" id="sync_show_key" class="text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors">Show my words</button>
                        <button type="button" id="sync_disconnect" class="text-xs font-medium text-slate-400 dark:text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 transition-colors">Disconnect</button>
                    </div>
                    ${statusLineHtml()}
                </div>`;
        }

        return `
            <div class="p-3.5 space-y-3">
                <div>
                    <div class="text-sm font-semibold text-slate-800 dark:text-slate-100">Cloud sync</div>
                    <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        Save your schedules to the cloud and open them on another device. You'll get four
                        words to keep in your password manager — no email or account needed.
                    </p>
                </div>
                <div class="flex items-center gap-1.5">
                    <button type="button" id="sync_setup" class="btn-press flex-1 text-xs font-medium px-2.5 py-1.5 rounded-md bg-accent-600 text-white hover:bg-accent-700 transition-colors">Set up sync</button>
                    <button type="button" id="sync_connect" class="btn-press flex-1 text-xs font-medium px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition-colors">I have words</button>
                </div>
                ${statusLineHtml()}
            </div>`;
    }

    function statusLineHtml() {
        if (!detail && state === "off") return "";
        const text = detail || DOT_LABELS[state] || "";
        if (!text) return "";
        const tone = (state === "error" || state === "conflict")
            ? "text-amber-600 dark:text-amber-400"
            : "text-slate-400 dark:text-slate-500";
        return `<div class="text-xs ${tone}" aria-live="polite">${escapeHtml(text)}</div>`;
    }

    function renderPanel() {
        const menu = document.getElementById("sync_menu");
        if (!menu || menu.classList.contains("hidden")) return;
        menu.innerHTML = panelHtml();
        wirePanel();
    }

    function on(id, event, handler) {
        const el = document.getElementById(id);
        if (el) el.addEventListener(event, handler);
    }

    function wirePanel() {
        on("sync_setup", "click", () => { setupNew(); });
        on("sync_connect", "click", () => { panelMode = "connect"; renderPanel(); });
        on("sync_cancel", "click", () => { panelMode = isConfigured() ? "connected" : "setup"; renderPanel(); });
        on("sync_done", "click", () => { panelMode = "connected"; renderPanel(); });
        on("sync_show_key", "click", () => { panelMode = "new_key"; renderPanel(); });
        on("sync_now", "click", () => { push(); });
        on("sync_disconnect", "click", disconnect);
        on("sync_reconnect", "click", () => { panelMode = "connect"; renderPanel(); });
        on("sync_start_fresh", "click", async () => {
            const ok = await uiConfirm({
                title: "Start a new profile?",
                message: "This device's schedules are kept and uploaded to the new profile. The old words stop being used here.",
                confirmLabel: "Start fresh"
            });
            if (!ok) return;
            localStorage.removeItem(K_KEY);
            localStorage.removeItem(K_REV);
            authFailed = false;
            setupNew();
        });

        on("sync_pull", "click", async () => {
            const ok = await uiConfirm({
                title: "Pull from cloud?",
                message: "This replaces the schedules, starred classes and filters on this computer with the cloud copy.",
                confirmLabel: "Pull",
                danger: true
            });
            if (!ok) return;
            pull();
        });
        on("sync_take_cloud", "click", async () => {
            const ok = await uiConfirm({
                title: "Use the cloud version?",
                message: "This device's data is replaced with the newer copy saved from another device.",
                confirmLabel: "Use cloud version",
                danger: true
            });
            if (!ok) return;
            pull();
        });
        on("sync_take_local", "click", async () => {
            const ok = await uiConfirm({
                title: "Overwrite the cloud copy?",
                message: "The other device's newer changes will be permanently lost.",
                confirmLabel: "Overwrite cloud",
                danger: true
            });
            if (!ok) return;
            push({force: true});
        });

        // A real submit is what prompts the browser to offer saving the words.
        on("sync_key_form", "submit", (e) => {
            e.preventDefault();
            setState(state, "Ask your password manager to save it if prompted");
        });
        on("sync_reveal", "click", () => {
            const f = document.getElementById("sync_key_field");
            const btn = document.getElementById("sync_reveal");
            if (!f) return;
            const shown = f.type === "text";
            f.type = shown ? "password" : "text";
            if (btn) btn.textContent = shown ? "Reveal" : "Hide";
        });
        on("sync_copy", "click", async () => {
            try {
                await navigator.clipboard.writeText(getKey());
                setState(state, "Copied to clipboard");
            } catch (e) {
                setState(state, "Could not copy — reveal and copy manually");
            }
        });
        on("sync_connect_form", "submit", (e) => {
            e.preventDefault();
            const f = document.getElementById("sync_connect_field");
            connectExisting(f ? f.value : "");
        });
    }

    function toggleMenu() {
        const menu = document.getElementById("sync_menu");
        const btn = document.getElementById("sync_btn");
        if (!menu) return;
        const open = menu.classList.toggle("hidden") === false;
        if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
        if (open) {
            panelMode = isConfigured() ? "connected" : "setup";
            renderPanel();
        }
    }

    function closeMenu() {
        const menu = document.getElementById("sync_menu");
        const btn = document.getElementById("sync_btn");
        if (menu && !menu.classList.contains("hidden")) {
            menu.classList.add("hidden");
            if (btn) btn.setAttribute("aria-expanded", "false");
        }
    }

    // ----------------------------------------------------------------------
    // Boot
    // ----------------------------------------------------------------------

    // Runs before loadConfig(). Must never delay startup beyond the health timeout,
    // and must never throw — a missing API is a normal, silent outcome.
    async function probe() {
        const res = await request("/health", {}, HEALTH_TIMEOUT_MS);
        if (!res || !res.ok) return false;
        const health = await res.json().catch(() => null);
        if (!health || !health.ok) return false;
        available = true;
        revealUi();
        return true;
    }

    async function init() {
        try {
            if (!apiBase()) return;

            // Someone who has never set up sync should not wait on a network probe
            // to see their schedule — an unreachable API can take seconds to fail.
            // Probe in the background and reveal the button only if one answers.
            if (!isConfigured()) {
                probe().then(ok => { if (ok) setState("off"); }).catch(() => {});
                return;
            }

            // Runs in the background — boot no longer waits on it. By the time this
            // resolves the app has already rendered from local data, so adopting a
            // newer cloud copy means reloading, the same as a manual pull.
            if (!await probe()) return;

            const meta = await fetchMeta();
            if (!meta) { setState("error", "Sync key was not accepted"); return; }

            if (meta.rev === getRev()) {
                setState(isDirty() ? "pending" : "synced");
            } else if (meta.rev > getRev()) {
                if (isDirty()) {
                    // Both sides changed — let the user choose rather than guessing.
                    cloudRev = meta.rev;
                    setState("conflict", "Another device saved newer data");
                } else {
                    await pull();
                }
            } else {
                // Local is ahead of the cloud (e.g. an earlier push never landed).
                setState("pending");
                markDirty();
            }
        } catch (e) {
            console.warn("Cloud sync unavailable.", e);
        }
    }

    // Wired from propagateWebpage(), once the header exists.
    function initUi() {
        on("sync_btn", "click", (e) => { e.stopPropagation(); toggleMenu(); });
        // Capture phase on purpose: panel buttons re-render the panel, which detaches
        // the node that was clicked. By the bubble phase that node is no longer inside
        // the menu, so a bubble-phase check would read its own re-render as an
        // outside click and close the panel.
        document.addEventListener("click", (e) => {
            const menu = document.getElementById("sync_menu");
            const btn = document.getElementById("sync_btn");
            if (!menu || menu.classList.contains("hidden")) return;
            if (menu.contains(e.target) || (btn && btn.contains(e.target))) return;
            closeMenu();
        }, true);

        // Last chance to persist before the page goes away.
        const flush = () => {
            if (!available || !isConfigured() || !isDirty() || applying) return;
            if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
            push();
        };
        window.addEventListener("pagehide", flush);
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "hidden") flush();
        });

        setState(state);
    }

    return {init, initUi, markDirty, push, pull, isApplying: () => applying};
})();

window.SyncClient = SyncClient;
