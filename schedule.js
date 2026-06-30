// ---------------------------------------------------------------------------
// Class Schedule Picker — client-side, static. No backend.
// ---------------------------------------------------------------------------

let classes = [];
const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const dayShort = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAYS = 5; // busy-time inputs cover Mon–Fri

let config = {
    "max_level": 4,
    "prefixes_open": true,
    "schedule_exclude_open": false,
    "calendar_open": true,
    "schedule_exclude_0_pre": "07:00",
    "schedule_exclude_0_post": "09:00",
    "schedule_exclude_1_pre": "07:00",
    "schedule_exclude_1_post": "09:00",
    "schedule_exclude_2_pre": "07:00",
    "schedule_exclude_2_post": "09:00",
    "schedule_exclude_3_pre": "07:00",
    "schedule_exclude_3_post": "09:00",
    "schedule_exclude_4_pre": "07:00",
    "schedule_exclude_4_post": "09:00",
    "margin_time": 10,
    "dynamic_times": true,
    "prefixes": ["*"],
    "courses": [],
    "course_excludes": [],
    "favorites": [],
    "search_bar": "",
    "compare_starred": true,
    "active_tab": "saved",
    "busy_enabled": false,
    "busy_all_pre": "07:00",
    "busy_all_post": "09:00",
    "prefix_presets": [],
    "show_conflict_crns": [],
    "schedule_presets": [],
    "school": "",
    "term": "",
    // Per-(school|term) selection state lives here; the active workspace is mirrored
    // into the top-level fields below so the rest of the code stays workspace-agnostic.
    "workspaces": {}
};

// Selection fields that are scoped per school+term (everything course/prefix related).
const WORKSPACE_KEYS = [
    "courses", "favorites", "course_excludes", "show_conflict_crns",
    "prefixes", "prefix_presets", "schedule_presets"
];

let classfilesData = {};
let currentSchema = { showCRN: true };

// Prefix → {name, synonyms[]} lookup, derived from data or prefix_names.json.
let prefixMeta = {};

let all_prefixes = [];
const letter_days = {"M": 0, "T": 1, "W": 2, "R": 3, "F": 4, "S": 5, "U": 6};
let schedule = [[], [], [], [], [], [], []];

// Transient flags so a freshly added/starred item animates once on the next render.
let justAddedCrn = null;
let justStarredCrn = null;
let calendarActionCrn = null;

// Tooltip state: whether Shift is currently held, and the element the cursor is
// over, so a Shift press/release can live-swap the tooltip text while hovering.
let shiftHeld = false;
let activeTipEl = null;

fetch('./classfiles.json').then(r => r.json()).then(async cfd => {
    classfilesData = cfd;
    loadConfig();
    // Validate stored school/term against classfiles; fall back to first available.
    if (!classfilesData[config.school]) config.school = Object.keys(classfilesData)[0] || "";
    const schoolEntry = classfilesData[config.school] || {};
    const availTerms = Object.keys(schoolEntry).filter(k => !k.startsWith("_"))
        .sort((a, b) => termSortKey(b) - termSortKey(a));
    if (!availTerms.includes(config.term)) config.term = availTerms[0] || "";
    migrateLegacyWorkspace();
    loadWorkspace();
    await loadSchoolData(config.school, config.term);
    propagateWebpage();
});

// --------------------------------------------------------------------------
// Time helpers
// --------------------------------------------------------------------------

// "1200" -> minutes since midnight (720). All times in the data are 4-digit.
function toMinutes(hhmm) {
    const n = Number.parseInt(hhmm, 10);
    if (Number.isNaN(n)) return null;
    return Math.floor(n / 100) * 60 + (n % 100);
}

// minutes since midnight -> "1:00 PM" / "13:00" depending on config.dynamic_times
function formatMinutes(mins) {
    let h = Math.floor(mins / 60);
    const m = mins % 60;
    if (config.dynamic_times) {
        const suffix = h >= 12 ? "PM" : "AM";
        let hh = h % 12;
        if (hh === 0) hh = 12; // 0 and 12 both display as 12
        return `${hh}:${String(m).padStart(2, "0")} ${suffix}`;
    }
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Parse a course's Days/Times into meeting blocks: [{day, start, end}]
function parseMeetings(course) {
    if (!course["Days"] || !course["Times"]) return [];
    const dayBlocks = course["Days"].split("\n");
    const timeBlocks = course["Times"].split("\n");
    const meetings = [];
    for (let i = 0; i < dayBlocks.length; i++) {
        const range = (timeBlocks[i] || "").split("-");
        const start = toMinutes(range[0]);
        const end = toMinutes(range[1]);
        if (start === null || end === null) continue;
        for (const d of dayBlocks[i].split("")) {
            if (d in letter_days) meetings.push({day: letter_days[d], start, end});
        }
    }
    return meetings;
}

// "2:30 PM" → "1430" (HHMM string compatible with toMinutes)
function parseTime12hToHHMM(str) {
    const m = String(str).trim().match(/^(\d+):(\d+)\s*([AP]M)$/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (m[3].toUpperCase() === "AM") { if (h === 12) h = 0; }
    else { if (h !== 12) h += 12; }
    return String(h).padStart(2, "0") + String(min).padStart(2, "0");
}

// "fall-2026" → "Fall 2026"
function termDisplayName(slug) {
    return String(slug).split("-").map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

// Higher value = newer term. Year × 10 + season (spring=1, summer=2, fall=3).
function termSortKey(slug) {
    const parts = String(slug).split("-");
    const year = parseInt(parts[parts.length - 1], 10) || 0;
    const s = { spring: 1, summer: 2, fall: 3 }[parts[0]] || 0;
    return year * 10 + s;
}

// --------------------------------------------------------------------------
// Persistence
// --------------------------------------------------------------------------

function saveConfig() {
    sortSavedCourses();
    sortStarredCourses();
    syncWorkspace();
    localStorage.setItem("config", btoa(unescape(encodeURIComponent(JSON.stringify(config)))));
}

function loadConfig() {
    const stored = localStorage.getItem("config");
    if (stored == null) return;
    try {
        // Merge over defaults so configs saved by older versions still gain new keys.
        config = Object.assign({}, config, JSON.parse(decodeURIComponent(escape(atob(stored)))));
    } catch (e) {
        console.warn("Could not parse saved config, using defaults.", e);
    }
}

// --------------------------------------------------------------------------
// Per-school/term workspaces — keep each school+term's selections separate.
// --------------------------------------------------------------------------

function workspaceKey(school = config.school, term = config.term) {
    return school + "|" + term;
}

const workspaceDefaults = () => ({
    courses: [], favorites: [], course_excludes: [], show_conflict_crns: [],
    prefixes: ["*"], prefix_presets: [], schedule_presets: []
});

// Mirror the active selection fields back into the workspace store.
function syncWorkspace() {
    if (!config.workspaces || typeof config.workspaces !== "object") config.workspaces = {};
    if (!config.school && !config.term) return; // nothing meaningful to scope yet
    const ws = {};
    for (const k of WORKSPACE_KEYS) {
        ws[k] = Array.isArray(config[k]) ? config[k].slice() : workspaceDefaults()[k];
    }
    config.workspaces[workspaceKey()] = ws;
}

// Load a workspace's selections into the top-level fields (defaults if absent).
function loadWorkspace() {
    if (!config.workspaces || typeof config.workspaces !== "object") config.workspaces = {};
    const ws = config.workspaces[workspaceKey()] || workspaceDefaults();
    const defs = workspaceDefaults();
    for (const k of WORKSPACE_KEYS) {
        config[k] = Array.isArray(ws[k]) ? ws[k].slice() : defs[k];
    }
}

// One-time migration: configs saved before workspaces existed keep their
// selections at the top level. Fold them into the active workspace so nothing
// is lost when upgrading.
function migrateLegacyWorkspace() {
    if (!config.workspaces || typeof config.workspaces !== "object") config.workspaces = {};
    if (config.workspaces[workspaceKey()]) return; // already migrated / native
    const hasPrefixSel = Array.isArray(config.prefixes)
        && !(config.prefixes.length === 1 && config.prefixes[0] === "*");
    const hasLegacy = ["courses", "favorites", "course_excludes", "show_conflict_crns",
        "prefix_presets", "schedule_presets"].some(k => Array.isArray(config[k]) && config[k].length)
        || hasPrefixSel;
    if (hasLegacy) syncWorkspace();
}

// --------------------------------------------------------------------------
// Data loading / normalization
// --------------------------------------------------------------------------

async function loadSchoolData(school, term) {
    const schoolEntry = classfilesData[school] || {};
    const format = (schoolEntry["_format"] || "fit").toLowerCase();
    const filePath = schoolEntry[term];
    if (!filePath) { classes = {}; currentSchema = { showCRN: true }; prefixMeta = {}; return; }

    const prefixPath = schoolEntry["_prefix_names"] || null;
    const [rawClasses, rawNames] = await Promise.all([
        fetch("./" + filePath).then(r => r.json()),
        prefixPath
            ? fetch("./" + prefixPath).then(r => r.ok ? r.json() : {}).catch(() => ({}))
            : Promise.resolve(null)
    ]);

    const { normalizedClasses, schema } = normalizeClasses(rawClasses, format);
    classes = normalizedClasses;
    currentSchema = schema;

    if (rawNames !== null) {
        prefixMeta = Object.fromEntries(Object.entries(rawNames || {}).filter(([k]) => !k.startsWith("_")));
    } else {
        // Auto-derive prefix full names from the _department field (WashU style).
        prefixMeta = {};
        for (const c of Object.values(classes)) {
            const prefix = (c["Course"] || "").split(" ")[0];
            if (prefix && !prefixMeta[prefix] && c["_department"]) {
                prefixMeta[prefix] = { name: c["_department"] };
            }
        }
    }
}

function normalizeClasses(raw, format) {
    if (format === "washu") return normalizeWashU(raw);
    return normalizeFIT(raw);
}

function normalizeFIT(raw) {
    const normalizedClasses = {};
    for (const [key, c] of Object.entries(raw)) {
        const crn = c["CRN"] || key;
        normalizedClasses[crn] = { ...c, "_key": crn };
    }
    return { normalizedClasses, schema: { showCRN: true } };
}

function normalizeWashU(raw) {
    const dayWordMap = { Mon: "M", Tue: "T", Wed: "W", Thu: "R", Fri: "F", Sat: "S", Sun: "U" };
    const normalizedClasses = {};
    for (const [id, c] of Object.entries(raw)) {
        if (id.startsWith("_")) continue;
        const classNum = c["class_num"] || "";
        const section = c["section_num"] || "01";
        const synKey = classNum.replace(/\s+/g, "") + "S" + section;
        const days = (c["days"] || "").split(/\s+/).map(d => dayWordMap[d] || "").join("");
        let times = "";
        const tm = (c["time"] || "").match(/([\d:]+\s*[AP]M)\s*-\s*([\d:]+\s*[AP]M)/i);
        if (tm) {
            const s = parseTime12hToHHMM(tm[1]), e = parseTime12hToHHMM(tm[2]);
            if (s && e) times = `${s}-${e}`;
        }
        normalizedClasses[synKey] = {
            "_key": synKey,
            "CRN": "",
            "Course": classNum,
            "Title": c["class_name"] || "",
            "Section": section,
            "Cr": String(c["credits"] || ""),
            "details": c["description"] || "",
            "Notes": "",
            "Days": days,
            "Times": times,
            "Place": "",
            "Instructor": c["instructor"] || "",
            "Cap": c["seats"] || "",
            "_department": c["department"] || "",
            "_delivery": c["delivery"] || "",
            "_school": decodeURIComponent((c["school"] || "").replace(/\+/g, " "))
        };
    }
    return { normalizedClasses, schema: { showCRN: false } };
}

// --------------------------------------------------------------------------
// Page setup
// --------------------------------------------------------------------------

async function propagateWebpage() {
    // Per-day busy-time inputs (Mon–Fri)
    let excludeHTML = "";
    for (let i = 0; i < WEEKDAYS; i++) {
        excludeHTML += `<div class="flex items-center justify-between gap-2">
            <label class="text-sm text-slate-600 dark:text-slate-300 w-10">${dayShort[i]}</label>
            <div class="flex items-center gap-1.5 text-sm">
                <input class="rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-1.5 py-1 focus:outline-none focus:ring-2 focus:ring-indigo-500/60" id="schedule_exclude_${i}_pre" type="time" value="${config[`schedule_exclude_${i}_pre`]}">
                <span class="text-slate-400">–</span>
                <input class="rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-1.5 py-1 focus:outline-none focus:ring-2 focus:ring-indigo-500/60" id="schedule_exclude_${i}_post" type="time" value="${config[`schedule_exclude_${i}_post`]}">
            </div>
        </div>`;
    }
    document.getElementById("schedule_excludes").innerHTML = excludeHTML;
    syncBusyAllInputs();

    // School / term selects and prefix checkboxes
    buildSchoolTermUI();
    buildPrefixList();

    // Restore scalar inputs
    document.getElementById("max_level").value = config.max_level;
    document.getElementById("margin_time").value = config.margin_time;
    document.getElementById("dynamic_times").checked = config.dynamic_times;
    document.getElementById("search_bar").value = config.search_bar;

    // Restore collapse state
    document.querySelectorAll(".collapse_toggle").forEach(applyCollapseState);

    // Event listeners (attached once at startup)
    document.getElementById("max_level").addEventListener("input", handleValueChange);
    document.getElementById("margin_time").addEventListener("input", handleValueChange);
    document.getElementById("dynamic_times").addEventListener("change", handleValueChange);
    document.getElementById("search_bar").addEventListener("input", handleSearchBarChange);
    document.getElementById("prefixes_all").addEventListener("click", handlePrefixAllNone);
    document.getElementById("prefixes_none").addEventListener("click", handlePrefixAllNone);
    document.getElementById("theme_toggle").addEventListener("click", toggleTheme);
    document.getElementById("export_data_btn").addEventListener("click", exportLocalData);
    document.getElementById("import_data_btn").addEventListener("click", () => {
        document.getElementById("import_data_file").click();
    });
    document.getElementById("import_data_file").addEventListener("change", importLocalData);

    for (let i = 0; i < WEEKDAYS; i++) {
        document.getElementById(`schedule_exclude_${i}_pre`).addEventListener("input", handleValueChange);
        document.getElementById(`schedule_exclude_${i}_post`).addEventListener("input", handleValueChange);
    }

    // Busy-time: "all days" master inputs + enable switch
    document.getElementById("busy_all_pre").addEventListener("input", handleBusyAllChange);
    document.getElementById("busy_all_post").addEventListener("input", handleBusyAllChange);
    document.getElementById("busy_enabled").addEventListener("click", toggleBusyEnabled);
    applyBusyEnabledState();

    document.querySelectorAll(".collapse_toggle").forEach(toggle =>
        toggle.addEventListener("click", handleCollapseToggle));

    // Saved / Starred tabs
    document.querySelectorAll(".courses_tab").forEach(tab =>
        tab.addEventListener("click", () => setActiveTab(tab.dataset.tab)));
    setActiveTab(config.active_tab || "saved");

    // Compare-starred overlay toggle
    document.getElementById("compare_toggle").addEventListener("click", toggleCompareStarred);
    applyCompareToggleState();

    // Prefix presets (save / restore / rename / delete)
    document.getElementById("prefixes_save").addEventListener("click", savePrefixPreset);
    renderPrefixPresets();

    // Schedule presets (save / restore / rename / delete / clear)
    document.getElementById("schedule_save").addEventListener("click", saveSchedulePreset);
    document.getElementById("schedule_clear_btn").addEventListener("click", clearSchedule);
    renderSchedulePresets();

    // Prefix search (matches code, full name, and synonyms)
    document.getElementById("prefix_search").addEventListener("input", e => {
        filterPrefixes(e.target.value);
        updatePrefixSearchClear();
    });
    document.getElementById("prefix_search_clear").addEventListener("click", () => {
        document.getElementById("prefix_search").value = "";
        filterPrefixes("");
        updatePrefixSearchClear();
    });

    // Hidden-classes (exclusions) menu
    document.getElementById("exclusions_btn").addEventListener("click", toggleExclusionsMenu);
    document.getElementById("exclusions_clear").addEventListener("click", clearExclusions);
    document.getElementById("exclusions_search").addEventListener("input", renderExclusionsList);
    document.addEventListener("click", e => {
        const menu = document.getElementById("exclusions_menu");
        if (menu.classList.contains("hidden")) return;
        if (!menu.contains(e.target) && !document.getElementById("exclusions_btn").contains(e.target)) {
            menu.classList.add("hidden");
            document.getElementById("exclusions_btn").setAttribute("aria-expanded", "false");
        }
    });
    document.addEventListener("click", e => {
        const menu = document.getElementById("calendar_action_menu");
        if (!menu || menu.classList.contains("hidden")) return;
        if (!menu.contains(e.target) && !closestEl(e.target, ".calendar_action_block")) {
            hideCalendarActionMenu();
        }
    });

    initTooltips();

    calculateSchedule();

    // Table header — adapts based on school schema (showCRN)
    document.getElementById("results-header").innerHTML = renderTableHeader();

    refreshResults();
}

// --------------------------------------------------------------------------
// Saved / Starred tabs + compare overlay
// --------------------------------------------------------------------------

function setActiveTab(tab) {
    config.active_tab = tab;
    saveConfig();
    document.querySelectorAll(".courses_tab").forEach(btn => {
        const active = btn.dataset.tab === tab;
        btn.classList.toggle("bg-white", active);
        btn.classList.toggle("dark:bg-slate-900", active);
        btn.classList.toggle("shadow-sm", active);
        btn.classList.toggle("text-indigo-600", active);
        btn.classList.toggle("dark:text-indigo-300", active);
        btn.classList.toggle("text-slate-500", !active);
        btn.classList.toggle("dark:text-slate-400", !active);
    });
    document.querySelectorAll("[data-panel]").forEach(p =>
        p.classList.toggle("hidden", p.dataset.panel !== tab));
}

function toggleCompareStarred() {
    config.compare_starred = !config.compare_starred;
    saveConfig();
    applyCompareToggleState();
    renderCalendar();
}

function applyCompareToggleState() {
    const btn = document.getElementById("compare_toggle");
    const on = !!config.compare_starred;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.classList.toggle("bg-indigo-600", on);
    btn.classList.toggle("border-indigo-600", on);
    btn.classList.toggle("text-white", on);
    btn.classList.toggle("border-slate-200", !on);
    btn.classList.toggle("dark:border-slate-700", !on);
    btn.classList.toggle("text-slate-600", !on);
    btn.classList.toggle("dark:text-slate-300", !on);
    btn.classList.toggle("hover:bg-slate-50", !on);
    btn.classList.toggle("dark:hover:bg-slate-800", !on);
}

// --------------------------------------------------------------------------
// Busy times (enable switch + "set all days" master row)
// --------------------------------------------------------------------------

function toggleBusyEnabled() {
    config.busy_enabled = !config.busy_enabled;
    saveConfig();
    applyBusyEnabledState();
    calculateSchedule();
    refreshResults();
}

function applyBusyEnabledState() {
    const on = config.busy_enabled !== false;
    const sw = document.getElementById("busy_enabled");
    sw.setAttribute("aria-checked", on ? "true" : "false");
    // Grey out the inputs (but not the switch) when disabled
    document.getElementById("schedule_exclude_collapsable").classList.toggle("busy-disabled", !on);
}

// Changing an "All days" input writes that value to every weekday and updates the inputs.
function handleBusyAllChange(e) {
    const which = e.target.id === "busy_all_pre" ? "pre" : "post";
    const value = e.target.value;
    if (!value) return;
    config[`busy_all_${which}`] = value;
    for (let i = 0; i < WEEKDAYS; i++) {
        config[`schedule_exclude_${i}_${which}`] = value;
        const input = document.getElementById(`schedule_exclude_${i}_${which}`);
        if (input) input.value = value;
    }
    saveConfig();
    calculateSchedule();
    refreshResults();
}

// Reflect the per-day values in the "All" inputs: show the shared value if every
// weekday matches, otherwise leave it blank (indeterminate).
function syncBusyAllInputs() {
    for (const which of ["pre", "post"]) {
        const values = [];
        for (let i = 0; i < WEEKDAYS; i++) values.push(config[`schedule_exclude_${i}_${which}`]);
        const allSame = values.every(v => v === values[0]);
        const input = document.getElementById(`busy_all_${which}`);
        if (input) input.value = allSame ? values[0] : "";
    }
}

// --------------------------------------------------------------------------
// Course-prefix presets (save / restore / rename / delete)
// --------------------------------------------------------------------------

function savePrefixPreset() {
    if (!Array.isArray(config.prefix_presets)) config.prefix_presets = [];
    // Default name "Saved sections N" using the next free index.
    let n = config.prefix_presets.length + 1;
    const used = new Set(config.prefix_presets.map(p => p.name));
    while (used.has(`Saved sections ${n}`)) n++;
    config.prefix_presets.push({
        name: `Saved sections ${n}`,
        prefixes: config.prefixes.slice(),
        max_level: config.max_level
    });
    saveConfig();
    renderPrefixPresets(config.prefix_presets.length - 1);
}

function renderPrefixPresets(animateIdx = -1) {
    const wrap = document.getElementById("prefix_presets");
    if (!wrap) return;
    const presets = Array.isArray(config.prefix_presets) ? config.prefix_presets : [];
    wrap.innerHTML = presets.map((p, i) => `
        <span class="preset_pill group relative inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 pl-2 pr-1 py-1 ${i === animateIdx ? "animate-pop" : ""}">
            <button class="preset_restore btn-press text-xs font-medium text-slate-700 dark:text-slate-200 max-w-[9rem] truncate" data-idx="${i}" title="Restore (${p.prefixes.length} prefixes · level ${p.max_level})">${escapeHtml(p.name)}</button>
            <span class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                <button class="preset_rename grid place-items-center h-4 w-4 rounded text-slate-400 hover:text-indigo-500" data-idx="${i}" title="Rename">
                    <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m16.5 3.5 4 4L7 21H3v-4L16.5 3.5Z"/></svg>
                </button>
                <button class="preset_delete grid place-items-center h-4 w-4 rounded text-slate-400 hover:text-red-500" data-idx="${i}" title="Delete">
                    <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>
                </button>
            </span>
        </span>`).join("");

    wrap.querySelectorAll(".preset_restore").forEach(b => b.addEventListener("click", () => restorePrefixPreset(+b.dataset.idx)));
    wrap.querySelectorAll(".preset_rename").forEach(b => b.addEventListener("click", () => renamePrefixPreset(+b.dataset.idx)));
    wrap.querySelectorAll(".preset_delete").forEach(b => b.addEventListener("click", () => deletePrefixPreset(+b.dataset.idx)));
}

function restorePrefixPreset(idx) {
    const p = config.prefix_presets[idx];
    if (!p) return;
    config.prefixes = p.prefixes.slice();
    config.max_level = p.max_level;
    // Reflect in the UI
    document.getElementById("max_level").value = p.max_level;
    document.querySelectorAll(".prefix_toggle").forEach(t => {
        t.checked = config.prefixes.includes(t.id.replace("prefix_toggle_", ""));
    });
    saveConfig();
    refreshResults();
}

function renamePrefixPreset(idx) {
    const p = config.prefix_presets[idx];
    if (!p) return;
    const name = window.prompt("Rename preset:", p.name);
    if (name === null) return;
    const trimmed = name.trim();
    if (trimmed) p.name = trimmed;
    saveConfig();
    renderPrefixPresets();
}

function deletePrefixPreset(idx) {
    const pill = document.querySelectorAll("#prefix_presets .preset_pill")[idx];
    const finish = () => {
        config.prefix_presets.splice(idx, 1);
        saveConfig();
        renderPrefixPresets();
    };
    if (pill) {
        pill.classList.add("animate-out");
        setTimeout(finish, 180);
    } else {
        finish();
    }
}

// Filter the visible prefix checkboxes by code / full name / synonyms.
function filterPrefixes(query) {
    const q = query.trim().toLowerCase();
    let shown = 0;
    document.querySelectorAll(".prefix_row").forEach(row => {
        const match = !q || row.dataset.search.includes(q);
        row.classList.toggle("hidden", !match);
        if (match) shown++;
    });
    document.getElementById("prefixes_noresults").classList.toggle("hidden", shown > 0);
}

function updatePrefixSearchClear() {
    const btn = document.getElementById("prefix_search_clear");
    if (btn) btn.classList.toggle("hidden", !document.getElementById("prefix_search").value);
}

// --------------------------------------------------------------------------
// School / term switching
// --------------------------------------------------------------------------

function buildSchoolTermUI() {
    const schoolMenu = document.getElementById("school_menu");
    const termMenu = document.getElementById("term_menu");
    const schoolLabel = document.getElementById("school_label");
    const termLabel = document.getElementById("term_label");
    if (!schoolMenu || !schoolLabel) return;

    schoolLabel.textContent = config.school;
    termLabel.textContent = termDisplayName(config.term);

    schoolMenu.innerHTML = Object.keys(classfilesData).map(s =>
        `<button class="school_item w-full text-left px-3 py-1.5 text-sm transition-colors ${s === config.school ? "font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-500/10" : "text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"}" data-school="${escapeAttr(s)}">${escapeHtml(s)}</button>`
    ).join("");

    refreshTermDropdown();

    document.getElementById("school_btn").addEventListener("click", e => {
        e.stopPropagation();
        const isOpen = !schoolMenu.classList.contains("hidden");
        schoolMenu.classList.toggle("hidden", isOpen);
        termMenu.classList.add("hidden");
    });
    document.getElementById("term_btn").addEventListener("click", e => {
        e.stopPropagation();
        const isOpen = !termMenu.classList.contains("hidden");
        termMenu.classList.toggle("hidden", isOpen);
        schoolMenu.classList.add("hidden");
    });
    document.addEventListener("click", () => {
        schoolMenu.classList.add("hidden");
        termMenu.classList.add("hidden");
    });

    schoolMenu.addEventListener("click", async e => {
        const item = e.target.closest(".school_item");
        if (!item) return;
        const newSchool = item.dataset.school;
        schoolMenu.classList.add("hidden");
        if (newSchool === config.school) return;
        config.school = newSchool;
        schoolLabel.textContent = newSchool;
        // Rebuild menu highlight and auto-select newest term
        schoolMenu.querySelectorAll(".school_item").forEach(b => {
            const active = b.dataset.school === newSchool;
            b.classList.toggle("font-semibold", active);
            b.classList.toggle("text-indigo-600", active);
            b.classList.toggle("dark:text-indigo-400", active);
            b.classList.toggle("bg-indigo-50", active);
            b.classList.toggle("dark:bg-indigo-500/10", active);
            b.classList.toggle("hover:bg-slate-50", !active);
            b.classList.toggle("dark:hover:bg-slate-800", !active);
        });
        const entry = classfilesData[newSchool] || {};
        const terms = Object.keys(entry).filter(k => !k.startsWith("_")).sort((a, b) => termSortKey(b) - termSortKey(a));
        config.term = terms[0] || "";
        termLabel.textContent = termDisplayName(config.term);
        refreshTermDropdown();
        await switchSchoolTerm(newSchool, config.term);
    });

    termMenu.addEventListener("click", async e => {
        const item = e.target.closest(".term_item");
        if (!item) return;
        const newTerm = item.dataset.term;
        termMenu.classList.add("hidden");
        if (newTerm === config.term) return;
        termLabel.textContent = termDisplayName(newTerm);
        termMenu.querySelectorAll(".term_item").forEach(b => {
            const active = b.dataset.term === newTerm;
            b.classList.toggle("font-semibold", active);
            b.classList.toggle("text-indigo-600", active);
            b.classList.toggle("dark:text-indigo-400", active);
            b.classList.toggle("bg-indigo-50", active);
            b.classList.toggle("dark:bg-indigo-500/10", active);
            b.classList.toggle("hover:bg-slate-50", !active);
            b.classList.toggle("dark:hover:bg-slate-800", !active);
        });
        await switchSchoolTerm(config.school, newTerm);
    });
}

function refreshTermDropdown() {
    const termMenu = document.getElementById("term_menu");
    const termLabel = document.getElementById("term_label");
    if (!termMenu) return;
    const schoolEntry = classfilesData[config.school] || {};
    const terms = Object.keys(schoolEntry).filter(k => !k.startsWith("_"))
        .sort((a, b) => termSortKey(b) - termSortKey(a));
    termMenu.innerHTML = terms.map(t =>
        `<button class="term_item w-full text-left px-3 py-1.5 text-sm transition-colors ${t === config.term ? "font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-500/10" : "text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"}" data-term="${escapeAttr(t)}">${escapeHtml(termDisplayName(t))}</button>`
    ).join("");
    if (termLabel) termLabel.textContent = termDisplayName(config.term);
}

async function switchSchoolTerm(school, term) {
    syncWorkspace();                 // persist the workspace we're leaving
    config.school = school;
    config.term = term;
    loadWorkspace();                 // restore (or default) the target workspace
    await loadSchoolData(school, term);
    config.search_bar = "";
    document.getElementById("search_bar").value = "";
    buildPrefixList();
    renderPrefixPresets();
    renderSchedulePresets();
    document.getElementById("results-header").innerHTML = renderTableHeader();
    saveConfig();
    calculateSchedule();
    refreshResults();
}

function buildPrefixList() {
    const isAll = config.prefixes.length === 1 && config.prefixes[0] === "*";
    if (isAll) config.prefixes = [];
    all_prefixes = [];
    for (const course of Object.values(classes)) {
        const prefix = (course["Course"] || "").split(" ")[0];
        if (prefix && !all_prefixes.includes(prefix)) {
            all_prefixes.push(prefix);
            if (isAll) config.prefixes.push(prefix);
        }
    }
    all_prefixes.sort();

    document.getElementById("prefixes_list").innerHTML = all_prefixes.map(prefix => {
        const meta = prefixMeta[prefix];
        const name = meta && meta.name ? meta.name : "";
        const synonyms = meta && Array.isArray(meta.synonyms) ? meta.synonyms : [];
        const search = [prefix, name, ...synonyms].join(" ").toLowerCase();
        const labelSpan = name
            ? `<span class="tip-trigger cursor-help text-slate-600 dark:text-slate-300" data-tip="${escapeAttr(name)}">${prefix}</span>`
            : `<span class="text-slate-600 dark:text-slate-300">${prefix}</span>`;
        return `<label class="prefix_row flex items-center gap-2 text-sm cursor-pointer select-none" data-search="${escapeAttr(search)}">
            <input ${config.prefixes.includes(prefix) ? "checked" : ""} type="checkbox" class="prefix_toggle h-3.5 w-3.5 rounded accent-indigo-600" id="prefix_toggle_${prefix}">
            ${labelSpan}
        </label>`;
    }).join("");

    all_prefixes.forEach(prefix =>
        document.getElementById(`prefix_toggle_${prefix}`).addEventListener("change", handlePrefixToggle));

    document.getElementById("prefixes_noresults").classList.add("hidden");
}

function renderTableHeader() {
    const crnTh = currentSchema.showCRN
        ? `<th class="px-3 py-2.5 font-semibold text-left w-20">CRN</th>` : "";
    const courseTh = currentSchema.showCRN
        ? `<th class="px-3 py-2.5 font-semibold text-left w-24">Course</th>`
        : `<th class="px-3 py-2.5 font-semibold text-left w-40">Course</th>`;
    return `<tr class="bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide shadow-sm">
        <th class="px-2 py-2.5 font-semibold text-center w-10">★</th>
        <th class="px-2 py-2.5 font-semibold text-center w-20">Add</th>
        ${crnTh}
        ${courseTh}
        <th class="px-3 py-2.5 font-semibold text-left">Title</th>
        <th class="px-3 py-2.5 font-semibold text-left w-16">Days</th>
        <th class="px-3 py-2.5 font-semibold text-left w-48">Time</th>
        <th class="px-2 py-2.5 font-semibold text-center w-10">Loc</th>
        <th class="px-3 py-2.5 font-semibold text-left w-32">Instructor</th>
        <th class="px-3 py-2.5 font-semibold text-center w-16">Cap</th>
    </tr>`;
}

// --------------------------------------------------------------------------
// Saved schedule presets (save / restore / rename / delete / clear)
// --------------------------------------------------------------------------

function saveSchedulePreset() {
    if (!Array.isArray(config.schedule_presets)) config.schedule_presets = [];
    let n = config.schedule_presets.length + 1;
    const used = new Set(config.schedule_presets.map(p => p.name));
    while (used.has(`Schedule ${n}`)) n++;
    config.schedule_presets.push({
        name: `Schedule ${n}`,
        courses: config.courses.slice(),
        show_conflict_crns: (config.show_conflict_crns || []).slice()
    });
    saveConfig();
    renderSchedulePresets(config.schedule_presets.length - 1);
}

function renderSchedulePresets(animateIdx = -1) {
    const wrap = document.getElementById("schedule_presets");
    if (!wrap) return;
    const presets = Array.isArray(config.schedule_presets) ? config.schedule_presets : [];
    wrap.innerHTML = presets.map((p, i) => `
        <span class="sched_preset_pill group relative inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 pl-2 pr-1 py-1 ${i === animateIdx ? "animate-pop" : ""}">
            <button class="sched_restore btn-press text-xs font-medium text-slate-700 dark:text-slate-200 max-w-[9rem] truncate" data-idx="${i}" title="Load ${escapeAttr(p.name)} (${p.courses.length} course${p.courses.length === 1 ? '' : 's'})">${escapeHtml(p.name)}</button>
            <span class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                <button class="sched_rename grid place-items-center h-4 w-4 rounded text-slate-400 hover:text-indigo-500" data-idx="${i}" title="Rename">
                    <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m16.5 3.5 4 4L7 21H3v-4L16.5 3.5Z"/></svg>
                </button>
                <button class="sched_delete grid place-items-center h-4 w-4 rounded text-slate-400 hover:text-red-500" data-idx="${i}" title="Delete">
                    <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>
                </button>
            </span>
        </span>`).join("");

    wrap.querySelectorAll(".sched_restore").forEach(b => b.addEventListener("click", () => restoreSchedulePreset(+b.dataset.idx)));
    wrap.querySelectorAll(".sched_rename").forEach(b => b.addEventListener("click", () => renameSchedulePreset(+b.dataset.idx)));
    wrap.querySelectorAll(".sched_delete").forEach(b => b.addEventListener("click", () => deleteSchedulePreset(+b.dataset.idx)));
}

function restoreSchedulePreset(idx) {
    const p = (config.schedule_presets || [])[idx];
    if (!p) return;
    config.courses = p.courses.slice();
    sortSavedCourses();
    config.show_conflict_crns = (p.show_conflict_crns || []).slice();
    saveConfig();
    calculateSchedule();
    refreshResults();
}

function renameSchedulePreset(idx) {
    const p = (config.schedule_presets || [])[idx];
    if (!p) return;
    const name = window.prompt("Rename schedule:", p.name);
    if (name === null) return;
    const trimmed = name.trim();
    if (trimmed) p.name = trimmed;
    saveConfig();
    renderSchedulePresets();
}

function deleteSchedulePreset(idx) {
    const pill = document.querySelectorAll("#schedule_presets .sched_preset_pill")[idx];
    const finish = () => {
        config.schedule_presets.splice(idx, 1);
        saveConfig();
        renderSchedulePresets();
    };
    if (pill) {
        pill.classList.add("animate-out");
        setTimeout(finish, 180);
    } else {
        finish();
    }
}

function clearSchedule() {
    config.courses = [];
    config.show_conflict_crns = [];
    saveConfig();
    calculateSchedule();
    refreshResults();
}

// --------------------------------------------------------------------------
// Hidden classes (exclusions) menu
// --------------------------------------------------------------------------

function toggleExclusionsMenu() {
    const menu = document.getElementById("exclusions_menu");
    const open = menu.classList.toggle("hidden") === false;
    document.getElementById("exclusions_btn").setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
        renderExclusionsList();
        document.getElementById("exclusions_search").focus();
    }
}

function renderExclusionsList() {
    const list = document.getElementById("exclusions_list");
    const empty = document.getElementById("exclusions_empty");
    if (!list) return;

    const q = (document.getElementById("exclusions_search").value || "").trim().toLowerCase();
    const hidden = config.course_excludes
        .map(crn => classes[crn])
        .filter(Boolean)
        .filter(c => !q || `${c["Course"]} ${c["Title"]} ${c["Instructor"]}`.toLowerCase().includes(q));

    empty.classList.toggle("hidden", config.course_excludes.length > 0);

    list.innerHTML = hidden.map(c => `<li class="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/60">
        <span class="flex-1 min-w-0">
            <span class="block text-sm font-semibold text-slate-700 dark:text-slate-200 truncate">${escapeHtml(c["Course"])} <span class="font-normal text-slate-400">·</span> <span class="font-normal text-slate-500 dark:text-slate-400">${escapeHtml(c["Title"])}</span></span>
        </span>
        <button class="restore_exclusion_btn btn-press shrink-0 text-xs font-medium px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" data-crn="${escapeAttr(c["_key"] || c["CRN"])}" type="button">Restore</button>
    </li>`).join("");

    if (config.course_excludes.length > 0 && hidden.length === 0) {
        list.innerHTML = `<li class="px-2 py-4 text-center text-sm text-slate-400 dark:text-slate-500">No hidden classes match.</li>`;
    }

    list.querySelectorAll(".restore_exclusion_btn").forEach(btn =>
        btn.addEventListener("click", e => {
            // Re-rendering removes this button mid-click; stop the document handler
            // (which would otherwise see a detached target) from closing the menu.
            e.stopPropagation();
            restoreExclusion(btn.dataset.crn);
        }));
}

function restoreExclusion(crn) {
    config.course_excludes = config.course_excludes.filter(c => c !== crn);
    saveConfig();
    renderExclusionsList();
    refreshResults();
}

function clearExclusions() {
    config.course_excludes = [];
    saveConfig();
    renderExclusionsList();
    refreshResults();
}

function updateExclusionsCount() {
    const badge = document.getElementById("exclusions_count");
    const n = config.course_excludes.length;
    badge.textContent = n;
    badge.classList.toggle("hidden", n === 0);
}

// --------------------------------------------------------------------------
// Theme
// --------------------------------------------------------------------------

function toggleTheme() {
    const isDark = document.documentElement.classList.toggle("dark");
    localStorage.setItem("theme", isDark ? "dark" : "light");
    renderCalendar(); // recolor gridlines etc.
}

function exportLocalData() {
    const status = document.getElementById("export_data_status");
    try {
        saveConfig();
        const stored = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            stored[key] = localStorage.getItem(key);
        }

        const payload = {
            app: "class_schedule_picker",
            version: 1,
            exported_at: new Date().toISOString(),
            localStorage: stored
        };
        const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
        const blob = new Blob([encoded], {type: "text/plain;charset=utf-8"});
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        a.href = url;
        a.download = `schedule-picker-export-${stamp}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        if (status) {
            status.textContent = "Exported";
            setTimeout(() => { status.textContent = ""; }, 2500);
        }
    } catch (e) {
        console.warn("Could not export local data.", e);
        if (status) {
            status.textContent = "Export failed";
            setTimeout(() => { status.textContent = ""; }, 3500);
        }
    }
}

async function importLocalData(e) {
    const status = document.getElementById("export_data_status");
    const input = e.target;
    const file = input.files && input.files[0];
    if (!file) return;

    try {
        const encoded = (await file.text()).trim();
        const payload = JSON.parse(decodeURIComponent(escape(atob(encoded))));
        if (payload.app !== "class_schedule_picker" || !payload.localStorage || typeof payload.localStorage !== "object") {
            throw new Error("Not a Schedule Picker export file.");
        }

        const ok = window.confirm("Importing will replace saved schedules, starred classes, filters, and other local settings on this computer. Continue?");
        if (!ok) return;

        localStorage.clear();
        for (const [key, value] of Object.entries(payload.localStorage)) {
            localStorage.setItem(key, String(value));
        }
        if (status) status.textContent = "Imported";
        window.setTimeout(() => window.location.reload(), 300);
    } catch (err) {
        console.warn("Could not import local data.", err);
        if (status) {
            status.textContent = "Import failed";
            setTimeout(() => { status.textContent = ""; }, 3500);
        }
    } finally {
        input.value = "";
    }
}

// --------------------------------------------------------------------------
// Collapse
// --------------------------------------------------------------------------

function applyCollapseState(toggle) {
    const target = toggle.dataset.target;
    const open = config[`${target}_open`] !== false;
    const content = document.getElementById(`${target}_collapsable`);
    const chevron = toggle.querySelector(".collapse_chevron");
    if (content) content.classList.toggle("hidden", !open);
    if (chevron) chevron.classList.toggle("-rotate-90", !open);
}

function handleCollapseToggle(e) {
    const target = e.currentTarget.dataset.target;
    config[`${target}_open`] = config[`${target}_open`] === false;
    saveConfig();
    // A section can have more than one toggle (e.g. title + chevron); sync all.
    document.querySelectorAll(`.collapse_toggle[data-target="${target}"]`).forEach(applyCollapseState);
}

// --------------------------------------------------------------------------
// Input handlers
// --------------------------------------------------------------------------

function handleValueChange(e) {
    let value = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    config[e.target.id] = value;
    saveConfig();
    if (e.target.id.startsWith("schedule_exclude_")) {
        calculateSchedule();
        syncBusyAllInputs(); // a single day changing may make "All" indeterminate
    }
    refreshResults();
}

function handleSearchBarChange(e) {
    config.search_bar = e.target.value;
    saveConfig();
    refreshResults();
}

function handlePrefixToggle(e) {
    const prefix = e.target.id.replace("prefix_toggle_", "");
    if (e.target.checked) {
        if (!config.prefixes.includes(prefix)) config.prefixes.push(prefix);
    } else {
        config.prefixes = config.prefixes.filter(p => p !== prefix);
    }
    saveConfig();
    refreshResults();
}

function handlePrefixAllNone(e) {
    const all = e.target.id === "prefixes_all";
    config.prefixes = all ? all_prefixes.slice() : [];
    document.querySelectorAll(".prefix_toggle").forEach(t => (t.checked = all));
    saveConfig();
    refreshResults();
}

// --------------------------------------------------------------------------
// Results
// --------------------------------------------------------------------------

function conflictsWithSchedule(course) {
    const margin = Number.parseInt(config.margin_time, 10) || 0;
    const showFor = config.show_conflict_crns || [];
    for (const m of parseMeetings(course)) {
        const busy = schedule[m.day].some(ev =>
            // Ignore events from saved courses the user has chosen to "show conflicts" for.
            !showFor.includes(ev.id) &&
            // standard interval overlap, padded by the margin
            m.start < ev.end + margin && ev.start - margin < m.end);
        if (busy) return true;
    }
    return false;
}

function refreshResults() {
    const maxLevel = Number.parseInt(config.max_level, 10) || 9;

    let result_classes = Object.values(classes).filter(course => {
        const courseId = course["_key"] || course["CRN"];
        if (config.course_excludes.includes(courseId)) return false;       // manually hidden
        if (config.courses.includes(courseId)) return false;               // already added
        const num = Number.parseInt(course["Course"].split(" ")[1], 10);
        if (!Number.isNaN(num) && Math.floor(num / 1000) > maxLevel) return false;
        if (!config.prefixes.includes(course["Course"].split(" ")[0])) return false;
        if (conflictsWithSchedule(course)) return false;
        return true;
    });

    // Search
    if (config.search_bar.length > 0) {
        const fuse = new Fuse(result_classes, {
            keys: ["Course", "Title", "Instructor"], minMatchCharLength: 2, threshold: 0.3
        });
        result_classes = fuse.search(config.search_bar).map(r => r.item);
    } else {
        // Favorites first, then by course code, when not running a fuzzy search
        result_classes.sort((a, b) => {
            const fa = config.favorites.includes(a["_key"] || a["CRN"]) ? 0 : 1;
            const fb = config.favorites.includes(b["_key"] || b["CRN"]) ? 0 : 1;
            if (fa !== fb) return fa - fb;
            return a["Course"].localeCompare(b["Course"]);
        });
    }

    const CAP = 200;
    const total = result_classes.length;
    const capped = total > CAP;
    if (capped) result_classes = result_classes.slice(0, CAP);

    // The list only renders the first 200 matches for performance; the number is
    // the full count after filters/search. Narrow the filters or search to see the rest.
    const countEl = document.getElementById("result_count");
    if (countEl) countEl.textContent = capped
        ? `Top ${CAP} of ${total} matches — refine to see more`
        : `${total} class${total === 1 ? "" : "es"}`;

    const body = document.getElementById("results-body");
    body.innerHTML = result_classes.map(course => renderRow(course)).join("");

    // Empty state
    const emptyEl = document.getElementById("results-empty");
    if (emptyEl) {
        if (total === 0) {
            const anyPrefix = config.prefixes.length > 0;
            emptyEl.textContent = config.search_bar
                ? `No classes match “${config.search_bar}” with your current filters.`
                : anyPrefix
                    ? "No classes match your current filters. Try widening the level, busy times, or prefixes."
                    : "No prefixes selected — pick some under Course Prefixes to see classes.";
            emptyEl.classList.remove("hidden");
        } else {
            emptyEl.classList.add("hidden");
        }
    }

    updateExclusionsCount();
    if (!document.getElementById("exclusions_menu").classList.contains("hidden")) renderExclusionsList();

    renderCoursesList();
    renderStarredList();
    renderCalendar();

    // Wire up row + list buttons
    document.querySelectorAll(".add_course_btn, .remove_course_btn, .star_course_btn, .delete_course_btn").forEach(btn =>
        btn.addEventListener("click", handleCourseButtonPress));
    initTooltips();

    justAddedCrn = null;
    justStarredCrn = null;
}

function deliveryIcon(delivery) {
    const lower = (delivery || "").toLowerCase();
    if (lower.includes("hybrid")) {
        return `<svg class="h-4 w-4 text-teal-500 dark:text-teal-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="M8.288 15.038a5.25 5.25 0 0 1 7.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 0 1 1.06 0Z"/></svg>`;
    }
    if (lower.includes("online") || lower.includes("distance")) {
        return `<svg class="h-4 w-4 text-indigo-500 dark:text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="M8.288 15.038a5.25 5.25 0 0 1 7.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 0 1 1.06 0Z"/></svg>`;
    }
    return `<svg class="h-4 w-4 text-amber-500 dark:text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z"/></svg>`;
}

function renderRow(course) {
    const id = course["_key"] || course["CRN"];
    const displayCrn = course["CRN"];
    const starred = config.favorites.includes(id);

    // Title + hoverable description (with any note appended into the tooltip)
    const detailText = course["details"] || "";
    const note = course["Notes"] || "";
    const tipText = note
        ? (detailText ? `${detailText}  •  Note: ${note}` : `Note: ${note}`)
        : detailText;
    const noteBadge = note
        ? `<span class="ml-1 align-middle inline-flex items-center rounded px-1 text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">note</span>`
        : "";
    const descDisplay = detailText || note;
    const descLine = tipText
        ? `<div class="tip-trigger cursor-help text-xs text-slate-400 dark:text-slate-500 truncate leading-snug" data-tip="${escapeAttr(tipText)}">${escapeHtml(descDisplay)}${noteBadge}</div>`
        : "";

    // Time + Days formatting
    const timeHtml = (course["Times"] || "").split("\n").map(range => {
        const [s, e] = range.split("-");
        const sm = toMinutes(s), em = toMinutes(e);
        if (sm === null || em === null) return escapeHtml(range);
        return `${formatMinutes(sm)}&nbsp;–&nbsp;${formatMinutes(em)}`;
    }).join("<br>");
    const daysHtml = escapeHtml(course["Days"] || "").replaceAll("\n", "<br>");
    const placeText = (course["Place"] || "").split("\n")[0];
    const delivery = course["_delivery"] || "";
    let locHtml = "";
    if (delivery && delivery.toLowerCase() !== "in-person") {
        locHtml = `<span class="tip-trigger cursor-help inline-flex items-center justify-center" data-tip="${escapeAttr(delivery)}">${deliveryIcon(delivery)}</span>`;
    } else if (placeText) {
        locHtml = `<span class="tip-trigger cursor-help inline-flex items-center text-slate-400 dark:text-slate-500" data-tip="${escapeAttr(placeText)}"><svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z"/></svg></span>`;
    }

    // Cap colouring
    const capVal = course["Cap"] || "";
    const [enrolled, cap] = capVal.split("/").map(v => Number.parseInt(v.trim(), 10));
    let capCls = "text-slate-500 dark:text-slate-400";
    if (!Number.isNaN(cap) && !Number.isNaN(enrolled) && cap > 0) {
        const pct = (enrolled / cap) * 100;
        capCls = pct >= 100 ? "text-red-600 dark:text-red-400 font-semibold"
            : pct > 75 ? "text-amber-600 dark:text-amber-400 font-medium"
                : "text-green-600 dark:text-green-400 font-medium";
    }

    return `<tr>
        <td class="px-2 py-1.5 text-center align-middle">
            <button class="star_course_btn btn-press text-lg leading-none ${id === justStarredCrn ? "animate-pop" : ""} ${starred ? "text-amber-400" : "text-slate-300 dark:text-slate-600 hover:text-amber-400"}" id="star_course_${id}" title="Star to compare">${starred ? "★" : "☆"}</button>
        </td>
        <td class="px-2 py-1.5 text-center align-middle whitespace-nowrap">
            <span class="inline-flex gap-2">
                <button class="add_course_btn btn-press inline-grid place-items-center h-7 w-7 rounded-lg border border-green-500/50 bg-green-500/5 text-green-600 dark:text-green-400 hover:bg-green-600 hover:text-white hover:border-green-600" id="add_course_${id}" title="Add to schedule">
                    <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14M5 12h14"/></svg>
                </button>
                <button class="remove_course_btn btn-press inline-grid place-items-center h-7 w-7 rounded-lg border border-red-500/50 bg-red-500/5 text-red-600 dark:text-red-400 hover:bg-red-600 hover:text-white hover:border-red-600" id="remove_course_${id}" title="Hide this section  (Shift-click: hide all sections of ${escapeAttr(course["Course"] || "this course")})">
                    <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14"/></svg>
                </button>
            </span>
        </td>
        ${currentSchema.showCRN ? `<td class="px-3 py-1.5 align-top whitespace-nowrap">
            <div class="font-mono tnum text-xs text-slate-500 dark:text-slate-400 leading-tight">${escapeHtml(displayCrn)}</div>
            <div class="font-mono text-[11px] leading-tight tracking-tight text-slate-400 dark:text-slate-500">${escapeHtml(course["Section"] || "—")} · ${escapeHtml(course["Cr"] || "—")}cr</div>
        </td>
        <td class="px-3 py-1.5 align-top font-semibold text-slate-800 dark:text-slate-100 whitespace-nowrap">${escapeHtml(course["Course"] || "")}</td>`
        : `<td class="px-3 py-1.5 align-top whitespace-nowrap">
            <div class="font-semibold text-slate-800 dark:text-slate-100 leading-tight">${escapeHtml(course["Course"] || "")}</div>
            <div class="font-mono text-[11px] leading-tight tracking-tight text-slate-400 dark:text-slate-500">Sec ${escapeHtml(course["Section"] || "—")} · ${escapeHtml(course["Cr"] || "—")}cr</div>
        </td>`}
        <td class="px-3 py-1.5 align-top overflow-hidden">
            <div class="font-medium text-slate-800 dark:text-slate-100 leading-snug truncate">${escapeHtml(course["Title"] || "")}</div>
            ${descLine}
        </td>
        <td class="px-3 py-1.5 align-top font-mono tnum text-slate-600 dark:text-slate-300 whitespace-nowrap">${daysHtml}</td>
        <td class="px-3 py-1.5 align-top font-mono tnum text-slate-600 dark:text-slate-300 whitespace-nowrap">${timeHtml}</td>
        <td class="px-2 py-1.5 align-middle text-center">${locHtml}</td>
        <td class="px-3 py-1.5 align-top text-slate-600 dark:text-slate-300"><div class="max-w-[10rem] truncate">${escapeHtml(course["Instructor"] || "")}</div></td>
        <td class="px-3 py-1.5 align-middle text-center tnum ${capCls}">${escapeHtml(capVal)}</td>
    </tr>`;
}

function courseAndSectionCompare(a, b) {
    const courseCmp = (a["Course"] || "").localeCompare(b["Course"] || "", undefined, {
        numeric: true,
        sensitivity: "base"
    });
    if (courseCmp !== 0) return courseCmp;
    return (a["Section"] || "").localeCompare(b["Section"] || "", undefined, {
        numeric: true,
        sensitivity: "base"
    });
}

function sortSavedCourses() {
    if (!Array.isArray(config.courses)) return;
    config.courses.sort((a, b) => {
        const ca = classes[a];
        const cb = classes[b];
        if (ca && cb) return courseAndSectionCompare(ca, cb);
        if (ca) return -1;
        if (cb) return 1;
        return 0;
    });
}

function sortStarredCourses() {
    if (!Array.isArray(config.favorites)) return;
    config.favorites.sort((a, b) => {
        const ca = classes[a];
        const cb = classes[b];
        if (ca && cb) return courseAndSectionCompare(ca, cb);
        if (ca) return -1;
        if (cb) return 1;
        return 0;
    });
}

function renderCoursesList() {
    const list = document.getElementById("courses_list");
    const empty = document.getElementById("courses_empty");
    const count = document.getElementById("courses_count");
    list.innerHTML = "";

    const valid = config.courses.filter(crn => classes[crn])
        .sort((a, b) => courseAndSectionCompare(classes[a], classes[b]));
    count.textContent = valid.length;
    empty.classList.toggle("hidden", valid.length > 0);

    for (const crn of valid) {
        const c = classes[crn];
        const color = courseColor(c["Course"]);
        const showConflicts = (config.show_conflict_crns || []).includes(crn);
        list.innerHTML += `<li class="flex flex-col gap-1.5 text-sm ${crn === justAddedCrn ? "animate-in" : ""}">
            <div class="flex items-start gap-2">
                <span class="mt-1 h-2.5 w-2.5 rounded-full shrink-0" style="background:${color}"></span>
                <span class="tip-trigger cursor-help flex-1 min-w-0" data-tip-crn="${escapeAttr(crn)}">
                    <span class="font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(c["Course"])}</span>
                    <span class="font-mono text-xs text-slate-400 dark:text-slate-500"> Sec ${escapeHtml(c["Section"] || "—")}</span>
                    <span class="text-slate-500 dark:text-slate-400"> · ${escapeHtml(c["Title"])}</span>
                </span>
                <button class="delete_course_btn btn-press shrink-0 grid place-items-center h-5 w-5 rounded text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors" id="delete_course_${crn}" title="Remove">
                    <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>
                </button>
            </div>
            <label class="flex items-center gap-2 pl-[18px] cursor-pointer select-none" title="When on, classes that clash only with this course stay visible in the results">
                <button class="show_conflict_toggle switch switch-sm" role="switch" aria-checked="${showConflicts}" data-crn="${escapeAttr(crn)}" type="button"><span class="switch-thumb"></span></button>
                <span class="text-xs text-slate-500 dark:text-slate-400">Show conflicting classes</span>
            </label>
        </li>`;
    }

    list.querySelectorAll(".show_conflict_toggle").forEach(btn =>
        btn.addEventListener("click", () => toggleShowConflict(btn.dataset.crn)));
}

function toggleShowConflict(crn) {
    if (!Array.isArray(config.show_conflict_crns)) config.show_conflict_crns = [];
    if (config.show_conflict_crns.includes(crn)) {
        config.show_conflict_crns = config.show_conflict_crns.filter(c => c !== crn);
    } else {
        config.show_conflict_crns.push(crn);
    }
    saveConfig();
    refreshResults();
}

// Meetings of every saved course, grouped by weekday (for conflict comparison).
function savedMeetingsByDay() {
    const byDay = [[], [], [], [], [], [], []];
    for (const crn of config.courses) {
        const c = classes[crn];
        if (!c) continue;
        for (const m of parseMeetings(c)) byDay[m.day].push({...m, crn});
    }
    return byDay;
}

// Does a starred class clash with the saved schedule? Returns the first clashing course.
function favoriteConflict(crn) {
    const course = classes[crn];
    if (!course) return {state: "missing"};
    const meets = parseMeetings(course);
    if (meets.length === 0) return {state: "notimes"};
    const saved = savedMeetingsByDay();
    const margin = Number.parseInt(config.margin_time, 10) || 0;
    for (const m of meets) {
        for (const s of saved[m.day]) {
            if (s.crn === crn) continue; // don't clash with itself
            if (m.start < s.end + margin && s.start - margin < m.end) {
                return {state: "conflict", withCourse: classes[s.crn] ? classes[s.crn]["Course"] : ""};
            }
        }
    }
    return {state: "fits"};
}

// Short "Mon 9:00 AM, Wed 9:00 AM" style summary of a class's meetings.
function meetingsSummary(course) {
    const meets = parseMeetings(course);
    if (meets.length === 0) return "No scheduled meeting time";
    return meets.map(m => `${dayShort[m.day]} ${formatMinutes(m.start)}`).join(" · ");
}

function renderStarredList() {
    const list = document.getElementById("starred_list");
    const empty = document.getElementById("starred_empty");
    const count = document.getElementById("starred_count");
    if (!list) return;

    const valid = config.favorites.filter(crn => classes[crn]);
    count.textContent = valid.length;
    empty.classList.toggle("hidden", valid.length > 0);
    list.innerHTML = "";

    const order = {conflict: 0, fits: 1, notimes: 2, missing: 3};
    const decorated = valid.map(crn => ({crn, info: favoriteConflict(crn)}));
    decorated.sort((a, b) => {
        const courseCmp = courseAndSectionCompare(classes[a.crn], classes[b.crn]);
        if (courseCmp !== 0) return courseCmp;
        return order[a.info.state] - order[b.info.state];
    });

    for (const {crn, info} of decorated) {
        const c = classes[crn];
        const color = courseColor(c["Course"]);
        const saved = config.courses.includes(crn);

        let badge;
        if (info.state === "conflict") {
            badge = `<span class="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded-md bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-300" title="Overlaps ${escapeAttr(info.withCourse)}">Conflict</span>`;
        } else if (info.state === "fits") {
            badge = `<span class="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded-md bg-green-50 text-green-600 dark:bg-green-500/15 dark:text-green-300">Fits</span>`;
        } else {
            badge = `<span class="shrink-0 text-[11px] font-medium px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500">No times</span>`;
        }

        const action = saved
            ? `<span class="shrink-0 grid place-items-center h-6 w-6 text-green-500" title="Already in your schedule">
                   <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m5 13 4 4L19 7"/></svg>
               </span>`
            : `<button class="add_course_btn shrink-0 grid place-items-center h-6 w-6 rounded-md border border-green-500/60 text-green-600 dark:text-green-400 hover:bg-green-600 hover:text-white hover:border-green-600 transition-colors font-bold" id="add_course_${crn}" title="Add to schedule">+</button>`;

        list.innerHTML += `<li class="flex items-start gap-2 text-sm">
            <button class="star_course_btn shrink-0 text-amber-400 text-base leading-none mt-0.5" id="star_course_${crn}" title="Remove star">★</button>
            <span class="tip-trigger cursor-help flex-1 min-w-0" data-tip-crn="${escapeAttr(crn)}">
                <span class="flex items-center gap-1.5">
                    <span class="h-2.5 w-2.5 rounded-full shrink-0" style="background:${color}"></span>
                    <span class="font-semibold text-slate-800 dark:text-slate-100 truncate">${escapeHtml(c["Course"])}</span>
                    <span class="font-mono text-xs text-slate-400 dark:text-slate-500 shrink-0">Sec ${escapeHtml(c["Section"] || "—")}</span>
                </span>
                <span class="block text-xs text-slate-400 dark:text-slate-500 truncate font-mono tnum mt-0.5">${escapeHtml(meetingsSummary(c))}</span>
            </span>
            ${badge}
            ${action}
        </li>`;
    }
}

function closestEl(el, sel) {
    return el && typeof el.closest === "function" ? el.closest(sel) : null;
}

function animateOutThen(el, cb) {
    if (!el) { cb(); return; }
    el.classList.add("animate-out");
    setTimeout(cb, 170);
}

function handleCourseButtonPress(e) {
    // The clicked target may be an inner <svg>/<path>; resolve to the owning button.
    const btn = (e.currentTarget && e.currentTarget.id) ? e.currentTarget
        : (e.target.closest ? e.target.closest("button") : null);
    const id = (btn && btn.id) ? btn.id : (e.target && e.target.id) || "";
    const parts = id.split("_");
    const type = parts[0];
    const crn = parts.slice(2).join("_");
    if (!crn) return;

    switch (type) {
        case "add":
            if (!config.courses.includes(crn)) config.courses.push(crn);
            sortSavedCourses();
            config.course_excludes = config.course_excludes.filter(c => c !== crn);
            justAddedCrn = crn;
            calculateSchedule();
            saveConfig();
            refreshResults();
            break;
        case "delete":
            animateOutThen(closestEl(btn, "li"), () => {
                config.courses = config.courses.filter(c => c !== crn);
                config.show_conflict_crns = (config.show_conflict_crns || []).filter(c => c !== crn);
                calculateSchedule();
                saveConfig();
                refreshResults();
            });
            break;
        case "remove":
            if (e.shiftKey) {
                // Shift-click: hide every section sharing this course number.
                const courseCode = classes[crn] ? classes[crn]["Course"] : null;
                if (courseCode) {
                    for (const c of Object.values(classes)) {
                        if (c["Course"] !== courseCode) continue;
                        const cid = c["_key"] || c["CRN"];
                        if (!config.course_excludes.includes(cid)) config.course_excludes.push(cid);
                    }
                } else if (!config.course_excludes.includes(crn)) {
                    config.course_excludes.push(crn);
                }
                saveConfig();
                refreshResults();
            } else {
                if (!config.course_excludes.includes(crn)) config.course_excludes.push(crn);
                animateOutThen(closestEl(btn, "tr"), () => {
                    saveConfig();
                    refreshResults();
                });
            }
            break;
        case "star":
            if (config.favorites.includes(crn)) {
                config.favorites = config.favorites.filter(c => c !== crn);
            } else {
                config.favorites.push(crn);
                justStarredCrn = crn;
            }
            saveConfig();
            refreshResults();
            break;
    }
}

// --------------------------------------------------------------------------
// Schedule model (busy windows + added courses)
// --------------------------------------------------------------------------

function calculateSchedule() {
    schedule = [[], [], [], [], [], [], []];
    if (config.busy_enabled !== false) {
        for (let i = 0; i < WEEKDAYS; i++) {
            const pre = toMinutes(config[`schedule_exclude_${i}_pre`].replace(":", ""));
            const post = toMinutes(config[`schedule_exclude_${i}_post`].replace(":", ""));
            if (pre !== null && post !== null && post > pre) {
                schedule[i].push({start: pre, end: post, name: "Busy", id: "schedule_exclude"});
            }
        }
    }
    for (const crn of config.courses) {
        const course = classes[crn];
        if (!course) continue;
        for (const m of parseMeetings(course)) {
            schedule[m.day].push({start: m.start, end: m.end, name: course["Course"], id: crn});
        }
    }
}

// --------------------------------------------------------------------------
// Calendar
// --------------------------------------------------------------------------

function courseHue(courseCode) {
    let hash = 0;
    for (let i = 0; i < courseCode.length; i++) hash = (hash * 31 + courseCode.charCodeAt(i)) >>> 0;
    return hash % 360;
}

function courseColor(courseCode) {
    return `hsl(${courseHue(courseCode)} 62% 45%)`;
}

function renderCalendar() {
    const container = document.getElementById("calendar");
    if (!container) return;
    hideCalendarActionMenu();

    // Collect blocks: added courses (colored) + busy windows (muted).
    const blocks = [[], [], [], [], [], [], []];
    let usedDays = new Set();
    let minM = Infinity, maxM = -Infinity;

    for (const crn of config.courses) {
        const course = classes[crn];
        if (!course) continue;
        const color = courseColor(course["Course"]);
        for (const m of parseMeetings(course)) {
            blocks[m.day].push({...m, label: course["Course"], sub: course["Place"] || "", color, busy: false, crn});
            usedDays.add(m.day);
            minM = Math.min(minM, m.start);
            maxM = Math.max(maxM, m.end);
        }
    }
    for (let i = 0; i < WEEKDAYS; i++) {
        for (const ev of schedule[i]) {
            if (ev.id !== "schedule_exclude") continue;
            blocks[i].push({day: i, start: ev.start, end: ev.end, label: "Busy", sub: "", busy: true});
            usedDays.add(i);
            minM = Math.min(minM, ev.start);
            maxM = Math.max(maxM, ev.end);
        }
    }

    // Compare mode: overlay starred-but-not-saved classes as hatched "ghost" blocks,
    // flagging any that clash with the saved schedule.
    if (config.compare_starred) {
        const saved = savedMeetingsByDay();
        const margin = Number.parseInt(config.margin_time, 10) || 0;
        for (const crn of config.favorites) {
            const course = classes[crn];
            if (!course || config.courses.includes(crn)) continue;
            const hue = courseHue(course["Course"]);
            for (const m of parseMeetings(course)) {
                const clash = saved[m.day].some(s => m.start < s.end + margin && s.start - margin < m.end);
                blocks[m.day].push({day: m.day, start: m.start, end: m.end, label: course["Course"], sub: course["Place"] || "", ghost: true, conflict: clash, hue, crn});
                usedDays.add(m.day);
                minM = Math.min(minM, m.start);
                maxM = Math.max(maxM, m.end);
            }
        }
    }

    const countEl = document.getElementById("calendar_count");
    const nCourses = config.courses.filter(c => classes[c]).length;
    if (countEl) countEl.textContent = `${nCourses} class${nCourses === 1 ? "" : "es"}`;

    if (!isFinite(minM)) {
        container.innerHTML = `<div class="py-10 text-center text-sm text-slate-400 dark:text-slate-500">
            Add courses (or set busy times) to see them laid out across the week.</div>`;
        return;
    }

    // Always show at least Mon–Fri; include weekend columns only if used.
    let dayCols = [0, 1, 2, 3, 4];
    if (usedDays.has(5)) dayCols.push(5);
    if (usedDays.has(6)) dayCols.push(6);

    // Round the visible window to whole hours with a little padding.
    const startHour = Math.floor(minM / 60);
    const endHour = Math.ceil(maxM / 60);
    const HOUR_H = 56;
    const winStart = startHour * 60;
    const totalMin = (endHour - startHour) * 60;
    const bodyHeight = (totalMin / 60) * HOUR_H;
    const isDark = document.documentElement.classList.contains("dark");
    const lineColor = isDark ? "rgba(148,163,184,0.16)" : "rgba(100,116,139,0.14)";

    // Hour gutter labels
    let hourLabels = "";
    for (let h = startHour; h <= endHour; h++) {
        const top = (h - startHour) * HOUR_H;
        const last = h === endHour;
        hourLabels += `<div class="absolute right-2 -translate-y-1/2 text-[11px] text-slate-400 dark:text-slate-500 tabular-nums ${last ? "hidden" : ""}" style="top:${top}px">${formatMinutes(h * 60).replace(" ", " ")}</div>`;
    }

    // Day columns
    const colsHTML = dayCols.map(d => {
        const dayBlocks = layoutDay(blocks[d]);
        const blocksHTML = dayBlocks.map(b => {
            const top = ((b.start - winStart) / 60) * HOUR_H;
            const height = Math.max(((b.end - b.start) / 60) * HOUR_H, 18);
            const widthPct = 100 / b.cols;
            const leftPct = b.col * widthPct;
            if (b.busy) {
                return `<div class="absolute rounded-md border border-dashed border-slate-300 dark:border-slate-600 bg-slate-200/50 dark:bg-slate-700/30 text-slate-400 dark:text-slate-500 text-[10px] px-1.5 py-1 overflow-hidden"
                    style="top:${top}px;height:${height}px;left:calc(${leftPct}% + 2px);width:calc(${widthPct}% - 4px)">Busy</div>`;
            }
            if (b.ghost) {
                const border = b.conflict ? "border-red-500" : "border-slate-400/80 dark:border-slate-400/60";
                const textColor = `hsl(${b.hue} 60% ${isDark ? 70 : 38}%)`;
                const ghostFill = `hsl(${b.hue} 62% 50% / 0.4)`;
                return `<div class="tip-trigger calendar_action_block cal-ghost absolute rounded-md border-2 border-dashed ${border} text-[11px] leading-tight px-1.5 py-1 overflow-hidden cursor-pointer" data-tip-crn="${escapeAttr(b.crn)}" data-cal-kind="starred" tabindex="0"
                    style="top:${top}px;height:${height}px;left:calc(${leftPct}% + 2px);width:calc(${widthPct}% - 4px);--ghost:${ghostFill};color:${textColor}">
                    <div class="font-bold truncate flex items-center gap-0.5"><span>★</span>${b.label}</div>
                    ${b.conflict ? `<div class="truncate font-semibold text-red-500">Clash</div>` : `<div class="truncate opacity-80">${formatMinutes(b.start)}</div>`}
                </div>`;
            }
            return `<div class="tip-trigger calendar_action_block absolute rounded-md text-white text-[11px] leading-tight px-1.5 py-1 overflow-hidden shadow-sm cursor-pointer" data-tip-crn="${escapeAttr(b.crn)}" data-cal-kind="saved" tabindex="0"
                style="top:${top}px;height:${height}px;left:calc(${leftPct}% + 2px);width:calc(${widthPct}% - 4px);background:${b.color}">
                <div class="font-semibold truncate">${b.label}</div>
                <div class="opacity-90 truncate">${formatMinutes(b.start).replace(" ", " ")}</div>
                ${height > 46 && b.sub ? `<div class="opacity-80 truncate">${b.sub}</div>` : ""}
            </div>`;
        }).join("");
        return `<div class="flex-1 min-w-[88px] flex flex-col">
            <div class="text-center text-xs font-semibold text-slate-500 dark:text-slate-400 pb-2">${dayShort[d]}</div>
            <div class="relative cal-grid-lines border-l border-slate-100 dark:border-slate-800" style="--hour-h:${HOUR_H}px;--cal-line:${lineColor};height:${bodyHeight}px">${blocksHTML}</div>
        </div>`;
    }).join("");

    container.innerHTML = `<div class="flex min-w-max">
        <div class="relative w-14 shrink-0" style="margin-top:1.75rem">${hourLabels}</div>
        <div class="flex flex-1 gap-0">${colsHTML}</div>
    </div>`;

    initTooltips(); // bind hover details for the freshly rendered blocks
    initCalendarActionMenu(container);
}

function initCalendarActionMenu(container) {
    if (container.dataset.calendarActionBound) return;
    container.dataset.calendarActionBound = "1";
    container.addEventListener("click", e => {
        const block = closestEl(e.target, ".calendar_action_block");
        if (!block) return;
        e.stopPropagation();
        showCalendarActionMenu(block);
    });
    container.addEventListener("keydown", e => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const block = closestEl(e.target, ".calendar_action_block");
        if (!block) return;
        e.preventDefault();
        showCalendarActionMenu(block);
    });
}

function calendarActionMenuEl() {
    let menu = document.getElementById("calendar_action_menu");
    if (menu) return menu;
    menu = document.createElement("div");
    menu.id = "calendar_action_menu";
    menu.className = "hidden overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg text-sm";
    menu.style.position = "fixed";
    menu.style.zIndex = "50";
    menu.style.minWidth = "11rem";
    document.body.appendChild(menu);
    return menu;
}

function showCalendarActionMenu(block) {
    const crn = block.dataset.tipCrn;
    const kind = block.dataset.calKind;
    const course = classes[crn];
    if (!crn || !course) return;
    calendarActionCrn = crn;
    document.getElementById("floating-tip").classList.remove("visible");

    const title = `${course["Course"]} · Sec ${course["Section"] || "—"}`;
    const actions = kind === "starred"
        ? [
            {action: "add", label: "Add to schedule", icon: "+"},
            {action: "unstar", label: "Unstar", icon: "★"}
        ]
        : [
            {action: "move-starred", label: "Move to starred", icon: "★"},
            {action: "remove-saved", label: "Remove from schedule", icon: "x"}
        ];

    const menu = calendarActionMenuEl();
    menu.innerHTML = `<div class="px-3 py-2 border-b border-slate-100 dark:border-slate-800">
            <div class="font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(title)}</div>
            <div class="text-xs text-slate-400 dark:text-slate-500 truncate">${escapeHtml(course["Title"] || "")}</div>
        </div>
        <div class="py-1">
            ${actions.map(a => `<button class="calendar_action_btn w-full flex items-center gap-2 px-3 py-2 text-left text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors" type="button" data-action="${a.action}">
                <span class="w-4 text-center text-slate-400 dark:text-slate-500">${a.icon}</span>
                <span>${a.label}</span>
            </button>`).join("")}
        </div>`;

    menu.querySelectorAll(".calendar_action_btn").forEach(btn =>
        btn.addEventListener("click", e => {
            e.stopPropagation();
            runCalendarAction(btn.dataset.action);
        }));

    menu.classList.remove("hidden");
    const r = block.getBoundingClientRect();
    const mr = menu.getBoundingClientRect();
    let left = r.left + r.width / 2 - mr.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - mr.width - 8));
    let top = r.bottom + 8;
    if (top + mr.height > window.innerHeight - 8) top = r.top - mr.height - 8;
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.max(8, top)}px`;
}

function hideCalendarActionMenu() {
    const menu = document.getElementById("calendar_action_menu");
    if (menu) menu.classList.add("hidden");
    calendarActionCrn = null;
}

function runCalendarAction(action) {
    const crn = calendarActionCrn;
    if (!crn) return;
    if (action === "add") {
        if (!config.courses.includes(crn)) config.courses.push(crn);
        sortSavedCourses();
        config.course_excludes = config.course_excludes.filter(c => c !== crn);
        justAddedCrn = crn;
    } else if (action === "unstar") {
        config.favorites = config.favorites.filter(c => c !== crn);
    } else if (action === "move-starred") {
        config.courses = config.courses.filter(c => c !== crn);
        config.show_conflict_crns = (config.show_conflict_crns || []).filter(c => c !== crn);
        if (!config.favorites.includes(crn)) config.favorites.push(crn);
        justStarredCrn = crn;
    } else if (action === "remove-saved") {
        config.courses = config.courses.filter(c => c !== crn);
        config.show_conflict_crns = (config.show_conflict_crns || []).filter(c => c !== crn);
    }
    hideCalendarActionMenu();
    calculateSchedule();
    saveConfig();
    refreshResults();
}

// Resolve overlapping blocks within one day into side-by-side columns.
function layoutDay(items) {
    const sorted = items.slice().sort((a, b) => a.start - b.start || a.end - b.end);
    const result = [];
    let cluster = [];
    let clusterEnd = -Infinity;

    const flush = () => {
        if (!cluster.length) return;
        const colsEnd = []; // end time of last block in each column
        for (const it of cluster) {
            let placed = false;
            for (let c = 0; c < colsEnd.length; c++) {
                if (it.start >= colsEnd[c]) {
                    it.col = c;
                    colsEnd[c] = it.end;
                    placed = true;
                    break;
                }
            }
            if (!placed) {
                it.col = colsEnd.length;
                colsEnd.push(it.end);
            }
        }
        const nCols = colsEnd.length;
        for (const it of cluster) {
            it.cols = nCols;
            result.push(it);
        }
        cluster = [];
        clusterEnd = -Infinity;
    };

    for (const it of sorted) {
        if (it.start >= clusterEnd && cluster.length) flush();
        cluster.push(it);
        clusterEnd = Math.max(clusterEnd, it.end);
    }
    flush();
    return result;
}

// --------------------------------------------------------------------------
// Tooltips (single floating element; never clipped by table overflow)
// --------------------------------------------------------------------------

function initTooltips() {
    const tip = document.getElementById("floating-tip");
    document.querySelectorAll(".tip-trigger").forEach(el => {
        if (el.dataset.tipBound) return;
        el.dataset.tipBound = "1";
        el.addEventListener("mouseenter", () => showTip(el, tip));
        el.addEventListener("mouseleave", () => tip.classList.remove("visible"));
        el.addEventListener("focus", () => showTip(el, tip));
        el.addEventListener("blur", () => tip.classList.remove("visible"));
    });
}

function showTip(el, tip) {
    // Rich card (full class details) when data-tip-crn is present, else plain text.
    if (el.dataset.tipCrn) {
        const html = classDetailsHtml(el.dataset.tipCrn);
        if (!html) return;
        tip.innerHTML = html;
    } else {
        const text = el.dataset.tip;
        if (!text) return;
        tip.textContent = text;
    }
    tip.classList.add("visible");
    const r = el.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
    let top = r.top - tr.height - 8;
    if (top < 8) top = r.bottom + 8; // flip below if no room above
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
}

// Build a small details card (HTML) for a class, used by calendar blocks and the
// saved/starred lists.
function classDetailsHtml(crn) {
    const c = classes[crn];
    if (!c) return "";
    const row = (label, value) => value
        ? `<div class="flex gap-2"><span class="shrink-0 w-16 text-slate-400">${label}</span><span class="text-slate-100">${escapeHtml(value)}</span></div>`
        : "";
    const times = (c["Times"] || "").split("\n").map((rng, i) => {
        const [s, e] = rng.split("-");
        const sm = toMinutes(s), em = toMinutes(e);
        const day = (c["Days"] || "").split("\n")[i] || "";
        if (sm === null || em === null) return day;
        return `${day} ${formatMinutes(sm)}–${formatMinutes(em)}`;
    }).filter(Boolean).join("; ");

    return `<div class="text-left space-y-1">
        <div class="font-semibold text-white">${escapeHtml(c["Course"])} · Sec ${escapeHtml(c["Section"] || "—")}</div>
        <div class="text-slate-200">${escapeHtml(c["Title"] || "")}</div>
        <div class="pt-1 space-y-0.5">
            ${row("When", times)}
            ${row("Where", (c["Place"] || "").replaceAll("\n", ", "))}
            ${row("Instructor", c["Instructor"])}
            ${row("Credits", c["Cr"])}
            ${row("Seats", c["Cap"])}
            ${row("CRN", c["CRN"])}
        </div>
        ${c["details"] ? `<div class="pt-1 text-slate-300 border-t border-white/10 mt-1">${escapeHtml(c["details"])}</div>` : ""}
        ${c["Notes"] ? `<div class="pt-1 text-amber-300">Note: ${escapeHtml(c["Notes"])}</div>` : ""}
    </div>`;
}

// --------------------------------------------------------------------------
// Utils
// --------------------------------------------------------------------------

function escapeAttr(str) {
    return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\n", " ");
}

function escapeHtml(str) {
    return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}
