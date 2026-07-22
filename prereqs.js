// ---------------------------------------------------------------------------
// Prereq Explorer — client-side, static. Renders a bidirectional prerequisite
// graph for a searched course using the (optional) L2 catalog data.
//
// L2 data is OPTIONAL: the L2 file may be absent (it is gated / not committed),
// in which case the page degrades gracefully to an "unavailable" state.
// ---------------------------------------------------------------------------

(function () {
    "use strict";

    // ---- geometry ---------------------------------------------------------
    const NODE_W = 234, NODE_H = 66;   // wider + taller so titles get two lines
    const COL_PITCH = 300;   // horizontal distance between column lefts
    const ROW_PITCH = 84;    // vertical distance between stacked nodes
    const MAX_NODES = 160;   // safety cap for the rendered subgraph
    const BREADTH_CAP = 48;  // max children added per node during BFS

    // ---- state ------------------------------------------------------------
    let classfilesData = {};
    let candidates = [];             // [{school, term, l2path}]
    let curSchool = "", curTerm = "";
    const graphCache = new Map();    // "school|term" -> built graph model
    let model = null;                // active { index, prereqCodesOf, dependentsOf, edgeKind, codeTitle }
    let focusCode = null;
    let upDepth = 2, downDepth = 1;
    let showRelated = false;   // include sibling/cousin courses (full neighborhood)

    // pan/zoom
    let tx = 0, ty = 0, scale = 1;

    // ---- element refs -----------------------------------------------------
    const $ = id => document.getElementById(id);
    const svg = $("graph_svg");
    const viewport = $("graph_viewport");
    const tipEl = $("floating-tip");

    // =======================================================================
    // Theming (mirror the schedule page so the accent matches per school)
    // =======================================================================
    const ACCENT_PALETTES = {
        red: ["oklch(0.971 0.013 17.4)", "oklch(0.936 0.032 17.7)", "oklch(0.885 0.062 18.3)",
            "oklch(0.808 0.108 19.6)", "oklch(0.704 0.176 22.2)", "oklch(0.637 0.222 25.3)",
            "oklch(0.577 0.226 27.3)", "oklch(0.505 0.213 27.5)"],
        blue: ["oklch(0.97 0.014 254)", "oklch(0.932 0.032 255)", "oklch(0.882 0.059 254)",
            "oklch(0.809 0.105 252)", "oklch(0.707 0.165 254)", "oklch(0.623 0.214 259)",
            "oklch(0.546 0.215 263)", "oklch(0.488 0.192 264)"],
        emerald: ["oklch(0.979 0.021 166)", "oklch(0.95 0.052 163)", "oklch(0.905 0.093 164)",
            "oklch(0.845 0.143 164)", "oklch(0.765 0.177 163)", "oklch(0.696 0.17 162)",
            "oklch(0.596 0.145 163)", "oklch(0.508 0.118 165)"],
        violet: ["oklch(0.969 0.016 293)", "oklch(0.943 0.029 294)", "oklch(0.894 0.057 293)",
            "oklch(0.811 0.111 293)", "oklch(0.711 0.166 294)", "oklch(0.606 0.25 292)",
            "oklch(0.541 0.281 293)", "oklch(0.491 0.27 293)"]
    };

    function readConfig() {
        try {
            const stored = localStorage.getItem("config");
            if (!stored) return {};
            return JSON.parse(decodeURIComponent(escape(atob(stored)))) || {};
        } catch (e) { return {}; }
    }

    function applyAccent(school) {
        const cfg = readConfig();
        const name = (cfg.school_accents && cfg.school_accents[school]) || "red";
        const palette = ACCENT_PALETTES[name] || ACCENT_PALETTES.red;
        const steps = [50, 100, 200, 300, 400, 500, 600, 700];
        steps.forEach((step, i) => document.documentElement.style.setProperty(`--accent-${step}`, palette[i]));
    }

    $("theme_toggle").addEventListener("click", () => {
        const isDark = document.documentElement.classList.toggle("dark");
        localStorage.setItem("theme", isDark ? "dark" : "light");
    });

    // =======================================================================
    // Term-slug helpers (same conventions as the schedule page)
    // =======================================================================
    function termDisplayName(slug) {
        return String(slug).split("-").map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
    }
    function termSortKey(slug) {
        const parts = String(slug).split("-");
        const year = parseInt(parts[parts.length - 1], 10) || 0;
        const s = { spring: 1, summer: 2, fall: 3 }[parts[0]] || 0;
        return year * 10 + s;
    }

    // =======================================================================
    // Escaping
    // =======================================================================
    function escapeHtml(str) {
        return String(str == null ? "" : str)
            .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    }
    function escapeAttr(str) {
        return String(str == null ? "" : str)
            .replaceAll("&", "&amp;").replaceAll('"', "&quot;")
            .replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\n", " ");
    }

    // =======================================================================
    // Bootstrap: discover which school|term have L2 data
    // =======================================================================
    fetch("./classfiles.json", { cache: "no-store" }).then(r => r.json()).then(cfd => {
        classfilesData = cfd;
        candidates = [];
        for (const [school, entry] of Object.entries(cfd)) {
            // A school participates if it has prerequisite DATA — either in a separate L2
            // file ("_l2": { term: path }, e.g. WashU) or inline in its base catalog when it
            // flags "_prereqs": true (e.g. CWRU's single-file guest scrape). No format-name
            // check: any school that provides the data shows up.
            const l2meta = (entry._l2 && typeof entry._l2 === "object" && !Array.isArray(entry._l2)) ? entry._l2 : null;
            const inlinePrereqs = entry._prereqs === true;
            if (!l2meta && !inlinePrereqs) continue;
            for (const [term, path] of Object.entries(entry)) {
                if (term.startsWith("_")) continue;
                const dataPath = (l2meta && l2meta[term]) || (inlinePrereqs ? path : null);
                if (typeof dataPath !== "string" || !dataPath) continue;
                candidates.push({ school, term, l2path: dataPath });
            }
        }
        candidates.sort((a, b) =>
            a.school === b.school ? termSortKey(b.term) - termSortKey(a.term) : a.school.localeCompare(b.school));

        if (!candidates.length) {
            showState("No prerequisite data", "No school in this deployment provides L2 prerequisite data.");
            return;
        }
        buildSchoolTermNav();
        const first = candidates[0];
        selectSchoolTerm(first.school, first.term);
    }).catch(() => showState("Couldn’t load catalog", "Failed to read classfiles.json."));

    // =======================================================================
    // School / term navigation dropdowns
    // =======================================================================
    function buildSchoolTermNav() {
        const schools = [...new Set(candidates.map(c => c.school))];
        wireMenu("school_btn", "school_menu", schools, s => s, s => {
            const term = candidates.filter(c => c.school === s)[0].term;
            selectSchoolTerm(s, term);
        });
        refreshTermMenu();
    }

    function refreshTermMenu() {
        const terms = candidates.filter(c => c.school === curSchool).map(c => c.term);
        wireMenu("term_btn", "term_menu", terms, termDisplayName, t => selectSchoolTerm(curSchool, t));
    }

    function wireMenu(btnId, menuId, items, labelFn, onPick) {
        const btn = $(btnId), menu = $(menuId);
        menu.innerHTML = items.map(it =>
            `<button class="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap" data-val="${escapeAttr(it)}" type="button">${escapeHtml(labelFn(it))}</button>`
        ).join("");
        btn.onclick = e => {
            e.stopPropagation();
            document.querySelectorAll("#school_menu, #term_menu").forEach(m => { if (m !== menu) m.classList.add("hidden"); });
            menu.classList.toggle("hidden");
        };
        menu.querySelectorAll("button").forEach(b => b.onclick = () => {
            menu.classList.add("hidden");
            onPick(b.dataset.val);
        });
    }
    document.addEventListener("click", () =>
        document.querySelectorAll("#school_menu, #term_menu").forEach(m => m.classList.add("hidden")));

    // =======================================================================
    // Load + build a school|term graph model
    // =======================================================================
    async function selectSchoolTerm(school, term) {
        curSchool = school; curTerm = term;
        $("school_label").textContent = school;
        $("term_label").textContent = termDisplayName(term);
        applyAccent(school);
        refreshTermMenu();

        const key = school + "|" + term;
        focusCode = null;
        clearGraph();
        showFocusDetail(null);
        setSearch("");

        if (graphCache.has(key)) {
            model = graphCache.get(key);
            onModelReady();
            return;
        }

        model = null;
        showState("Loading course data…", "");
        $("status_line").textContent = "";
        const cand = candidates.find(c => c.school === school && c.term === term);
        let raw;
        try {
            const r = await fetch("./" + cand.l2path);
            if (!r.ok) throw new Error("404");
            raw = await r.json();
        } catch (e) {
            showState("Prerequisite data unavailable",
                `L2 data for ${escapeHtml(school)} ${escapeHtml(termDisplayName(term))} isn’t available in this deployment.`);
            return;
        }
        // Only rebuild if the user hasn't navigated away while fetching.
        if (curSchool !== school || curTerm !== term) return;
        const built = buildModel(raw);
        graphCache.set(key, built);
        model = built;
        onModelReady();
    }

    function onModelReady() {
        const n = model.index.size;
        const withPre = [...model.index.values()].filter(c => c.prereqGroups.length).length;
        $("status_line").textContent = `${n.toLocaleString()} courses · ${withPre.toLocaleString()} with prerequisites`;
        // Honor a deep-link (#CODE), else show the empty prompt.
        const hashCode = decodeURIComponent((location.hash || "").replace(/^#/, "")).toUpperCase().trim();
        if (hashCode && model.index.has(hashCode)) {
            setFocus(hashCode, false);
        } else {
            showState("Search a course to begin",
                "Type in the sidebar — see its prerequisites on the left and what it unlocks on the right.");
        }
    }

    // ---- model construction ----------------------------------------------
    function codeOf(course) { return course ? String(course).split(" - ")[0].trim() : ""; }
    function titleOf(course) {
        const p = String(course || "").split(" - ");
        return p.length > 1 ? p.slice(1).join(" - ").trim() : "";
    }

    // ---- text fallback for prerequisites ---------------------------------
    // Some sections have no structured `coursePrereqs` (the scraper's rule tree
    // was empty) but the human-readable `eligibility` text still names courses,
    // e.g. "Student has completed all of the following course(s): MATH 1520 -
    // Calculus II". We parse those into the same {op, inProgress, courses} groups.
    // Course entries are always formatted "CODE - Title", so we anchor on " - ".
    const CODE_RE = /\b([A-Z][A-Z&]{1,7}(?:\s[A-Z]{1,4})?)\s(\d{2,4}[A-Z]?)\s-\s([^\[\]\n]*?)(?=,\s*[A-Z][A-Z&]{1,7}(?:\s[A-Z]{1,4})?\s\d|\]|$)/g;
    const CLAUSE_RE = /(all|any)\s+of the following course\(s\)\s*:(.*)$/is;
    const OUTER_RE = /satisfied\s+(all|any)\s+of the following/i;
    const BRACKET_RE = /\[[^\]]*\]/g;

    // Pull "CODE - Title" pairs out of a text fragment; also records titles.
    function extractCourses(fragment, codeTitle) {
        const out = [];
        let m;
        CODE_RE.lastIndex = 0;
        while ((m = CODE_RE.exec(fragment))) {
            const code = m[1].replace(/\s+/g, " ").trim() + " " + m[2];
            if (!out.includes(code)) out.push(code);
            const title = (m[3] || "").trim();
            if (codeTitle && title && !codeTitle.has(code)) codeTitle.set(code, title);
        }
        return out;
    }

    function parseClause(clause, codeTitle) {
        const m = CLAUSE_RE.exec(clause);
        if (!m) return null;
        const op = m[1].toLowerCase() === "any" ? "any" : "all";
        const inProgress = /in process of completing/i.test(clause);
        const courses = extractCourses(m[2], codeTitle);
        return courses.length ? { op, inProgress, courses } : null;
    }

    // Returns [{op, inProgress, courses}]. `selfCode` is dropped (a course that
    // lists itself, e.g. an internship's own permission line, is not a prereq).
    function parseEligibilityText(text, selfCode, codeTitle) {
        if (!text) return [];
        const outer = OUTER_RE.exec(text);
        const brackets = text.match(BRACKET_RE);
        const clauses = brackets && brackets.length ? brackets.map(b => b.slice(1, -1)) : [text];
        let parsed = clauses.map(c => parseClause(c, codeTitle)).filter(Boolean);
        // "satisfied ANY of the following [clause][clause]" = OR across clauses;
        // collapse to one alternatives group so we don't mark them all required.
        if (outer && outer[1].toLowerCase() === "any" && parsed.length > 1) {
            const courses = [];
            for (const g of parsed) for (const c of g.courses) if (!courses.includes(c)) courses.push(c);
            parsed = [{ op: "any", inProgress: parsed.some(g => g.inProgress), courses }];
        }
        // Drop self-references, then any now-empty groups.
        return parsed
            .map(g => ({ ...g, courses: g.courses.filter(c => c !== selfCode) }))
            .filter(g => g.courses.length);
    }

    function buildModel(raw) {
        const index = new Map();      // code -> course entry
        const codeTitle = new Map();  // code -> title (incl. non-offered courses seen in trees)

        // Walk a parsed eligibility tree to harvest {code -> title} for courses
        // that may not themselves be offered this term.
        function harvestTitles(node) {
            if (!node || typeof node !== "object") return;
            if (node.type === "course" && Array.isArray(node.courses)) {
                for (const c of node.courses) if (c && c.code && !codeTitle.has(c.code)) codeTitle.set(c.code, c.title || "");
            }
            if (Array.isArray(node.kids)) node.kids.forEach(harvestTitles);
        }

        const values = Object.values(raw).filter(v => v && typeof v === "object" && v.course);
        for (const v of values) {
            const code = codeOf(v.course);
            if (!code) continue;
            const ep = v.eligibility_parsed || {};
            harvestTitles(ep.tree);
            const elig = ep.text || v.eligibility || "";
            // Field names differ between an L2 record (WashU) and an inline catalog record
            // (CWRU): read either. CWRU keeps the title in its own field and the code in
            // `course`; WashU joins them as "CODE - Title".
            const title = v.title || titleOf(v.course);
            const creditsRaw = v.credit_hours || v.credits || v.units || "";
            const creditsNum = parseFloat(creditsRaw);
            const credits = Number.isNaN(creditsNum) ? String(creditsRaw) : String(creditsNum); // "3.00" → "3"
            const format = v.instructional_format || v.component || "";
            const delivery = v.delivery_mode || v.delivery || "";
            const seats = v.seats_available || (typeof v.open_seats === "number" ? `${v.open_seats} open` : "");
            // Prefer the scraper's structured prereqs; fall back to parsing the text.
            const structured = (ep.coursePrereqs || []).length > 0;
            const groups = structured
                ? ep.coursePrereqs
                    .map(g => ({ op: g.op || "all", inProgress: !!g.inProgress, courses: (g.courses || []).slice() }))
                    .filter(g => g.courses.length)
                : parseEligibilityText(elig, code, codeTitle);

            let e = index.get(code);
            if (!e) {
                e = {
                    code,
                    title,
                    credits,
                    format,
                    delivery,
                    campus: v.campus || "",
                    status: v.status || "",
                    seats,
                    description: v.description || "",
                    eligibility: elig,
                    prereqGroups: groups,
                    _structured: structured,
                    sections: 0
                };
                index.set(code, e);
            } else {
                // Merge: prefer the section that carries the richest data.
                if (!e.description && v.description) e.description = v.description;
                if (!e.eligibility && elig) e.eligibility = elig;
                if (!e.credits && credits) e.credits = credits;
                // Structured prereqs always beat text-derived ones; otherwise keep the fuller set.
                if ((structured && !e._structured) ||
                    (structured === e._structured && groups.length > e.prereqGroups.length)) {
                    e.prereqGroups = groups;
                    e._structured = structured;
                }
            }
            e.sections++;
        }
        for (const [code, e] of index) if (!codeTitle.has(code)) codeTitle.set(code, e.title);

        // Forward (course -> prereqs) and reverse (prereq -> dependents) graphs.
        const prereqCodesOf = new Map();   // code -> [prereqCode]
        const dependentsOf = new Map();    // code -> [dependentCode]
        const edgeKind = new Map();        // "dep>pre" -> 'req' | 'alt'
        const addUniq = (map, k, v) => {
            let arr = map.get(k); if (!arr) { arr = []; map.set(k, arr); }
            if (!arr.includes(v)) arr.push(v);
        };
        for (const [code, e] of index) {
            for (const g of e.prereqGroups) {
                // Only an "any"-of group with real alternatives is a dashed "one of".
                // An "all"-of group (even with multiple courses) is all required.
                const kind = (g.op === "any" && g.courses.length > 1) ? "alt" : "req";
                for (const p of g.courses) {
                    addUniq(prereqCodesOf, code, p);
                    addUniq(dependentsOf, p, code);
                    const key = code + ">" + p;
                    // 'req' wins over 'alt' if the same pair appears in multiple groups.
                    if (kind === "req" || !edgeKind.has(key)) edgeKind.set(key, kind);
                }
            }
        }
        return { index, codeTitle, prereqCodesOf, dependentsOf, edgeKind };
    }

    // =======================================================================
    // Search (simple, not fuzzy — substring / token match on code + title)
    // =======================================================================
    const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const searchInput = $("course_search");
    const searchClear = $("search_clear");

    function setSearch(v) {
        searchInput.value = v;
        searchClear.classList.toggle("hidden", !v);
        renderSearch(v);
    }

    searchInput.addEventListener("input", () => {
        searchClear.classList.toggle("hidden", !searchInput.value);
        renderSearch(searchInput.value);
    });
    searchClear.addEventListener("click", () => { setSearch(""); searchInput.focus(); });
    searchInput.addEventListener("keydown", e => {
        if (e.key === "Enter") {
            const first = $("search_results").querySelector("[data-code]");
            if (first) setFocus(first.dataset.code);
        } else if (e.key === "Escape") { setSearch(""); }
    });

    function searchCourses(query) {
        if (!model) return [];
        const q = query.trim().toLowerCase();
        if (!q) return [];
        const nq = norm(q);
        const tokens = q.split(/\s+/).filter(Boolean);
        const out = [];
        for (const e of model.index.values()) {
            const code = e.code.toLowerCase(), title = (e.title || "").toLowerCase();
            const hay = code + " " + title;
            const normHay = norm(e.code) + norm(e.title);
            let score;
            if (norm(e.code).startsWith(nq)) score = 0;
            else if (norm(e.code).includes(nq)) score = 1;
            else if (title.startsWith(q)) score = 2;
            else if (tokens.every(t => hay.includes(t))) score = 3;
            else if (normHay.includes(nq)) score = 4;
            else continue;
            out.push({ e, score });
        }
        out.sort((a, b) => a.score - b.score || a.e.code.localeCompare(b.e.code, undefined, { numeric: true }));
        return out.slice(0, 50).map(o => o.e);
    }

    function renderSearch(query) {
        const box = $("search_results");
        const hint = $("sidebar_hint");
        const detail = $("focus_detail");
        if (!query.trim()) {
            box.classList.add("hidden");
            box.innerHTML = "";
            // Fall back to focus detail (if any) or hint.
            detail.classList.toggle("hidden", !focusCode);
            hint.classList.toggle("hidden", !!focusCode);
            return;
        }
        detail.classList.add("hidden");
        hint.classList.add("hidden");
        box.classList.remove("hidden");
        const results = searchCourses(query);
        if (!results.length) {
            box.innerHTML = `<div class="p-4 text-sm text-slate-400 text-center">No matching course.</div>`;
            return;
        }
        box.innerHTML = results.map(e => {
            const nPre = (model.prereqCodesOf.get(e.code) || []).length;
            const nDep = (model.dependentsOf.get(e.code) || []).length;
            const meta = [nPre ? `${nPre} prereq${nPre > 1 ? "s" : ""}` : "", nDep ? `${nDep} unlock${nDep > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");
            return `<button class="w-full text-left px-3 py-2 border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors block" data-code="${escapeAttr(e.code)}" data-tip-code="${escapeAttr(e.code)}" type="button">
                <div class="flex items-baseline gap-2">
                    <span class="font-mono text-xs font-semibold text-accent-600 dark:text-accent-400 shrink-0">${escapeHtml(e.code)}</span>
                    <span class="text-sm text-slate-700 dark:text-slate-200 truncate">${escapeHtml(e.title)}</span>
                </div>
                ${meta ? `<div class="text-[11px] text-slate-400 mt-0.5">${escapeHtml(meta)}</div>` : ""}
            </button>`;
        }).join("");
        box.querySelectorAll("[data-code]").forEach(b => {
            b.addEventListener("click", () => setFocus(b.dataset.code));
            attachTip(b);
        });
    }

    // =======================================================================
    // Focus a course: sidebar detail + graph
    // =======================================================================
    function setFocus(code, pushHash = true) {
        if (!model || !model.index.has(code)) return;
        focusCode = code;
        setSearch("");                     // collapse the result list
        showFocusDetail(code);
        renderGraph();
        if (pushHash && location.hash.replace(/^#/, "") !== code) {
            history.replaceState(null, "", "#" + encodeURIComponent(code));
        }
    }

    window.addEventListener("hashchange", () => {
        const code = decodeURIComponent((location.hash || "").replace(/^#/, "")).toUpperCase().trim();
        if (code && model && model.index.has(code) && code !== focusCode) setFocus(code, false);
    });

    function chip(code, clickable) {
        const offered = model.index.has(code);
        const title = offered ? model.index.get(code).title : (model.codeTitle.get(code) || "");
        const cls = clickable && offered
            ? "hover:border-accent-400 hover:text-accent-600 dark:hover:text-accent-400 cursor-pointer"
            : "opacity-70 cursor-default";
        return `<button ${offered ? "" : "disabled"} data-code="${escapeAttr(code)}" data-tip-code="${escapeAttr(code)}" type="button"
            class="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-1.5 py-0.5 text-xs font-mono transition-colors ${cls}">
            <span class="font-semibold">${escapeHtml(code)}</span>
            ${title ? `<span class="font-sans text-slate-400 max-w-[9rem] truncate">${escapeHtml(title)}</span>` : ""}
        </button>`;
    }

    function showFocusDetail(code) {
        const box = $("focus_detail");
        $("depth_controls").classList.toggle("hidden", !code);
        if (!code) { box.classList.add("hidden"); box.innerHTML = ""; return; }
        const e = model.index.get(code);
        const groups = e.prereqGroups;
        const deps = (model.dependentsOf.get(code) || []).slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

        const metaBits = [e.credits, e.format, e.delivery].filter(Boolean).map(escapeHtml).join(" · ");

        let prereqHtml;
        if (!groups.length) {
            prereqHtml = `<p class="text-xs text-slate-400">No course prerequisites listed.</p>`;
        } else {
            prereqHtml = groups.map(g => {
                // "any" of several = pick one (dashed box). "all" (even multiple) = all required.
                if (g.op === "any" && g.courses.length > 1) {
                    return `<div class="rounded-lg border border-dashed border-slate-200 dark:border-slate-700 p-1.5">
                        <div class="text-[10px] uppercase tracking-wide text-slate-400 mb-1">One of${g.inProgress ? " (may be in progress)" : ""}</div>
                        <div class="flex flex-wrap gap-1">${g.courses.map(c => chip(c, true)).join("")}</div>
                    </div>`;
                }
                return `<div class="flex flex-wrap gap-1">${g.courses.map(c => chip(c, true)).join("")}</div>`;
            }).join("");
        }

        const depsShown = deps.slice(0, 40);
        const depsHtml = deps.length
            ? `<div class="flex flex-wrap gap-1">${depsShown.map(c => chip(c, true)).join("")}${deps.length > depsShown.length ? `<span class="text-xs text-slate-400 self-center">+${deps.length - depsShown.length} more</span>` : ""}</div>`
            : `<p class="text-xs text-slate-400">Nothing in this term lists ${escapeHtml(code)} as a prerequisite.</p>`;

        const nonCourseElig = e.eligibility && !groups.length ? e.eligibility : "";

        box.classList.remove("hidden");
        box.innerHTML = `
            <div class="p-3 space-y-3">
                <div>
                    <div class="font-mono text-sm font-bold text-accent-600 dark:text-accent-400">${escapeHtml(e.code)}</div>
                    <div class="text-sm font-semibold text-slate-800 dark:text-slate-100 leading-snug">${escapeHtml(e.title)}</div>
                    ${metaBits ? `<div class="text-[11px] text-slate-400 mt-0.5">${metaBits}</div>` : ""}
                </div>
                ${e.description ? `<details class="group">
                    <summary class="text-xs text-slate-500 dark:text-slate-400 cursor-pointer select-none hover:text-slate-700 dark:hover:text-slate-200">Description</summary>
                    <p class="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">${escapeHtml(e.description)}</p>
                </details>` : ""}
                <div>
                    <div class="flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                        <span class="inline-block h-2 w-2 rounded-full bg-sky-500"></span> Requires
                    </div>
                    <div class="space-y-1.5">${prereqHtml}</div>
                    ${nonCourseElig ? `<details class="mt-1.5"><summary class="text-[11px] text-slate-400 cursor-pointer">Full requirement text</summary><p class="mt-1 text-[11px] text-slate-400 whitespace-pre-line">${escapeHtml(nonCourseElig)}</p></details>` : ""}
                </div>
                <div>
                    <div class="flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                        <span class="inline-block h-2 w-2 rounded-full bg-emerald-500"></span> Unlocks ${deps.length ? `<span class="font-normal text-slate-400">(${deps.length})</span>` : ""}
                    </div>
                    ${depsHtml}
                </div>
            </div>`;
        box.querySelectorAll("[data-code]").forEach(b => {
            if (!b.disabled) b.addEventListener("click", () => setFocus(b.dataset.code));
            attachTip(b);
        });
    }

    // =======================================================================
    // Subgraph computation + layout
    // =======================================================================
    // Collect the neighborhood of `focus` (nodes only). Directional depth limits
    // how far we walk prereqs (up) and dependents (down); `related` adds one extra
    // ring in both directions off every node (siblings/cousins) for a big picture.
    function computeSubgraph(focus, up, down, related) {
        const nodeSet = new Set([focus]);
        const add = c => (nodeSet.size < MAX_NODES && !nodeSet.has(c)) ? (nodeSet.add(c), true) : false;

        let frontier = [focus];
        for (let d = 1; d <= up && nodeSet.size < MAX_NODES; d++) {
            const next = [];
            for (const c of frontier)
                for (const p of (model.prereqCodesOf.get(c) || []).slice(0, BREADTH_CAP))
                    if (add(p)) next.push(p);
            frontier = next;
        }
        frontier = [focus];
        for (let d = 1; d <= down && nodeSet.size < MAX_NODES; d++) {
            const next = [];
            for (const c of frontier)
                for (const dep of (model.dependentsOf.get(c) || []).slice(0, BREADTH_CAP))
                    if (add(dep)) next.push(dep);
            frontier = next;
        }
        if (related) {
            for (const c of [...nodeSet]) {
                if (nodeSet.size >= MAX_NODES) break;
                for (const p of (model.prereqCodesOf.get(c) || []).slice(0, BREADTH_CAP)) add(p);
                for (const dep of (model.dependentsOf.get(c) || []).slice(0, BREADTH_CAP)) add(dep);
            }
        }
        // Directed edges (from = prereq, to = dependent) among placed nodes.
        const edges = [];
        for (const c of nodeSet)
            for (const p of (model.prereqCodesOf.get(c) || []))
                if (nodeSet.has(p))
                    edges.push({ from: p, to: c, kind: model.edgeKind.get(c + ">" + p) || "req" });
        return { nodeSet, edges };
    }

    // Layered DAG layout (Sugiyama-style). Prereqs are not linear — corequisites,
    // shared prereqs and cross-listings make the graph a DAG, not a tree. We assign
    // each node a LAYER so that every prereq→dependent edge points strictly forward
    // (left→right): no backward or same-column edges. Steps: break cycles, longest-
    // path layering, barycenter crossing reduction, then grid coordinates.
    function layout(sub, focus) {
        const nodesArr = [...sub.nodeSet];
        const edges = sub.edges;

        const outE = new Map(nodesArr.map(c => [c, []]));  // prereq -> dependents
        const inE = new Map(nodesArr.map(c => [c, []]));   // dependent -> prereqs
        const adj = new Map(nodesArr.map(c => [c, new Set()]));
        for (const e of edges) {
            outE.get(e.from).push(e.to);
            inE.get(e.to).push(e.from);
            adj.get(e.from).add(e.to);
            adj.get(e.to).add(e.from);
        }

        // Break cycles: iterative DFS marks back edges (to a node still on the stack).
        const reversed = new Set();
        const state = new Map();  // 1 = on stack, 2 = done
        for (const start of nodesArr) {
            if (state.get(start)) continue;
            const stack = [[start, 0]];
            state.set(start, 1);
            while (stack.length) {
                const top = stack[stack.length - 1];
                const kids = outE.get(top[0]);
                if (top[1] < kids.length) {
                    const v = kids[top[1]++];
                    const st = state.get(v) || 0;
                    if (st === 1) reversed.add(top[0] + ">" + v);
                    else if (st === 0) { state.set(v, 1); stack.push([v, 0]); }
                } else { state.set(top[0], 2); stack.pop(); }
            }
        }

        // Longest-path layering (Kahn) over the acyclic edge set.
        const fwd = new Map(nodesArr.map(c => [c, []]));
        const indeg = new Map(nodesArr.map(c => [c, 0]));
        for (const e of edges) {
            if (reversed.has(e.from + ">" + e.to)) continue;
            fwd.get(e.from).push(e.to);
            indeg.set(e.to, indeg.get(e.to) + 1);
        }
        const layerOf = new Map();
        const indegT = new Map(indeg);
        const queue = [];
        for (const c of nodesArr) if (indegT.get(c) === 0) { layerOf.set(c, 0); queue.push(c); }
        while (queue.length) {
            const u = queue.shift(), lu = layerOf.get(u) || 0;
            for (const v of fwd.get(u)) {
                layerOf.set(v, Math.max(layerOf.has(v) ? layerOf.get(v) : 0, lu + 1));
                indegT.set(v, indegT.get(v) - 1);
                if (indegT.get(v) === 0) queue.push(v);
            }
        }
        for (const c of nodesArr) if (!layerOf.has(c)) layerOf.set(c, 0);

        // Colour by relationship to focus: ancestor = prereq, descendant = unlock,
        // anything else (siblings/cousins in related mode) = neutral.
        const reach = (start, nbr) => {
            const seen = new Set(), st = [start];
            while (st.length) { const u = st.pop(); for (const v of nbr.get(u) || []) if (!seen.has(v)) { seen.add(v); st.push(v); } }
            return seen;
        };
        const descendants = reach(focus, outE);
        const ancestors = reach(focus, inE);
        const kindOf = c => c === focus ? "focus" : ancestors.has(c) ? "pre" : descendants.has(c) ? "dep" : "other";

        // Order nodes within each layer to reduce crossings (barycenter sweeps on the
        // normalized index of neighbors in adjacent layers).
        const layers = [...new Set(nodesArr.map(c => layerOf.get(c)))].sort((a, b) => a - b);
        const order = new Map(layers.map(l => [l, []]));
        for (const c of nodesArr) order.get(layerOf.get(c)).push(c);
        for (const l of layers) order.get(l).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

        const idx = new Map();
        const reindex = () => { for (const l of layers) order.get(l).forEach((c, i) => idx.set(c, i)); };
        reindex();
        const norm = c => { const s = order.get(layerOf.get(c)).length; return s <= 1 ? 0.5 : idx.get(c) / (s - 1); };
        for (let iter = 0; iter < 4; iter++) {
            for (const l of (iter % 2 ? [...layers].reverse() : layers)) {
                const arr = order.get(l);
                const bary = new Map(arr.map((c, i) => {
                    const ns = [...adj.get(c)];
                    const v = ns.map(norm);
                    return [c, v.length ? v.reduce((a, b) => a + b, 0) / v.length : (arr.length <= 1 ? 0.5 : i / (arr.length - 1))];
                }));
                arr.sort((a, b) => (bary.get(a) - bary.get(b)) || 0);
                reindex();
            }
        }

        // Grid-wrap tall layers, then place left→right (layer order) with columns of
        // sub-columns so a hub fills the width instead of one unreadably tall column.
        const SUBCOL_PITCH = NODE_W + 26, LEVEL_GAP = 110;
        const targetRows = Math.max(5, Math.floor(((viewport.clientHeight || 700) - 100) / ROW_PITCH));
        const meta = new Map();
        for (const l of layers) {
            const n = order.get(l).length;
            const subCount = Math.max(1, Math.ceil(n / targetRows));
            meta.set(l, { rowsPerSub: Math.ceil(n / subCount), width: subCount * SUBCOL_PITCH });
        }
        const baseX = new Map();
        let cur = 0;
        for (const l of layers) { baseX.set(l, cur); cur += meta.get(l).width + LEVEL_GAP; }

        const nodes = new Map();
        for (const l of layers) {
            const arr = order.get(l);
            const { rowsPerSub } = meta.get(l);
            const rows = Math.min(rowsPerSub, arr.length);
            const startY = -(rows * ROW_PITCH - (ROW_PITCH - NODE_H)) / 2;
            arr.forEach((code, i) => {
                nodes.set(code, {
                    code, level: l,
                    x: baseX.get(l) + Math.floor(i / rowsPerSub) * SUBCOL_PITCH,
                    y: startY + (i % rowsPerSub) * ROW_PITCH,
                    kind: kindOf(code),
                    offered: model.index.has(code)
                });
            });
        }
        return { nodes, edges };
    }

    // =======================================================================
    // Edge routing — thread gaps between boxes instead of cutting through them
    // =======================================================================
    // Obstacle map: column x-key -> sorted [top, bottom] intervals of its boxes.
    function buildColumns(nodes) {
        const cols = new Map();
        for (const n of nodes.values()) {
            const key = Math.round(n.x);
            (cols.get(key) || cols.set(key, []).get(key)).push([n.y, n.y + NODE_H]);
        }
        for (const arr of cols.values()) arr.sort((a, b) => a[0] - b[0]);
        return cols;
    }

    // Nudge y into the nearest free gap within a column's stacked boxes.
    function freeY(intervals, y, margin) {
        for (const [top, bottom] of intervals) {
            if (y > top - margin && y < bottom + margin) {
                const up = top - margin, down = bottom + margin;
                return Math.abs(y - up) <= Math.abs(y - down) ? up : down;
            }
        }
        return y;
    }

    // Smooth Catmull-Rom spline through the waypoints.
    function splinePath(pts) {
        if (pts.length < 2) return "";
        if (pts.length === 2) {
            const [a, b] = pts, cx = (a[0] + b[0]) / 2;
            return `M${a[0]},${a[1]} C${cx},${a[1]} ${cx},${b[1]} ${b[0]},${b[1]}`;
        }
        let d = `M${pts[0][0]},${pts[0][1]}`;
        for (let i = 0; i < pts.length - 1; i++) {
            const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
            // Clamp control-point y to the segment's y-range so the curve can't
            // overshoot vertically into a box it was routed to avoid.
            const lo = Math.min(p1[1], p2[1]), hi = Math.max(p1[1], p2[1]);
            const c1y = Math.max(lo, Math.min(hi, p1[1] + (p2[1] - p0[1]) / 6));
            const c2y = Math.max(lo, Math.min(hi, p2[1] - (p3[1] - p1[1]) / 6));
            d += ` C${p1[0] + (p2[0] - p0[0]) / 6},${c1y} ${p2[0] - (p3[0] - p1[0]) / 6},${c2y} ${p2[0]},${p2[1]}`;
        }
        return d;
    }

    // Route A(right) -> B(left): for every column the edge crosses, run flat through
    // a free gap in that column so the line weaves around boxes rather than over them.
    function routeEdge(a, b, columns) {
        const ax = a.x + NODE_W, ay = a.y + NODE_H / 2;
        const bx = b.x, by = b.y + NODE_H / 2;
        const pts = [[ax, ay]];
        if (bx > ax) {
            const xs = [...columns.keys()].filter(cx => cx > a.x && cx < b.x).sort((p, q) => p - q);
            for (const cx of xs) {
                const ny = ay + (by - ay) * ((cx + NODE_W / 2 - ax) / (bx - ax));
                const gy = freeY(columns.get(cx), ny, 9);
                pts.push([cx - 7, gy], [cx + NODE_W + 7, gy]);
            }
        }
        pts.push([bx, by]);
        return splinePath(pts);
    }

    // =======================================================================
    // SVG rendering
    // =======================================================================
    const SVGNS = "http://www.w3.org/2000/svg";
    let rootG = null;

    function clearGraph() {
        svg.innerHTML = "";
        rootG = null;
        $("graph_controls").classList.add("hidden");
        $("graph_legend").classList.add("hidden");
    }

    function renderGraph() {
        clearGraph();
        const sub = computeSubgraph(focusCode, upDepth, downDepth, showRelated);
        const laid = layout(sub, focusCode);
        $("graph_state").classList.add("hidden");
        $("graph_controls").classList.remove("hidden");
        $("graph_legend").classList.remove("hidden");

        // defs: arrowheads
        const defs = document.createElementNS(SVGNS, "defs");
        defs.innerHTML = `
            <marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
                <path d="M0,0 L7,3.5 L0,7 Z" class="fill-slate-400 dark:fill-slate-500"></path>
            </marker>
            <marker id="arrow-hi" markerWidth="8" markerHeight="8" refX="6.5" refY="4" orient="auto" markerUnits="userSpaceOnUse">
                <path d="M0,0 L8,4 L0,8 Z" class="fill-accent-500"></path>
            </marker>`;
        svg.appendChild(defs);

        rootG = document.createElementNS(SVGNS, "g");
        svg.appendChild(rootG);
        const edgeG = document.createElementNS(SVGNS, "g");
        const nodeG = document.createElementNS(SVGNS, "g");
        rootG.appendChild(edgeG);
        rootG.appendChild(nodeG);

        // Edges (routed around boxes)
        const columns = buildColumns(laid.nodes);
        for (const e of laid.edges) {
            const a = laid.nodes.get(e.from), b = laid.nodes.get(e.to);
            if (!a || !b) continue;
            const touchesFocus = e.from === focusCode || e.to === focusCode;
            const path = document.createElementNS(SVGNS, "path");
            path.setAttribute("d", routeEdge(a, b, columns));
            path.setAttribute("fill", "none");
            path.setAttribute("stroke-width", touchesFocus ? "2" : "1.5");
            if (e.kind === "alt") path.setAttribute("stroke-dasharray", "5 4");
            path.setAttribute("class", touchesFocus
                ? "stroke-accent-400 dark:stroke-accent-500"
                : "stroke-slate-300 dark:stroke-slate-600");
            path.setAttribute("marker-end", `url(#${touchesFocus ? "arrow-hi" : "arrow"})`);
            edgeG.appendChild(path);
        }

        // Nodes
        for (const node of laid.nodes.values()) nodeG.appendChild(makeNode(node));

        fitView(laid);
    }

    function nodeClasses(node) {
        if (node.kind === "focus") return "fill-accent-600 stroke-accent-700";
        if (!node.offered) return "fill-slate-100 dark:fill-slate-800 stroke-slate-200 dark:stroke-slate-700";
        if (node.kind === "pre") return "fill-sky-50 dark:fill-sky-500/10 stroke-sky-300 dark:stroke-sky-500/40";
        if (node.kind === "dep") return "fill-emerald-50 dark:fill-emerald-500/10 stroke-emerald-300 dark:stroke-emerald-500/40";
        return "fill-violet-50 dark:fill-violet-500/10 stroke-violet-300 dark:stroke-violet-500/40"; // related/other
    }

    function makeNode(node) {
        const g = document.createElementNS(SVGNS, "g");
        g.setAttribute("transform", `translate(${node.x},${node.y})`);
        g.style.cursor = node.offered && node.code !== focusCode ? "pointer" : "default";

        const rect = document.createElementNS(SVGNS, "rect");
        rect.setAttribute("width", NODE_W);
        rect.setAttribute("height", NODE_H);
        rect.setAttribute("rx", "10");
        rect.setAttribute("stroke-width", node.kind === "focus" ? "2" : "1.5");
        if (!node.offered) rect.setAttribute("stroke-dasharray", "4 3");
        rect.setAttribute("class", nodeClasses(node));
        g.appendChild(rect);

        const title = node.offered ? model.index.get(node.code).title : (model.codeTitle.get(node.code) || "not offered");
        const focusText = node.kind === "focus";
        const codeText = document.createElementNS(SVGNS, "text");
        codeText.setAttribute("x", "13");
        codeText.setAttribute("y", "24");
        codeText.setAttribute("class", `font-mono text-[12px] font-semibold ${focusText ? "fill-white" : "fill-slate-800 dark:fill-slate-100"}`);
        codeText.textContent = node.code;
        g.appendChild(codeText);

        // Title over up to two wrapped lines (~40 chars total, far more than before).
        const lines = wrapTitle(title, 34, 2);
        const titleCls = `text-[11px] ${focusText ? "fill-white/85" : node.offered ? "fill-slate-500 dark:fill-slate-400" : "fill-slate-400 dark:fill-slate-500 italic"}`;
        lines.forEach((ln, i) => {
            const t = document.createElementNS(SVGNS, "text");
            t.setAttribute("x", "13");
            t.setAttribute("y", String(41 + i * 14));
            t.setAttribute("class", titleCls);
            t.textContent = ln;
            g.appendChild(t);
        });

        // Interactions
        g._code = node.code;
        attachTip(g, node.code);
        if (node.offered && node.code !== focusCode) {
            g.addEventListener("click", () => { if (!dragMoved) setFocus(node.code); });
        }
        return g;
    }

    function truncate(s, n) {
        s = String(s || "");
        return s.length > n ? s.slice(0, n - 1) + "…" : s;
    }

    // Greedy word-wrap into up to `maxLines` of ~`perLine` chars; last line ellipsized.
    function wrapTitle(s, perLine, maxLines) {
        const words = String(s || "").split(/\s+/).filter(Boolean);
        const lines = [];
        let cur = "";
        for (let i = 0; i < words.length; i++) {
            const next = cur ? cur + " " + words[i] : words[i];
            if (next.length <= perLine) { cur = next; continue; }
            if (cur) lines.push(cur);
            cur = words[i];
            if (lines.length === maxLines - 1) {          // on the final line: take the rest
                cur = words.slice(i).join(" ");
                break;
            }
        }
        if (cur && lines.length < maxLines) lines.push(cur);
        if (lines.length) lines[lines.length - 1] = truncate(lines[lines.length - 1], perLine);
        return lines;
    }

    // =======================================================================
    // Pan / zoom
    // =======================================================================
    function applyTransform() {
        if (rootG) rootG.setAttribute("transform", `translate(${tx},${ty}) scale(${scale})`);
    }

    function fitView(laid) {
        const nodes = [...laid.nodes.values()];
        if (!nodes.length) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of nodes) {
            minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
            maxX = Math.max(maxX, n.x + NODE_W); maxY = Math.max(maxY, n.y + NODE_H);
        }
        const pad = 60;
        const gw = (maxX - minX) + pad * 2, gh = (maxY - minY) + pad * 2;
        const vw = viewport.clientWidth, vh = viewport.clientHeight;
        // On the very first paint the viewport can measure 0 — defer a frame.
        if (vw <= 0 || vh <= 0) { requestAnimationFrame(() => fitView(laid)); return; }
        scale = Math.max(0.15, Math.min(1.1, Math.min(vw / gw, vh / gh)));
        // Center the whole graph so nothing (incl. the focus) gets clipped.
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        tx = vw / 2 - cx * scale;
        ty = vh / 2 - cy * scale;
        applyTransform();
    }

    function zoomBy(factor, cx, cy) {
        const vw = viewport.clientWidth, vh = viewport.clientHeight;
        if (cx == null) { cx = vw / 2; cy = vh / 2; }
        const newScale = Math.max(0.2, Math.min(2.5, scale * factor));
        // keep the point under the cursor fixed
        tx = cx - (cx - tx) * (newScale / scale);
        ty = cy - (cy - ty) * (newScale / scale);
        scale = newScale;
        applyTransform();
    }

    $("zoom_in").addEventListener("click", () => zoomBy(1.2));
    $("zoom_out").addEventListener("click", () => zoomBy(1 / 1.2));
    $("zoom_fit").addEventListener("click", () => { if (focusCode) renderGraph(); });

    viewport.addEventListener("wheel", e => {
        if (!rootG) return;
        e.preventDefault();
        const r = viewport.getBoundingClientRect();
        zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    // Drag to pan. Capture the pointer only once an actual drag begins — capturing
    // on pointerdown would swallow the node's click event (breaking click-to-center).
    let panning = false, dragMoved = false, panPointer = null, startX = 0, startY = 0, startTx = 0, startTy = 0;
    svg.addEventListener("pointerdown", e => {
        if (!rootG || e.button !== 0) return;
        panning = true; dragMoved = false; panPointer = e.pointerId;
        startX = e.clientX; startY = e.clientY; startTx = tx; startTy = ty;
    });
    svg.addEventListener("pointermove", e => {
        if (!panning || e.pointerId !== panPointer) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (!dragMoved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
            dragMoved = true;
            try { svg.setPointerCapture(e.pointerId); } catch (_) {}
            svg.style.cursor = "grabbing";
        }
        if (!dragMoved) return;
        tx = startTx + dx; ty = startTy + dy;
        applyTransform();
    });
    const endPan = () => { panning = false; panPointer = null; svg.style.cursor = ""; };
    svg.addEventListener("pointerup", endPan);
    svg.addEventListener("pointercancel", endPan);

    // =======================================================================
    // Depth controls
    // =======================================================================
    document.querySelectorAll("[data-step]").forEach(btn => btn.addEventListener("click", () => {
        const which = btn.dataset.step, dir = parseInt(btn.dataset.dir, 10);
        if (which === "up") upDepth = Math.max(1, Math.min(6, upDepth + dir));
        else downDepth = Math.max(1, Math.min(6, downDepth + dir));
        $("up_depth_val").textContent = upDepth;
        $("down_depth_val").textContent = downDepth;
        if (focusCode) renderGraph();
    }));

    $("related_switch").addEventListener("click", () => {
        showRelated = !showRelated;
        $("related_switch").setAttribute("aria-checked", showRelated ? "true" : "false");
        if (focusCode) renderGraph();
    });

    // =======================================================================
    // Tooltip (rich course card) — mirrors the schedule page's floating tip
    // =======================================================================
    let tipHideTimer = null, tipBound = false;

    function bindTipContainer() {
        if (tipBound) return;
        tipBound = true;
        tipEl.addEventListener("mouseenter", () => clearTimeout(tipHideTimer));
        tipEl.addEventListener("mouseleave", () => scheduleHide());
    }

    function scheduleHide() {
        clearTimeout(tipHideTimer);
        tipHideTimer = setTimeout(() => tipEl.classList.remove("visible"), 200);
    }

    function courseTipHtml(code) {
        const offered = model.index.has(code);
        if (!offered) {
            const t = model.codeTitle.get(code) || "";
            return `<div class="text-left space-y-1">
                <div class="font-semibold text-white">${escapeHtml(code)}</div>
                ${t ? `<div class="text-slate-200">${escapeHtml(t)}</div>` : ""}
                <div class="text-amber-300 pt-0.5">Not offered this term — no details.</div>
            </div>`;
        }
        const e = model.index.get(code);
        const row = (label, value) => value
            ? `<div class="flex gap-2"><span class="shrink-0 w-16 text-slate-400">${label}</span><span class="text-slate-100">${escapeHtml(value)}</span></div>`
            : "";
        const nPre = (model.prereqCodesOf.get(code) || []).length;
        const nDep = (model.dependentsOf.get(code) || []).length;
        return `<div class="text-left space-y-1">
            <div class="font-semibold text-white">${escapeHtml(e.code)}</div>
            <div class="text-slate-200">${escapeHtml(e.title)}</div>
            <div class="pt-1 space-y-0.5">
                ${row("Credits", e.credits)}
                ${row("Format", [e.format, e.delivery].filter(Boolean).join(" · "))}
                ${row("Seats", e.seats)}
                ${row("Requires", nPre ? `${nPre} course${nPre > 1 ? "s" : ""}` : "—")}
                ${row("Unlocks", nDep ? `${nDep} course${nDep > 1 ? "s" : ""}` : "—")}
            </div>
            ${e.description ? `<div class="pt-1 text-slate-300 border-t border-white/10 mt-1">${escapeHtml(truncate(e.description, 260))}</div>` : ""}
            <div class="pt-1 text-slate-400 text-[11px]">Click to center on this course.</div>
        </div>`;
    }

    function showTip(el, code) {
        if (!model) return;
        tipEl.innerHTML = courseTipHtml(code);
        tipEl.style.maxWidth = "18rem";     // slimmer, less obtrusive than the default card
        tipEl.classList.add("visible");
        const r = el.getBoundingClientRect();
        const tr = tipEl.getBoundingClientRect();
        const gap = 12;
        // Open to the SIDE (right preferred, else left) so it sits beside the node
        // instead of covering the graph above/below it. Fall back to above/below.
        let left;
        if (r.right + gap + tr.width <= window.innerWidth - 8) left = r.right + gap;
        else if (r.left - gap - tr.width >= 8) left = r.left - gap - tr.width;
        else left = Math.max(8, Math.min(r.left + r.width / 2 - tr.width / 2, window.innerWidth - tr.width - 8));
        let top;
        if (left === r.right + gap || left === r.left - gap - tr.width) {
            top = r.top + r.height / 2 - tr.height / 2;      // vertically centered on the node
        } else {
            top = r.top - tr.height - 8;                     // fallback: above, flip below
            if (top < 8) top = r.bottom + 8;
        }
        top = Math.max(8, Math.min(top, window.innerHeight - tr.height - 8));
        tipEl.style.left = `${left}px`;
        tipEl.style.top = `${top}px`;
    }

    // el may be an HTML element (data-tip-code) or an SVG node (code passed).
    function attachTip(el, code) {
        bindTipContainer();
        const c = code || el.dataset.tipCode;
        if (!c) return;
        el.addEventListener("mouseenter", () => { clearTimeout(tipHideTimer); showTip(el, c); });
        el.addEventListener("mouseleave", () => scheduleHide());
    }

    // =======================================================================
    // Centered graph state message
    // =======================================================================
    function showState(title, sub) {
        clearGraph();
        const s = $("graph_state");
        s.classList.remove("hidden");
        $("graph_state_title").textContent = title;
        $("graph_state_sub").textContent = sub || "";
    }

    // Re-fit on resize (keep the focus centered).
    let resizeTimer = null;
    window.addEventListener("resize", () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { if (focusCode && rootG) renderGraph(); }, 150);
    });
})();
