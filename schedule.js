// ---------------------------------------------------------------------------
// Class Schedule Picker — client-side, static. No backend.
// ---------------------------------------------------------------------------

let classes = [];
const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const dayShort = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAYS = 5; // busy-time inputs cover Mon–Fri
const DEFAULT_RESULT_COLUMNS = ["crn", "course", "title", "days", "time", "instructor", "cap"];
const ALL_RESULT_COLUMNS = [...DEFAULT_RESULT_COLUMNS, "location"];

let config = {
    "min_level": 0,
    "max_level": 4,
    "prefixes_open": true,
    "schedule_exclude_open": false,
    "calendar_open": true,
    "solver_open": false,
    "solver_excluded": [],
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
    "l2_enabled": false,
    "visible_result_columns": DEFAULT_RESULT_COLUMNS.slice(),
    "compare_starred": true,
    "active_tab": "saved",
    "busy_enabled": false,
    "busy_all_pre": "07:00",
    "busy_all_post": "09:00",
    "prefix_presets": [],
    "show_conflict_crns": [],
    // Schedules are live workspaces: each holds its own courses/favorites/conflicts.
    // The active one is mirrored into courses/favorites/show_conflict_crns above.
    "schedules": [],
    "active_schedule": 0,
    "school": "",
    "term": "",
    // Per-school accent name (key into ACCENT_PALETTES). Defaults to red everywhere.
    "school_accents": {},
    // Per-(school|term) selection state lives here; the active workspace is mirrored
    // into the top-level fields below so the rest of the code stays workspace-agnostic.
    "workspaces": {}
};

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

// no-store: the registry is tiny and changes on every catalog update — a stale cached copy
// would hide a newly added school/term from returning visitors.
fetch('./classfiles.json', { cache: 'no-store' }).then(r => r.json()).then(async cfd => {
    classfilesData = cfd;
    // Fire-and-forget: the app must never wait on a network health check to render.
    // Sync resolves in the background and reloads only if the cloud has newer data.
    if (window.SyncClient) SyncClient.init();
    loadConfig();
    // Validate stored school/term against classfiles; fall back to first available.
    if (!classfilesData[config.school]) config.school = Object.keys(classfilesData)[0] || "";
    const schoolEntry = classfilesData[config.school] || {};
    const availTerms = Object.keys(schoolEntry).filter(k => !k.startsWith("_"))
        .sort((a, b) => termSortKey(b) - termSortKey(a));
    if (!availTerms.includes(config.term)) config.term = availTerms[0] || "";
    migrateLegacyWorkspace();
    loadWorkspace();
    applyAccent(config.school);
    await loadSchoolData(config.school, config.term);
    if (sanitizeCourseExcludes()) saveConfig();
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

// "3.00" → "3", "1.50" → "1.5", "" → "" — trim trailing-zero credit strings.
function creditLabel(v) {
    const s = String(v ?? "").trim();
    if (!s) return "";
    const n = parseFloat(s);
    return Number.isNaN(n) ? s : String(n);
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
    // Single choke point for "local state changed" — the cloud push is debounced,
    // since this runs on every keystroke in the search box.
    if (window.SyncClient) SyncClient.markDirty();
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
// Accent theming — the accent palette is swappable per school at runtime.
// Each palette is [50,100,200,300,400,500,600,700] as oklch strings.
// --------------------------------------------------------------------------

const ACCENT_PALETTES = {
    red: ["oklch(0.971 0.013 17.4)", "oklch(0.936 0.032 17.7)", "oklch(0.885 0.062 18.3)",
        "oklch(0.808 0.108 19.6)", "oklch(0.704 0.176 22.2)", "oklch(0.637 0.222 25.3)",
        "oklch(0.577 0.226 27.3)", "oklch(0.505 0.213 27.5)"],
    // Alternates available for per-school theming (both schools default to red).
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

function applyAccent(school) {
    const name = (config.school_accents && config.school_accents[school]) || "red";
    const palette = ACCENT_PALETTES[name] || ACCENT_PALETTES.red;
    const steps = [50, 100, 200, 300, 400, 500, 600, 700];
    steps.forEach((step, i) => document.documentElement.style.setProperty(`--accent-${step}`, palette[i]));
}

// --------------------------------------------------------------------------
// Per-school/term workspaces — keep each school+term's selections separate.
// --------------------------------------------------------------------------

function workspaceKey(school = config.school, term = config.term) {
    return school + "|" + term;
}

const blankSchedule = (name = "Schedule 1") => ({
    name, courses: [], favorites: [], show_conflict_crns: []
});

const workspaceDefaults = () => ({
    prefixes: ["*"], prefix_presets: [], course_excludes: [], solver_excluded: [],
    l2_enabled: false, visible_result_columns: DEFAULT_RESULT_COLUMNS.slice(),
    schedules: [blankSchedule()], active_schedule: 0
});

// Coerce any stored workspace (current or older formats) into the live-schedules
// shape: { prefixes, prefix_presets, course_excludes, schedules[], active_schedule }.
function normalizeWorkspace(ws) {
    const defs = workspaceDefaults();
    if (!ws || typeof ws !== "object") return defs;
    const base = {
        prefixes: Array.isArray(ws.prefixes) ? ws.prefixes.slice() : defs.prefixes,
        prefix_presets: Array.isArray(ws.prefix_presets) ? ws.prefix_presets.slice() : [],
        course_excludes: Array.isArray(ws.course_excludes) ? ws.course_excludes.slice() : [],
        solver_excluded: Array.isArray(ws.solver_excluded) ? ws.solver_excluded.slice() : [],
        l2_enabled: ws.l2_enabled === true,
        visible_result_columns: sanitizeResultColumns(ws.visible_result_columns)
    };
    const cleanSched = s => ({
        name: s && s.name || "Schedule",
        courses: Array.isArray(s && s.courses) ? s.courses.slice() : [],
        favorites: Array.isArray(s && s.favorites) ? s.favorites.slice() : [],
        show_conflict_crns: Array.isArray(s && s.show_conflict_crns) ? s.show_conflict_crns.slice() : []
    });
    if (Array.isArray(ws.schedules) && ws.schedules.length) {
        // Already in the new format.
        base.schedules = ws.schedules.map(cleanSched);
        base.active_schedule = Number.isInteger(ws.active_schedule) ? ws.active_schedule : 0;
    } else {
        // Older format: workspace-level courses/favorites + schedule_presets snapshots.
        const schedules = [cleanSched({
            name: "Schedule 1", courses: ws.courses, favorites: ws.favorites,
            show_conflict_crns: ws.show_conflict_crns
        })];
        if (Array.isArray(ws.schedule_presets)) {
            for (const p of ws.schedule_presets) schedules.push(cleanSched(p));
        }
        base.schedules = schedules;
        base.active_schedule = 0;
    }
    if (base.active_schedule < 0 || base.active_schedule >= base.schedules.length) base.active_schedule = 0;
    return base;
}

// Write the active schedule's contents from the top-level mirror fields.
function syncActiveSchedule() {
    if (!Array.isArray(config.schedules) || !config.schedules.length) {
        config.schedules = [blankSchedule()];
        config.active_schedule = 0;
    }
    let i = config.active_schedule || 0;
    if (i < 0 || i >= config.schedules.length) i = 0;
    config.active_schedule = i;
    config.schedules[i] = {
        name: config.schedules[i].name || `Schedule ${i + 1}`,
        courses: (config.courses || []).slice(),
        favorites: (config.favorites || []).slice(),
        show_conflict_crns: (config.show_conflict_crns || []).slice()
    };
}

// Mirror the active schedule into the top-level course/favorite/conflict fields.
function loadActiveSchedule() {
    if (!Array.isArray(config.schedules) || !config.schedules.length) config.schedules = [blankSchedule()];
    let i = config.active_schedule || 0;
    if (i < 0 || i >= config.schedules.length) i = 0;
    config.active_schedule = i;
    const s = config.schedules[i];
    config.courses = (s.courses || []).slice();
    config.favorites = (s.favorites || []).slice();
    config.show_conflict_crns = (s.show_conflict_crns || []).slice();
}

// Mirror the active selection fields back into the workspace store.
function syncWorkspace() {
    if (!config.workspaces || typeof config.workspaces !== "object") config.workspaces = {};
    if (!config.school && !config.term) return; // nothing meaningful to scope yet
    syncActiveSchedule();
    config.workspaces[workspaceKey()] = {
        prefixes: (config.prefixes || ["*"]).slice(),
        prefix_presets: (config.prefix_presets || []).slice(),
        course_excludes: (config.course_excludes || []).slice(),
        solver_excluded: (config.solver_excluded || []).slice(),
        l2_enabled: config.l2_enabled === true,
        visible_result_columns: sanitizeResultColumns(config.visible_result_columns),
        schedules: config.schedules.map(s => ({
            name: s.name,
            courses: (s.courses || []).slice(),
            favorites: (s.favorites || []).slice(),
            show_conflict_crns: (s.show_conflict_crns || []).slice()
        })),
        active_schedule: config.active_schedule || 0
    };
}

// Load a workspace into the top-level fields (defaults if absent).
function loadWorkspace() {
    if (!config.workspaces || typeof config.workspaces !== "object") config.workspaces = {};
    const ws = normalizeWorkspace(config.workspaces[workspaceKey()]);
    config.prefixes = ws.prefixes;
    config.prefix_presets = ws.prefix_presets;
    config.course_excludes = ws.course_excludes;
    config.solver_excluded = ws.solver_excluded;
    config.l2_enabled = ws.l2_enabled;
    config.visible_result_columns = ws.visible_result_columns;
    config.schedules = ws.schedules;
    config.active_schedule = ws.active_schedule;
    loadActiveSchedule();
}

function sanitizeCourseExcludes() {
    if (!Array.isArray(config.course_excludes)) {
        config.course_excludes = [];
        return true;
    }

    const seen = new Set();
    const scoped = [];
    for (const id of config.course_excludes) {
        if (!classes[id] || seen.has(id)) continue;
        seen.add(id);
        scoped.push(id);
    }

    if (scoped.length === config.course_excludes.length) return false;
    config.course_excludes = scoped;
    return true;
}

// One-time migration: configs saved before workspaces existed keep their
// selections at the top level. Fold them into the active workspace so nothing
// is lost when upgrading.
function migrateLegacyWorkspace() {
    if (!config.workspaces || typeof config.workspaces !== "object") config.workspaces = {};
    if (config.workspaces[workspaceKey()]) return; // already has a workspace (any format)
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
    const l2Path = l2PathForTerm(schoolEntry, term);
    // Probe L2 with HEAD when off (show toggle without downloading); full fetch when on.
    const l2Promise = !l2Path
        ? Promise.resolve({ available: false, data: null })
        : config.l2_enabled
            ? fetchOptionalJson("./" + l2Path, "L2 data").then(data => ({ available: !!data, data }))
            : probeOptionalResource("./" + l2Path).then(available => ({ available, data: null }));
    const [rawClasses, rawNames, l2Result] = await Promise.all([
        fetch("./" + filePath).then(r => r.json()),
        prefixPath
            ? fetch("./" + prefixPath).then(r => r.ok ? r.json() : {}).catch(() => ({}))
            : Promise.resolve(null),
        l2Promise
    ]);

    const { normalizedClasses, schema } = normalizeClasses(rawClasses, format);
    classes = normalizedClasses;
    const l2Available = !!l2Result.available;
    if (!l2Available) config.l2_enabled = false;
    const rawL2 = config.l2_enabled && l2Result.data ? l2Result.data : null;
    const l2Merge = rawL2 ? mergeL2Data(classes, rawL2) : { matched: 0, hasExplicitSectionGroups: false };
    // Features are gated on what DATA is actually present (after any L2 merge), not on a
    // per-school "L2 mode" flag. A school that ships rich data in its base catalog (CWRU)
    // gets the same features as one whose data arrives via an optional L2 file (WashU); a
    // school with only bare listings (FIT) simply lights up fewer features.
    const caps = computeCapabilities(classes, schema, l2Merge);
    currentSchema = {
        ...schema,
        l2Enabled: config.l2_enabled === true,
        hasL2: !!rawL2,
        l2Available,              // a separate L2 file exists to optionally download (WashU)
        caps,
        supportsSectionGroups: caps.sectionGroups
    };

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

function l2PathForTerm(schoolEntry, term) {
    // L2 data is entirely optional and declared explicitly in classfiles.json:
    //   "_l2": { "fall-2026": "classes/WashU/fall-2026-l2.json" }
    // No filename convention is assumed — a term with no entry (or a missing/
    // unreadable file at the declared path) simply has no L2 data available.
    const meta = schoolEntry && schoolEntry["_l2"];
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
    const path = meta[term];
    return typeof path === "string" && path ? path : null;
}

async function probeOptionalResource(path) {
    try {
        const head = await fetch(path, { method: "HEAD" });
        if (head.ok) return true;
        // Some static hosts reject HEAD; fall back to a cheap GET existence check.
        if (head.status === 405 || head.status === 501) {
            const get = await fetch(path, { method: "GET", headers: { Range: "bytes=0-0" } });
            return get.ok || get.status === 206;
        }
        return false;
    } catch (err) {
        return false;
    }
}

async function fetchOptionalJson(path, label) {
    try {
        const response = await fetch(path);
        if (!response.ok) return null;
        return await response.json();
    } catch (err) {
        console.warn(`Could not load optional ${label}.`, err);
        return null;
    }
}

function normalizeClasses(raw, format) {
    if (format === "washu") return normalizeWashU(raw);
    if (format === "cwru") return normalizeCWRU(raw);
    return normalizeFIT(raw);
}

// Scan the normalized catalog for which enrichment fields are actually present, so
// display features can be gated on data availability rather than a school/L2 toggle.
function computeCapabilities(classes, schema, l2Merge) {
    const caps = { descriptions: false, locations: false, eligibility: false, prereqs: false, sectionGroups: false };
    for (const c of Object.values(classes)) {
        if (!caps.descriptions && c["details"]) caps.descriptions = true;
        if (!caps.locations && c["Place"] && !isGenericLocation(c["Place"])) caps.locations = true;
        if (!caps.eligibility && c["_l2_eligibility"]) caps.eligibility = true;
        if (!caps.prereqs && Array.isArray(c["_l2_prereq_groups"]) && c["_l2_prereq_groups"].length) caps.prereqs = true;
        if (!caps.sectionGroups && c["_l2_format"]) caps.sectionGroups = true;
        if (caps.descriptions && caps.locations && caps.eligibility && caps.prereqs && caps.sectionGroups) break;
    }
    if (l2Merge && l2Merge.hasExplicitSectionGroups) caps.sectionGroups = true;
    return caps;
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
            // The registrar's own section id. L2 records are keyed identically, so
            // this is what lets L2 attach per-section rather than per-course.
            "_src_key": id,
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
            "_class": c["class"] || "",
            "_school": decodeURIComponent((c["school"] || "").replace(/\+/g, " "))
        };
    }
    // grouped: render sections under a single per-course header in the results table.
    return { normalizedClasses, schema: { showCRN: false, grouped: true } };
}

function normalizeCWRU(raw) {
    // CWRU (PeopleSoft, guest system) records are keyed by Class Nbr and carry EVERYTHING
    // in one file — grid fields plus the drill-in detail (description, prerequisites, full
    // instructor, room, final exam). There is no separate L2 source, so the fields other
    // schools populate via an L2 merge (`details`, `_l2_eligibility`, `_l2_prereq_groups`,
    // `_l2_format`) are set here directly, and the app's data-capability flags light up the
    // same features. Day words + 12h times + split seats mirror WashU, so it renders grouped.
    const dayWordMap = { Mon: "M", Tue: "T", Wed: "W", Thu: "R", Fri: "F", Sat: "S", Sun: "U" };
    const normalizedClasses = {};
    for (const [id, c] of Object.entries(raw)) {
        if (id.startsWith("_")) continue;
        const classNbr = c["class_nbr"] || id;
        const days = (c["days"] || "").split(/\s+/).map(d => dayWordMap[d] || "").join("");
        let times = "";
        const tm = (c["time"] || "").match(/([\d:]+\s*[AP]M)\s*-\s*([\d:]+\s*[AP]M)/i);
        if (tm) {
            const s = parseTime12hToHHMM(tm[1].trim()), e = parseTime12hToHHMM(tm[2].trim());
            if (s && e) times = `${s}-${e}`;
        }
        // Seats: the card shows Open + Taken; capacity is their sum (enrolled/cap like FIT/WashU).
        const taken = c["seats_taken"], open = c["open_seats"];
        const cap = (typeof taken === "number" && typeof open === "number")
            ? `${taken}/${taken + open}`
            : (c["status"] || "");
        // Location is already clean from the scraper; strip any trailing "(In-Person)".
        const rawPlace = c["location"] || "";
        const place = rawPlace.replace(/\s*\((?:In-Person|Online|Hybrid|Remote)\)\s*$/i, "").trim();
        const prereqGroups = (c["eligibility_parsed"] && Array.isArray(c["eligibility_parsed"].coursePrereqs))
            ? c["eligibility_parsed"].coursePrereqs : [];
        normalizedClasses[classNbr] = {
            "_key": classNbr,
            "_src_key": classNbr,       // Class Nbr is the registrar's per-section id
            "CRN": classNbr,
            "Course": c["course"] || "",
            "Title": c["title"] || "",
            "Section": c["section"] || "",
            "Cr": creditLabel(c["units"]),
            "details": c["description"] || "",
            "Notes": c["coreq_note"] || "",
            "Days": days,
            "Times": times,
            "Place": place,
            "Instructor": c["instructor"] || "",
            "Cap": cap,
            "_department": c["subject_name"] || "",
            "_delivery": c["delivery"] || "",
            "_class": c["course"] || "",
            "_component": c["component"] || "",
            "_session": c["session"] || "",
            "_dates": c["dates"] || "",
            "_school": "CWRU",
            // Course attribute badges (Cross-Listed, Consent Required, Honors, …).
            "_tags": Array.isArray(c["tags"]) ? c["tags"] : [],
            "_l2_status": c["status"] || "",   // "Open"/"Closed" — surfaced in the hover card
            // Detail fields other schools get from L2 — set directly so the same features work.
            "_l2_eligibility": c["eligibility"] || "",
            "_l2_prereq_groups": prereqGroups,
            "_l2_format": c["component"] || "",
            "_final_exam": c["final_exam"] || null
        };
    }
    // grouped: sections render under a per-course header (many sections per course).
    return { normalizedClasses, schema: { showCRN: false, grouped: true } };
}

function normalizeCourseCode(code) {
    return String(code || "").split(" - ")[0].trim().replace(/\s+/g, " ").toUpperCase();
}

function l2CourseCode(record) {
    return normalizeCourseCode(record.course || record.Course || record.class_num || record.classNum || record.code);
}

function l2SectionCode(record) {
    return String(record.section || record.section_num || record.section_number || record.sectionNumber || "").trim();
}

function isGenericLocation(value) {
    const loc = String(value || "").trim().toLowerCase();
    return loc === "danforth" || loc === "danforth campus" || loc === "main campus"
        // CWRU placeholders for a not-yet-assigned room (future term) — not real locations.
        || loc === "to be scheduled" || loc === "to be announced" || loc === "tba" || loc === "tbd";
}

function displayLocation(course) {
    const place = String(course && course["Place"] || "").split("\n").map(v => v.trim()).filter(v => v && !isGenericLocation(v)).join(", ");
    const campus = String(course && course["_campus"] || "").trim();
    return {
        place,
        campus: campus && !isGenericLocation(campus) && campus !== place ? campus : ""
    };
}

function l2Location(record) {
    const loc = record.location || record.meeting_location || record.meetingLocation || record.room || record.place || "";
    if (loc && !isGenericLocation(loc)) return loc;
    const campus = record.campus || "";
    return isGenericLocation(campus) ? "" : campus;
}

function l2SectionGroupId(record) {
    return record.section_group || record.sectionGroup || record.section_type || record.sectionType || record.component || "";
}

function normalizeL2RequirementGroups(rawGroups) {
    if (!Array.isArray(rawGroups)) return [];
    return rawGroups.map((g, i) => {
        if (typeof g === "string") return { id: g, label: g, sections: [] };
        const id = String(g.id || g.key || g.name || g.type || `group-${i + 1}`).trim();
        const label = String(g.label || g.name || g.title || id).trim();
        const sections = Array.isArray(g.sections) ? g.sections.map(s => String(s).trim()).filter(Boolean) : [];
        return { id, label, sections };
    }).filter(g => g.id);
}

function l2RequirementGroups(record) {
    return normalizeL2RequirementGroups(
        record.section_groups || record.sectionGroups || record.required_section_groups || record.requiredSectionGroups
    );
}

function mergeL2Data(normalizedClasses, rawL2) {
    const byCourse = new Map();
    const byCourseSection = new Map();
    const bySourceKey = new Map();
    const requirementGroups = new Map();
    for (const [rawKey, record] of Object.entries(rawL2 || {})) {
        if (!record || typeof record !== "object") continue;
        bySourceKey.set(rawKey, record);
        const code = l2CourseCode(record);
        if (!code) continue;
        if (!byCourse.has(code)) byCourse.set(code, []);
        byCourse.get(code).push(record);
        const section = l2SectionCode(record);
        if (section) byCourseSection.set(`${code}|${section.toUpperCase()}`, record);
        const groups = l2RequirementGroups(record);
        if (groups.length) requirementGroups.set(code, groups);
    }

    let matched = 0;
    for (const course of Object.values(normalizedClasses)) {
        const code = normalizeCourseCode(course["Course"]);
        const section = String(course["Section"] || "").trim().toUpperCase();
        // Exact section match first. WashU's L2 leaves `section` null on every
        // record, so without the source-key join every section of a course would
        // inherit one arbitrary section's details (and its component type).
        const record = bySourceKey.get(course["_src_key"])
            || byCourseSection.get(`${code}|${section}`)
            || (byCourse.get(code) || [])[0];
        const exact = bySourceKey.has(course["_src_key"]);
        if (!record) continue;
        matched++;
        const loc = l2Location(record);
        const description = record.description || record.details || "";
        const eligibility = (record.eligibility_parsed && record.eligibility_parsed.text) || record.eligibility || "";
        const prereqGroups = record.eligibility_parsed && Array.isArray(record.eligibility_parsed.coursePrereqs)
            ? record.eligibility_parsed.coursePrereqs : [];
        const sectionGroup = l2SectionGroupId(record);

        if (loc && !course["Place"]) course["Place"] = String(loc);
        if (description && String(description).length > String(course["details"] || "").length) course["details"] = String(description);
        if (record.delivery_mode && !course["_delivery"]) course["_delivery"] = record.delivery_mode;
        if (record.campus) course["_campus"] = record.campus;
        if (record.status) course["_l2_status"] = record.status;
        if (record.seats_available && !course["Cap"]) course["Cap"] = String(record.seats_available);
        if (eligibility) course["_l2_eligibility"] = eligibility;
        if (prereqGroups.length) course["_l2_prereq_groups"] = prereqGroups;
        // Only trust the component type when the record is truly this section's.
        const format = exact ? String(record.instructional_format || "").trim() : "";
        if (format) course["_l2_format"] = format;
        const groupId = sectionGroup || format;
        if (groupId) course["_l2_section_group"] = String(groupId);
        if (requirementGroups.has(code)) course["_l2_requirement_groups"] = requirementGroups.get(code);
    }

    return { matched, hasExplicitSectionGroups: requirementGroups.size > 0 };
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
                <input class="rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-1.5 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500/60" id="schedule_exclude_${i}_pre" type="time" value="${config[`schedule_exclude_${i}_pre`]}">
                <span class="text-slate-400">–</span>
                <input class="rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-1.5 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500/60" id="schedule_exclude_${i}_post" type="time" value="${config[`schedule_exclude_${i}_post`]}">
            </div>
        </div>`;
    }
    document.getElementById("schedule_excludes").innerHTML = excludeHTML;
    syncBusyAllInputs();

    // School / term selects and prefix checkboxes
    buildSchoolTermUI();
    buildPrefixList();

    // Restore scalar inputs
    document.getElementById("min_level").value = config.min_level;
    document.getElementById("max_level").value = config.max_level;
    document.getElementById("margin_time").value = config.margin_time;
    document.getElementById("dynamic_times").checked = config.dynamic_times;
    document.getElementById("search_bar").value = config.search_bar;
    applyL2ToggleState();
    renderColumnMenu();

    // Restore collapse state
    document.querySelectorAll(".collapse_toggle").forEach(applyCollapseState);

    // Event listeners (attached once at startup)
    document.getElementById("min_level").addEventListener("input", handleValueChange);
    document.getElementById("max_level").addEventListener("input", handleValueChange);
    document.getElementById("margin_time").addEventListener("input", handleValueChange);
    document.getElementById("dynamic_times").addEventListener("change", handleValueChange);
    document.getElementById("search_bar").addEventListener("input", handleSearchBarChange);
    document.getElementById("l2_toggle").addEventListener("click", toggleL2Mode);
    document.getElementById("columns_btn").addEventListener("click", toggleColumnsMenu);
    document.getElementById("prefixes_all").addEventListener("click", handlePrefixAllNone);
    document.getElementById("prefixes_none").addEventListener("click", handlePrefixAllNone);
    document.getElementById("theme_toggle").addEventListener("click", toggleTheme);
    document.getElementById("export_data_btn").addEventListener("click", exportLocalData);
    document.getElementById("import_data_btn").addEventListener("click", () => {
        document.getElementById("import_data_file").click();
    });
    document.getElementById("import_data_file").addEventListener("change", importLocalData);
    if (window.SyncClient) SyncClient.initUi();
    document.getElementById("solver_run").addEventListener("click", runSolver);
    // Delegated: the chips are re-rendered whenever the schedule changes.
    document.getElementById("solver_courses").addEventListener("click", e => {
        const btn = closestEl(e.target, ".solver_course");
        if (btn) solverToggleCourse(btn.dataset.code);
    });

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

    // Master "show conflicting classes" toggle (applies to all saved courses)
    document.getElementById("conflicts_master_toggle").addEventListener("click", toggleAllShowConflicts);

    // Prefix presets (save / restore / rename / delete)
    document.getElementById("prefixes_save").addEventListener("click", savePrefixPreset);
    renderPrefixPresets();

    // Schedules (new / duplicate / clear; switch & rename & delete wired per-pill)
    document.getElementById("schedule_new").addEventListener("click", newSchedule);
    document.getElementById("schedule_duplicate").addEventListener("click", duplicateSchedule);
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
        const menu = document.getElementById("columns_menu");
        const btn = document.getElementById("columns_btn");
        if (!menu || menu.classList.contains("hidden")) return;
        if (!menu.contains(e.target) && !btn.contains(e.target)) {
            menu.classList.add("hidden");
            btn.setAttribute("aria-expanded", "false");
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
    initSectionPopover();
    window.addEventListener("resize", syncResultsHeight);

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
        btn.classList.toggle("text-accent-600", active);
        btn.classList.toggle("dark:text-accent-300", active);
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
    btn.classList.toggle("bg-accent-600", on);
    btn.classList.toggle("border-accent-600", on);
    btn.classList.toggle("text-white", on);
    btn.classList.toggle("border-slate-200", !on);
    btn.classList.toggle("dark:border-slate-700", !on);
    btn.classList.toggle("text-slate-600", !on);
    btn.classList.toggle("dark:text-slate-300", !on);
    btn.classList.toggle("hover:bg-slate-50", !on);
    btn.classList.toggle("dark:hover:bg-slate-800", !on);
}

async function toggleL2Mode() {
    config.l2_enabled = config.l2_enabled !== true;
    saveConfig();
    applyL2ToggleState(true);
    await loadSchoolData(config.school, config.term);
    sanitizeCourseExcludes();
    buildPrefixList();
    renderColumnMenu();
    applyL2ToggleState();
    document.getElementById("results-header").innerHTML = renderTableHeader();
    calculateSchedule();
    refreshResults();
}

function applyL2ToggleState(loading = false) {
    const btn = document.getElementById("l2_toggle");
    const status = document.getElementById("l2_status");
    // The L2 slider only appears when a separate L2 file exists to optionally download.
    const available = currentSchema.l2Available === true;
    // The prereq explorer entry point shows when a prerequisite SOURCE exists for this
    // school|term — matching prereqs.js's own candidate rule. That's an available L2 file
    // (WashU; the explorer loads it itself regardless of this page's L2 toggle) OR prereq
    // data already present in the base catalog (CWRU).
    const hasPrereqs = currentSchema.l2Available === true || !!(currentSchema.caps && currentSchema.caps.prereqs);
    const prereqLink = document.getElementById("prereq_link");
    if (prereqLink) {
        prereqLink.classList.toggle("hidden", !hasPrereqs);
        prereqLink.classList.toggle("inline-flex", hasPrereqs);
        prereqLink.setAttribute("aria-hidden", hasPrereqs ? "false" : "true");
        prereqLink.tabIndex = hasPrereqs ? 0 : -1;
    }
    if (!btn) return;
    btn.classList.toggle("hidden", !available);
    btn.classList.toggle("inline-flex", available);
    if (!available) {
        btn.setAttribute("aria-hidden", "true");
        btn.title = "L2 data unavailable";
        if (status) status.textContent = "L2 unavailable";
        return;
    }
    btn.removeAttribute("aria-hidden");
    const on = config.l2_enabled === true;
    const sw = btn.querySelector(".switch");
    btn.setAttribute("aria-checked", on ? "true" : "false");
    if (sw) sw.setAttribute("aria-checked", on ? "true" : "false");
    btn.classList.toggle("bg-accent-600", on);
    btn.classList.toggle("border-accent-600", on);
    btn.classList.toggle("text-white", on);
    btn.classList.toggle("border-slate-300", !on);
    btn.classList.toggle("dark:border-slate-600", !on);
    btn.classList.toggle("text-slate-600", !on);
    btn.classList.toggle("dark:text-slate-300", !on);
    if (!status) return;
    if (loading) {
        status.textContent = "Loading L2...";
    } else if (!on) {
        status.textContent = "L2 off";
    } else if (currentSchema.hasL2) {
        status.textContent = "L2 on";
    } else {
        status.textContent = "L2 on · no data";
    }
    btn.title = status.textContent;
}

function toggleColumnsMenu(e) {
    e.stopPropagation();
    const menu = document.getElementById("columns_menu");
    const btn = document.getElementById("columns_btn");
    if (!menu || !btn) return;
    const open = menu.classList.toggle("hidden") === false;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) renderColumnMenu();
}

function renderColumnMenu() {
    const list = document.getElementById("columns_list");
    if (!list) return;
    const selected = new Set(sanitizeResultColumns(config.visible_result_columns));
    const available = availableResultColumns();
    list.innerHTML = available.map(col => `
        <label class="flex items-center gap-2 px-2.5 py-1.5 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer select-none">
            <input type="checkbox" class="result_column_toggle h-3.5 w-3.5 rounded accent-accent-600" data-column="${escapeAttr(col.id)}" ${selected.has(col.id) ? "checked" : ""}>
            <span class="text-sm text-slate-700 dark:text-slate-200">${escapeHtml(col.label)}</span>
        </label>
    `).join("");
    const note = document.getElementById("columns_note");
    if (note) {
        const hasLoc = currentSchema.caps && currentSchema.caps.locations;
        note.textContent = hasLoc
            ? "Toggle which columns appear in the results table."
            : (currentSchema.l2Available
                ? "Turn on L2 mode to add the Location column."
                : "No location data is available for this term.");
    }
    list.querySelectorAll(".result_column_toggle").forEach(input =>
        input.addEventListener("change", handleColumnToggle));
}

function handleColumnToggle(e) {
    const id = e.currentTarget.dataset.column;
    const selected = new Set(sanitizeResultColumns(config.visible_result_columns));
    if (e.currentTarget.checked) selected.add(id);
    else selected.delete(id);
    config.visible_result_columns = sanitizeResultColumns([...selected]);
    saveConfig();
    renderColumnMenu();
    document.getElementById("results-header").innerHTML = renderTableHeader();
    refreshResults();
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
                <button class="preset_rename grid place-items-center h-4 w-4 rounded text-slate-400 hover:text-accent-500" data-idx="${i}" title="Rename">
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

async function renamePrefixPreset(idx) {
    const p = config.prefix_presets[idx];
    if (!p) return;
    const name = await uiPrompt({title: "Rename preset", value: p.name});
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
        `<button class="school_item w-full text-left px-3 py-1.5 text-sm transition-colors ${s === config.school ? "font-semibold text-accent-600 dark:text-accent-400 bg-accent-50 dark:bg-accent-500/10" : "text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"}" data-school="${escapeAttr(s)}">${escapeHtml(s)}</button>`
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
        schoolLabel.textContent = newSchool;
        // Rebuild menu highlight and auto-select newest term
        schoolMenu.querySelectorAll(".school_item").forEach(b => {
            const active = b.dataset.school === newSchool;
            b.classList.toggle("font-semibold", active);
            b.classList.toggle("text-accent-600", active);
            b.classList.toggle("dark:text-accent-400", active);
            b.classList.toggle("bg-accent-50", active);
            b.classList.toggle("dark:bg-accent-500/10", active);
            b.classList.toggle("hover:bg-slate-50", !active);
            b.classList.toggle("dark:hover:bg-slate-800", !active);
        });
        const entry = classfilesData[newSchool] || {};
        const terms = Object.keys(entry).filter(k => !k.startsWith("_")).sort((a, b) => termSortKey(b) - termSortKey(a));
        const newTerm = terms[0] || "";
        termLabel.textContent = termDisplayName(newTerm);
        await switchSchoolTerm(newSchool, newTerm);
        refreshTermDropdown();
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
            b.classList.toggle("text-accent-600", active);
            b.classList.toggle("dark:text-accent-400", active);
            b.classList.toggle("bg-accent-50", active);
            b.classList.toggle("dark:bg-accent-500/10", active);
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
        `<button class="term_item w-full text-left px-3 py-1.5 text-sm transition-colors ${t === config.term ? "font-semibold text-accent-600 dark:text-accent-400 bg-accent-50 dark:bg-accent-500/10" : "text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"}" data-term="${escapeAttr(t)}">${escapeHtml(termDisplayName(t))}</button>`
    ).join("");
    if (termLabel) termLabel.textContent = termDisplayName(config.term);
}

async function switchSchoolTerm(school, term) {
    syncWorkspace();                 // persist the workspace we're leaving
    config.school = school;
    config.term = term;
    loadWorkspace();                 // restore (or default) the target workspace
    applyAccent(school);             // accent can differ per school
    await loadSchoolData(school, term);
    sanitizeCourseExcludes();        // purge hidden IDs from another school/term
    config.search_bar = "";
    document.getElementById("search_bar").value = "";
    buildPrefixList();
    applyL2ToggleState();
    renderColumnMenu();
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
            <input ${config.prefixes.includes(prefix) ? "checked" : ""} type="checkbox" class="prefix_toggle h-3.5 w-3.5 rounded accent-accent-600" id="prefix_toggle_${prefix}">
            ${labelSpan}
        </label>`;
    }).join("");

    all_prefixes.forEach(prefix =>
        document.getElementById(`prefix_toggle_${prefix}`).addEventListener("change", handlePrefixToggle));

    document.getElementById("prefixes_noresults").classList.add("hidden");
}

function sanitizeResultColumns(cols) {
    const picked = Array.isArray(cols) ? cols : DEFAULT_RESULT_COLUMNS;
    const out = [];
    for (const id of picked) {
        if (ALL_RESULT_COLUMNS.includes(id) && !out.includes(id)) out.push(id);
    }
    if (!out.length) out.push("course", "title");
    return out;
}

function resultColumnDefs() {
    // width: preferred share for table-fixed. Title has no width so it absorbs leftover space.
    // min: used only for the table's overall min-width (horizontal scroll when needed).
    return [
        { id: "crn", label: "CRN", width: "5.5rem", min: 72, available: () => !!currentSchema.showCRN },
        { id: "course", label: "Course", width: currentSchema.showCRN ? "7rem" : "9rem", min: currentSchema.showCRN ? 96 : 120, available: () => true },
        { id: "title", label: "Title", width: null, min: 160, available: () => true },
        { id: "location", label: "Location", width: "8rem", min: 112, available: () => currentSchema.caps && currentSchema.caps.locations === true },
        { id: "days", label: "Days", width: "3.5rem", min: 48, available: () => true },
        { id: "time", label: "Time", width: "12rem", min: 176, available: () => true },
        { id: "instructor", label: "Instructor", width: "8rem", min: 112, available: () => true },
        { id: "cap", label: "Cap", width: "4.5rem", min: 64, available: () => true }
    ];
}

function availableResultColumns() {
    return resultColumnDefs().filter(c => c.available());
}

function visibleResultColumns() {
    const selected = sanitizeResultColumns(config.visible_result_columns);
    const available = availableResultColumns();
    const visible = available.filter(c => selected.includes(c.id));
    if (visible.length) return visible;
    return available.filter(c => c.id === "course" || c.id === "title").slice(0, 2);
}

function updateResultsTableLayout() {
    const table = document.getElementById("results");
    if (!table) return;
    // Keep the table filling its panel; only force a floor so many columns can scroll.
    const minWidth = visibleResultColumns().reduce((sum, c) => sum + c.min, 96); // star + add
    table.style.width = "100%";
    table.style.maxWidth = "";
    table.style.minWidth = `${minWidth}px`;
}

function renderTableHeader() {
    const cols = visibleResultColumns();
    window.requestAnimationFrame(updateResultsTableLayout);
    return `<tr class="bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide shadow-sm">
        <th class="px-2 py-2.5 font-semibold text-center w-10">★</th>
        <th class="px-2 py-2.5 font-semibold text-center w-20">Add</th>
        ${cols.map(c => {
            const align = c.id === "cap" ? "text-center" : "text-left";
            const style = c.width ? ` style="width:${c.width}"` : "";
            return `<th class="px-3 py-2.5 font-semibold ${align}"${style}>${escapeHtml(c.label)}</th>`;
        }).join("")}
    </tr>`;
}

// --------------------------------------------------------------------------
// Schedules — each is a live workspace (its own courses / starred / conflicts).
// The active schedule is mirrored into config.courses/favorites/show_conflict_crns.
// --------------------------------------------------------------------------

function nextScheduleName(base = "Schedule") {
    const used = new Set((config.schedules || []).map(s => s.name));
    let n = (config.schedules || []).length + 1;
    while (used.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
}

// Create a fresh, empty schedule and switch to it.
function newSchedule() {
    syncActiveSchedule();
    config.schedules.push(blankSchedule(nextScheduleName()));
    config.active_schedule = config.schedules.length - 1;
    loadActiveSchedule();
    saveConfig();
    renderSchedulePresets(config.active_schedule);
    calculateSchedule();
    refreshResults();
}

// Copy the active schedule into a new one and switch to it.
function duplicateSchedule() {
    syncActiveSchedule();
    const cur = config.schedules[config.active_schedule] || blankSchedule();
    config.schedules.push({
        name: nextScheduleName("Schedule"),
        courses: (cur.courses || []).slice(),
        favorites: (cur.favorites || []).slice(),
        show_conflict_crns: (cur.show_conflict_crns || []).slice()
    });
    config.active_schedule = config.schedules.length - 1;
    loadActiveSchedule();
    saveConfig();
    renderSchedulePresets(config.active_schedule);
    calculateSchedule();
    refreshResults();
}

function switchSchedule(idx) {
    if (idx === config.active_schedule || !config.schedules[idx]) return;
    syncActiveSchedule();           // persist the schedule we're leaving
    config.active_schedule = idx;
    loadActiveSchedule();
    saveConfig();
    renderSchedulePresets();
    calculateSchedule();
    refreshResults();
}

function renderSchedulePresets(animateIdx = -1) {
    const wrap = document.getElementById("schedule_presets");
    if (!wrap) return;
    const schedules = Array.isArray(config.schedules) ? config.schedules : [];
    const active = config.active_schedule || 0;
    wrap.innerHTML = schedules.map((p, i) => {
        const isActive = i === active;
        const count = savedCourseSummary(p.courses).classCount;
        const pillCls = isActive
            ? "border-accent-400 bg-accent-50 dark:border-accent-500/50 dark:bg-accent-500/10"
            : "border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 hover:border-slate-300 dark:hover:border-slate-600";
        const labelCls = isActive
            ? "text-accent-700 dark:text-accent-300"
            : "text-slate-700 dark:text-slate-200";
        const dot = isActive
            ? `<span class="h-1.5 w-1.5 rounded-full bg-accent-500 shrink-0"></span>` : "";
        return `
        <span class="sched_preset_pill group relative inline-flex items-center gap-1.5 rounded-md border ${pillCls} pl-2 pr-1 py-1 transition-colors ${i === animateIdx ? "animate-pop" : ""}">
            ${dot}
            <button class="sched_restore btn-press text-xs font-medium ${labelCls} max-w-[9rem] truncate" data-idx="${i}" title="Switch to ${escapeAttr(p.name)} (${count} course${count === 1 ? '' : 's'})">${escapeHtml(p.name)}</button>
            <span class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                <button class="sched_rename grid place-items-center h-4 w-4 rounded text-slate-400 hover:text-accent-500" data-idx="${i}" title="Rename">
                    <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m16.5 3.5 4 4L7 21H3v-4L16.5 3.5Z"/></svg>
                </button>
                <button class="sched_delete grid place-items-center h-4 w-4 rounded text-slate-400 hover:text-red-500" data-idx="${i}" title="Delete">
                    <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>
                </button>
            </span>
        </span>`;
    }).join("");

    wrap.querySelectorAll(".sched_restore").forEach(b => b.addEventListener("click", () => switchSchedule(+b.dataset.idx)));
    wrap.querySelectorAll(".sched_rename").forEach(b => b.addEventListener("click", () => renameSchedule(+b.dataset.idx)));
    wrap.querySelectorAll(".sched_delete").forEach(b => b.addEventListener("click", () => deleteSchedule(+b.dataset.idx)));
}

async function renameSchedule(idx) {
    const p = (config.schedules || [])[idx];
    if (!p) return;
    const name = await uiPrompt({title: "Rename schedule", value: p.name});
    if (name === null) return;
    const trimmed = name.trim();
    if (trimmed) p.name = trimmed;
    saveConfig();
    renderSchedulePresets();
}

function deleteSchedule(idx) {
    if (!config.schedules[idx]) return;
    const finish = () => {
        config.schedules.splice(idx, 1);
        // Keep at least one schedule around; fix up the active pointer.
        if (!config.schedules.length) config.schedules = [blankSchedule()];
        if (config.active_schedule >= config.schedules.length) config.active_schedule = config.schedules.length - 1;
        else if (idx < config.active_schedule) config.active_schedule--;
        else if (idx === config.active_schedule) config.active_schedule = Math.min(idx, config.schedules.length - 1);
        loadActiveSchedule();
        saveConfig();
        renderSchedulePresets();
        calculateSchedule();
        refreshResults();
    };
    const pill = document.querySelectorAll("#schedule_presets .sched_preset_pill")[idx];
    if (pill) {
        pill.classList.add("animate-out");
        setTimeout(finish, 180);
    } else {
        finish();
    }
}

// Empty the active schedule's courses (keeps its name and starred list).
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
// Modal dialogs
//
// Replaces window.confirm/prompt so destructive actions and renames look like the
// rest of the app. Promise-based, so call sites become `await uiConfirm({...})`.
// Only one dialog is ever open; opening a second resolves the first as cancelled.
// --------------------------------------------------------------------------

const MODAL_FOCUSABLE = 'button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])';

let modalState = null;

function closeModal(result) {
    if (!modalState) return;
    const {resolve, previousFocus, keyHandler} = modalState;
    modalState = null;
    document.removeEventListener("keydown", keyHandler, true);
    const root = document.getElementById("app_modal");
    if (root) {
        root.classList.add("hidden");
        root.innerHTML = "";
    }
    // Send focus back where it came from, so keyboard users don't lose their place.
    if (previousFocus && document.contains(previousFocus)) {
        try { previousFocus.focus(); } catch (e) { /* element may no longer be focusable */ }
    }
    resolve(result);
}

// opts: {title, message, confirmLabel, cancelLabel, danger, input:{value, placeholder}}
// Resolves to false/null on cancel, true or the input's string value on confirm.
function openModal(opts) {
    const o = opts || {};
    const wantsInput = !!o.input;
    const cancelValue = wantsInput ? null : false;

    if (modalState) closeModal(cancelValue);

    const root = document.getElementById("app_modal");
    if (!root) {
        // No host element (e.g. a page that doesn't include the modal markup) —
        // fall back rather than silently dropping the interaction.
        if (wantsInput) return Promise.resolve(window.prompt(o.title || "", (o.input && o.input.value) || ""));
        return Promise.resolve(window.confirm(o.message || o.title || ""));
    }

    const confirmClasses = o.danger
        ? "bg-rose-600 hover:bg-rose-700"
        : "bg-accent-600 hover:bg-accent-700";

    root.innerHTML = `
        <div class="modal-backdrop absolute inset-0 bg-slate-900/50 dark:bg-slate-950/70 backdrop-blur-[2px]"></div>
        <div class="relative min-h-full flex items-center justify-center p-4">
            <div class="modal-panel w-full max-w-sm rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl overflow-hidden"
                 role="dialog" aria-modal="true" aria-labelledby="app_modal_title">
                <div class="p-4 space-y-2">
                    <h2 class="text-sm font-semibold text-slate-800 dark:text-slate-100" id="app_modal_title">${escapeHtml(o.title || "")}</h2>
                    ${o.message ? `<p class="text-xs leading-relaxed text-slate-500 dark:text-slate-400">${escapeHtml(o.message)}</p>` : ""}
                    ${wantsInput ? `
                    <input class="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-accent-500/40 focus:border-accent-500"
                           id="app_modal_input" type="text" value="${escapeAttr(o.input.value || "")}" placeholder="${escapeAttr(o.input.placeholder || "")}">` : ""}
                </div>
                <div class="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40">
                    <button class="btn-press text-xs font-medium px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors"
                            id="app_modal_cancel" type="button">${escapeHtml(o.cancelLabel || "Cancel")}</button>
                    <button class="btn-press text-xs font-medium px-3 py-1.5 rounded-md text-white transition-colors ${confirmClasses}"
                            id="app_modal_confirm" type="button">${escapeHtml(o.confirmLabel || "Confirm")}</button>
                </div>
            </div>
        </div>`;
    root.classList.remove("hidden");

    const panel = root.querySelector(".modal-panel");
    const input = document.getElementById("app_modal_input");
    const confirmValue = () => (wantsInput ? (input ? input.value : "") : true);

    const keyHandler = (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            closeModal(cancelValue);
            return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            closeModal(confirmValue());
            return;
        }
        // Keep focus inside the dialog while it is open.
        if (e.key === "Tab") {
            const items = [...panel.querySelectorAll(MODAL_FOCUSABLE)].filter(el => !el.disabled);
            if (!items.length) return;
            const first = items[0];
            const last = items[items.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    };

    const promise = new Promise(resolve => {
        modalState = {resolve, previousFocus: document.activeElement, keyHandler};
    });

    document.addEventListener("keydown", keyHandler, true);
    document.getElementById("app_modal_cancel").addEventListener("click", () => closeModal(cancelValue));
    document.getElementById("app_modal_confirm").addEventListener("click", () => closeModal(confirmValue()));
    root.querySelector(".modal-backdrop").addEventListener("click", () => closeModal(cancelValue));

    if (input) {
        input.focus();
        input.select();
    } else {
        document.getElementById("app_modal_confirm").focus();
    }

    return promise;
}

function uiConfirm(opts) {
    return openModal(Object.assign({confirmLabel: "Confirm"}, opts));
}

function uiPrompt(opts) {
    const o = Object.assign({confirmLabel: "Save"}, opts);
    o.input = {value: o.value || "", placeholder: o.placeholder || ""};
    return openModal(o);
}

// --------------------------------------------------------------------------
// Theme
// --------------------------------------------------------------------------

function toggleTheme() {
    const isDark = document.documentElement.classList.toggle("dark");
    localStorage.setItem("theme", isDark ? "dark" : "light");
    renderCalendar(); // recolor gridlines etc.
}

// Everything this device has stored, in one payload. Shared by the export file and
// by cloud sync, so both always capture exactly the same thing.
// Keys prefixed `sync_` are per-device credentials, not user data — they are skipped
// so a profile can never carry another device's sync key with it.
function snapshotLocalData() {
    saveConfig();
    const stored = {};
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || key.startsWith("sync_")) continue;
        stored[key] = localStorage.getItem(key);
    }
    return {
        app: "class_schedule_picker",
        version: 1,
        exported_at: new Date().toISOString(),
        localStorage: stored
    };
}

// Inverse of snapshotLocalData(). Replaces all local data, preserving this device's
// own `sync_` keys across the clear(). Throws if the payload isn't ours.
function applyLocalDataPayload(payload) {
    if (!payload || payload.app !== "class_schedule_picker" || !payload.localStorage || typeof payload.localStorage !== "object") {
        throw new Error("Not a Schedule Picker payload.");
    }
    const keptSync = {};
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith("sync_")) keptSync[key] = localStorage.getItem(key);
    }
    localStorage.clear();
    for (const [key, value] of Object.entries(payload.localStorage)) {
        if (key.startsWith("sync_")) continue;
        localStorage.setItem(key, String(value));
    }
    for (const [key, value] of Object.entries(keptSync)) localStorage.setItem(key, value);
}

function exportLocalData() {
    const status = document.getElementById("export_data_status");
    try {
        const payload = snapshotLocalData();
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
        // Reject a bad file before asking the user to confirm anything.
        if (!payload || payload.app !== "class_schedule_picker" || !payload.localStorage || typeof payload.localStorage !== "object") {
            throw new Error("Not a Schedule Picker export file.");
        }

        const ok = await uiConfirm({
            title: "Import data?",
            message: "This replaces the saved schedules, starred classes, filters, and other local settings on this computer.",
            confirmLabel: "Import",
            danger: true
        });
        if (!ok) return;

        applyLocalDataPayload(payload);
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
// Solver
//
// Enumerates every combination of sections that satisfies each selected course's
// component requirements without a time clash. Courses are taken from whatever is
// added or starred on the current schedule, collapsed to their parent course, so a
// lecture "01" and a lab "A" of the same class count once.
// --------------------------------------------------------------------------

const SOLVER_MAX_SOLUTIONS = 400;   // stop collecting past this; the count still reports
const SOLVER_NODE_BUDGET = 300000;  // hard ceiling so a huge search can't hang the tab
const SOLVER_RENDER_LIMIT = 40;

let solverResults = [];
let solverCounts = null;
// representative section _key -> the interchangeable sections it stands in for
let solverAlternates = new Map();

// Parent course codes implied by the current schedule (added + starred).
function solverCourseCodes() {
    const codes = new Set();
    for (const id of [...(config.courses || []), ...(config.favorites || [])]) {
        const course = classes[id];
        if (course && course["Course"]) codes.add(course["Course"]);
    }
    return [...codes].sort((a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: "base"}));
}

function solverIsExcluded(code) {
    return (config.solver_excluded || []).includes(code);
}

function solverSelectedCodes() {
    return solverCourseCodes().filter(c => !solverIsExcluded(c));
}

// What a student must enrol in for this course, as a list of groups to pick one from.
// Prefers the shared L2-aware model; otherwise falls back to the numbered/lettered
// convention (a course with both needs one of each), and finally to a single pick.
function solverRequirementForCourse(courseCode) {
    const shared = sectionRequirementForCourse(courseCode);
    if (shared && shared.groups && shared.groups.length) return shared;

    const sections = sectionsForCourse(courseCode);
    const nums = sections.filter(s => sectionKindOf(s["Section"]) === "num");
    const alphas = sections.filter(s => sectionKindOf(s["Section"]) === "alpha");
    if (nums.length && alphas.length) {
        return {
            source: "fallback",
            groups: [
                {id: "num", label: sectionRangeLabel(nums.map(s => s["Section"])), kind: "num", sections: []},
                {id: "alpha", label: sectionRangeLabel(alphas.map(s => s["Section"])), kind: "alpha", sections: []}
            ]
        };
    }
    return {source: "single", groups: [{id: "any", label: "Section", sections: [], any: true}]};
}

// Prefer the real component name ("Lecture", "Laboratory") over a section range
// when L2 supplies one — "Lecture + Discussion" reads better than "01-06 + A-N".
function solverGroupLabel(courseCode, group) {
    const formats = [...new Set(
        solverSectionsForGroup(courseCode, group).map(s => s["_l2_format"]).filter(Boolean)
    )];
    if (formats.length === 1) return formats[0];
    return group.label || "Section";
}

function solverSectionsForGroup(courseCode, group) {
    const sections = sectionsForCourse(courseCode);
    if (group.any) return sections;
    return sections.filter(s => sectionMatchesRequirement(s, group));
}

// Busy windows as day-indexed intervals, mirroring calculateSchedule().
function solverBusyBlocks() {
    const blocks = [[], [], [], [], [], [], []];
    if (config.busy_enabled === false) return blocks;
    for (let i = 0; i < WEEKDAYS; i++) {
        const pre = toMinutes(String(config[`schedule_exclude_${i}_pre`] || "").replace(":", ""));
        const post = toMinutes(String(config[`schedule_exclude_${i}_post`] || "").replace(":", ""));
        if (pre !== null && post !== null && post > pre) blocks[i].push({start: pre, end: post});
    }
    return blocks;
}

// Same padded-interval test the results filter uses.
function solverOverlaps(a, b, margin) {
    return a.start < b.end + margin && b.start - margin < a.end;
}

function solveSchedules() {
    const margin = Number.parseInt(config.margin_time, 10) || 0;
    const busy = solverBusyBlocks();
    const excluded = new Set(config.course_excludes || []);
    const codes = solverSelectedCodes();

    const slots = [];
    let productAll = 1;      // distinct combinations if nothing were hidden
    let productKept = 1;     // distinct combinations actually searched
    let productRaw = 1;      // combinations before collapsing interchangeable sections
    const blocked = [];      // groups with every section hidden
    solverAlternates = new Map();

    // Sections that meet at the same times with the same instructor are
    // interchangeable — the results table already collapses them, and expanding
    // them here would emit N indistinguishable schedules. Keep one representative
    // (preferring one with open seats) and remember the rest.
    const collapse = (sections) => mergeIdentical(sections).map(members => {
        const key = pickDefaultKey(members);
        const rep = members.find(m => m["_key"] === key) || members[0];
        if (members.length > 1) solverAlternates.set(rep["_key"], members.filter(m => m !== rep));
        return rep;
    });

    for (const code of codes) {
        const requirement = solverRequirementForCourse(code);
        for (const group of requirement.groups) {
            const all = solverSectionsForGroup(code, group);
            if (!all.length) continue;                       // nothing to choose here
            const kept = all.filter(s => !excluded.has(s["_key"]));
            productAll *= collapse(all).length;
            if (!kept.length) {
                blocked.push(`${code} ${solverGroupLabel(code, group)}`.trim());
                continue;
            }
            const candidates = collapse(kept);
            productRaw *= kept.length;
            productKept *= candidates.length;
            slots.push({
                code,
                label: solverGroupLabel(code, group),
                candidates,
                meetings: candidates.map(s => parseMeetings(s))
            });
        }
    }

    const counts = {
        courses: codes.length,
        slots: slots.length,
        considered: slots.length ? productKept : 0,
        hiddenByExcluded: Math.max(0, (slots.length ? productAll : 0) - (slots.length ? productKept : 0)),
        duplicatesCollapsed: slots.length ? Math.max(0, productRaw - productKept) : 0,
        rejectedBusy: 0,
        rejectedClash: 0,
        blocked,
        truncated: false
    };
    if (!slots.length) return {solutions: [], counts};

    // Fewest options first, so the search prunes as early as possible.
    slots.sort((a, b) => a.candidates.length - b.candidates.length);

    // suffix[i] = number of full combinations below slot i, i.e. how many
    // permutations a single rejection at slot i eliminates.
    const suffix = new Array(slots.length).fill(1);
    for (let i = slots.length - 2; i >= 0; i--) suffix[i] = suffix[i + 1] * slots[i + 1].candidates.length;

    const solutions = [];
    const chosen = [];
    const activeMeetings = [];
    let nodes = 0;

    function dfs(i) {
        if (counts.truncated) return;
        if (i === slots.length) {
            solutions.push(chosen.map(c => c.section));
            if (solutions.length >= SOLVER_MAX_SOLUTIONS) counts.truncated = true;
            return;
        }
        const slot = slots[i];
        for (let ci = 0; ci < slot.candidates.length; ci++) {
            if (counts.truncated) return;
            if (++nodes > SOLVER_NODE_BUDGET) { counts.truncated = true; return; }

            const meets = slot.meetings[ci];
            let reason = null;
            for (const m of meets) {
                if (busy[m.day].some(b => solverOverlaps(m, b, margin))) { reason = "busy"; break; }
            }
            if (!reason) {
                for (const m of meets) {
                    if (activeMeetings.some(pm => pm.day === m.day && solverOverlaps(m, pm, margin))) { reason = "clash"; break; }
                }
            }
            if (reason) {
                // Everything below this choice is eliminated too — count it once, exactly.
                if (reason === "busy") counts.rejectedBusy += suffix[i];
                else counts.rejectedClash += suffix[i];
                continue;
            }

            chosen.push({slot, section: slot.candidates[ci]});
            const mark = activeMeetings.length;
            for (const m of meets) activeMeetings.push(m);
            dfs(i + 1);
            activeMeetings.length = mark;
            chosen.pop();
        }
    }

    dfs(0);
    return {solutions, counts};
}

// --------------------------------------------------------------------------
// Realism scoring — a rough "would a person actually want this?" heuristic.
// Deliberately soft: it only orders the results, it never removes any.
// --------------------------------------------------------------------------

const LUNCH_START = 11 * 60, LUNCH_END = 14 * 60, LUNCH_MIN = 45;
const DAY_START_OK = 9 * 60, DAY_END_OK = 18 * 60, LONG_GAP = 150;

function solverDayIntervals(sections) {
    const days = [[], [], [], [], [], [], []];
    for (const s of sections) for (const m of parseMeetings(s)) days[m.day].push(m);
    for (const d of days) d.sort((a, b) => a.start - b.start);
    return days;
}

function scoreSolution(sections) {
    const days = solverDayIntervals(sections);
    const active = days.filter(d => d.length);
    if (!active.length) return {total: 0, lunch: 0, balance: 0, edges: 0, gaps: 0};

    // Lunch: a free stretch of >= 45 min somewhere in 11:00-14:00.
    let lunchOk = 0;
    for (const d of active) {
        let cursor = LUNCH_START, best = 0;
        for (const m of d) {
            if (m.end <= LUNCH_START || m.start >= LUNCH_END) continue;
            best = Math.max(best, Math.min(m.start, LUNCH_END) - cursor);
            cursor = Math.max(cursor, Math.min(m.end, LUNCH_END));
        }
        best = Math.max(best, LUNCH_END - cursor);
        if (best >= LUNCH_MIN) lunchOk++;
    }
    const lunch = lunchOk / active.length;

    // Balance: an even spread of teaching minutes across the days actually used.
    const loads = active.map(d => d.reduce((sum, m) => sum + (m.end - m.start), 0));
    const mean = loads.reduce((a, b) => a + b, 0) / loads.length;
    const sd = Math.sqrt(loads.reduce((a, l) => a + (l - mean) ** 2, 0) / loads.length);
    const balance = mean > 0 ? Math.max(0, 1 - sd / mean) : 0;

    // Edges: classes inside civilised hours.
    let inHours = 0, totalMeetings = 0;
    for (const d of active) for (const m of d) {
        totalMeetings++;
        if (m.start >= DAY_START_OK && m.end <= DAY_END_OK) inHours++;
    }
    const edges = totalMeetings ? inHours / totalMeetings : 0;

    // Gaps: penalise long dead stretches between classes on the same day.
    let deadMinutes = 0, spanMinutes = 0;
    for (const d of active) {
        spanMinutes += d[d.length - 1].end - d[0].start;
        for (let i = 1; i < d.length; i++) {
            const gap = d[i].start - d[i - 1].end;
            if (gap > LONG_GAP) deadMinutes += gap - LONG_GAP;
        }
    }
    const gaps = spanMinutes > 0 ? Math.max(0, 1 - deadMinutes / spanMinutes) : 1;

    const total = Math.round(100 * (0.40 * lunch + 0.20 * balance + 0.20 * edges + 0.20 * gaps));
    return {total, lunch, balance, edges, gaps};
}

// --------------------------------------------------------------------------
// Solver UI
// --------------------------------------------------------------------------

function renderSolverCourses() {
    const wrap = document.getElementById("solver_courses");
    const summary = document.getElementById("solver_summary");
    if (!wrap) return;
    const codes = solverCourseCodes();

    if (!codes.length) {
        wrap.innerHTML = `<p class="text-xs text-slate-400 dark:text-slate-500">Add or star some classes and they'll show up here.</p>`;
        if (summary) summary.textContent = "0 classes";
        return;
    }

    wrap.innerHTML = codes.map(code => {
        const on = !solverIsExcluded(code);
        const requirement = solverRequirementForCourse(code);
        const parts = requirement.groups.length > 1
            ? requirement.groups.map(g => escapeHtml(solverGroupLabel(code, g))).join(" + ")
            : "";
        const cls = on
            ? "border-accent-300 bg-accent-50 text-accent-700 dark:border-accent-500/40 dark:bg-accent-500/10 dark:text-accent-300"
            : "border-slate-200 bg-slate-50 text-slate-400 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-500 line-through";
        return `<button class="solver_course btn-press inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md border transition-colors ${cls}"
                        data-code="${escapeAttr(code)}" type="button" aria-pressed="${on ? "true" : "false"}">
                    <span class="h-2 w-2 rounded-full shrink-0" style="background:${on ? courseColor(code) : "currentColor"}"></span>
                    <span>${escapeHtml(code)}</span>${parts ? `<span class="opacity-60 font-normal">${parts}</span>` : ""}
                </button>`;
    }).join("");

    const selected = solverSelectedCodes().length;
    if (summary) summary.textContent = `${selected} of ${codes.length} class${codes.length === 1 ? "" : "es"}`;
}

function solverToggleCourse(code) {
    const list = Array.isArray(config.solver_excluded) ? config.solver_excluded.slice() : [];
    const i = list.indexOf(code);
    if (i === -1) list.push(code); else list.splice(i, 1);
    config.solver_excluded = list;
    saveConfig();
    renderSolverCourses();
    // Previous results no longer match the selection.
    solverResults = [];
    solverCounts = null;
    renderSolverResults();
    const status = document.getElementById("solver_status");
    if (status) status.textContent = "";
}

function solverStatusText(counts) {
    if (!counts) return "";
    const n = (v) => v.toLocaleString();
    const shown = solverResults.length;
    const bits = [`${n(shown)}${counts.truncated ? "+" : ""} working schedule${shown === 1 ? "" : "s"}`];

    // Reasons a combination didn't make the list, biggest cause first. A single total
    // up front, then the breakdown, so the numbers don't read as one long run-on.
    const reasons = [
        {n: counts.rejectedClash || 0, label: "time clashes"},
        {n: counts.hiddenByExcluded || 0, label: "hidden sections"},
        {n: counts.rejectedBusy || 0, label: "busy times"}
    ].filter(r => r.n).sort((a, b) => b.n - a.n);
    if (reasons.length) {
        const total = reasons.reduce((sum, r) => sum + r.n, 0);
        const breakdown = reasons.map(r => `${n(r.n)} ${r.label}`).join(", ");
        bits.push(reasons.length > 1
            ? `${n(total)} ruled out (${breakdown})`
            : `${breakdown} ruled out`);
    }

    if (counts.duplicatesCollapsed) bits.push(`${n(counts.duplicatesCollapsed)} duplicates merged`);
    if (counts.truncated) bits.push(`showing the top ${n(shown)}`);
    return bits.join(" · ");
}

const SOLVER_PREVIEW_HOUR_H = 24;

// "Johnson, Silas" -> "Johnson". The full name stays in the block tooltip.
function solverInstructorShort(name) {
    const text = String(name || "").trim();
    if (!text) return "";
    return text.split(",")[0].trim();
}

// One line per course listing who teaches it, so two options that differ only by
// instructor are told apart without hovering.
function solverRosterHtml(sections) {
    const byCourse = new Map();
    for (const section of sections) {
        const code = section["Course"] || "";
        if (!byCourse.has(code)) byCourse.set(code, new Set());
        const who = solverInstructorShort(section["Instructor"]);
        if (who) byCourse.get(code).add(who);
    }
    return [...byCourse.entries()].map(([code, names]) => {
        const who = [...names].join(" / ");
        return `<span class="inline-flex items-center gap-1 min-w-0 max-w-full">
            <span class="h-1.5 w-1.5 rounded-full shrink-0" style="background:${courseColor(code)}"></span>
            <span class="shrink-0 font-medium">${escapeHtml(code)}</span>
            <span class="truncate opacity-70">${who ? escapeHtml(who) : "staff TBA"}</span>
        </span>`;
    }).join("");
}

// One time window shared by every preview, so the options can be compared at a
// glance instead of each being scaled to its own contents.
function solverPreviewWindow(entries) {
    let min = Infinity, max = -Infinity;
    for (const entry of entries) {
        for (const section of entry.sections) {
            for (const m of parseMeetings(section)) {
                min = Math.min(min, m.start);
                max = Math.max(max, m.end);
            }
        }
    }
    const busy = solverBusyBlocks();
    for (let d = 0; d < WEEKDAYS; d++) {
        for (const b of busy[d]) { min = Math.min(min, b.start); max = Math.max(max, b.end); }
    }
    if (!isFinite(min)) return null;
    return {startHour: Math.floor(min / 60), endHour: Math.ceil(max / 60)};
}

// A thumbnail of the week. Exact section codes live in the hover tooltip rather
// than on the block, which at this size only has room for the course.
function solverMiniCalendar(sections, win) {
    const busy = solverBusyBlocks();
    const blocks = [[], [], [], [], [], [], []];
    for (const section of sections) {
        for (const m of parseMeetings(section)) {
            blocks[m.day].push({
                ...m,
                label: section["Course"] || "",
                section: section["Section"] || "",
                key: section["_key"],
                instructor: String(section["Instructor"] || "").trim(),
                color: courseColor(section["Course"] || "")
            });
        }
    }
    for (let d = 0; d < WEEKDAYS; d++) {
        for (const b of busy[d]) blocks[d].push({day: d, start: b.start, end: b.end, busy: true});
    }

    const winStart = win.startHour * 60;
    const height = (win.endHour - win.startHour) * SOLVER_PREVIEW_HOUR_H;
    const isDark = document.documentElement.classList.contains("dark");
    const lineColor = isDark ? "rgba(148,163,184,0.16)" : "rgba(100,116,139,0.14)";

    const cols = [0, 1, 2, 3, 4].map(d => {
        const laid = layoutDay(blocks[d]);
        const inner = laid.map(b => {
            const top = ((b.start - winStart) / 60) * SOLVER_PREVIEW_HOUR_H;
            const h = Math.max(((b.end - b.start) / 60) * SOLVER_PREVIEW_HOUR_H, 9);
            const w = 100 / b.cols;
            const left = b.col * w;
            const box = `top:${top}px;height:${h}px;left:calc(${left}% + 1px);width:calc(${w}% - 2px)`;
            if (b.busy) {
                return `<div class="absolute rounded-sm border border-dashed border-slate-300 dark:border-slate-600 bg-slate-200/40 dark:bg-slate-700/25" style="${box}"></div>`;
            }
            const alts = solverAlternates.get(b.key) || [];
            const altText = alts.length ? ` (or ${alts.map(a => a["Section"]).join(", ")})` : "";
            const whoText = b.instructor ? ` · ${b.instructor}` : "";
            const tip = `${b.label} ${b.section}${altText}${whoText} · ${dayShort[b.day]} ${formatMinutes(b.start)}–${formatMinutes(b.end)}`;
            return `<div class="tip-trigger absolute rounded-sm text-white overflow-hidden px-0.5 leading-none flex items-center shadow-sm"
                         data-tip="${escapeAttr(tip)}" style="${box};background:${b.color};font-size:8px">${h >= 13 ? escapeHtml(b.label) : ""}</div>`;
        }).join("");
        return `<div class="flex-1 min-w-0">
            <div class="text-center text-[9px] font-semibold text-slate-400 dark:text-slate-500 pb-0.5">${dayShort[d]}</div>
            <div class="relative cal-grid-lines rounded-sm bg-slate-50 dark:bg-slate-900/40"
                 style="--hour-h:${SOLVER_PREVIEW_HOUR_H}px;--cal-line:${lineColor};height:${height}px">${inner}</div>
        </div>`;
    }).join("");

    return `<div class="flex gap-0.5">${cols}</div>`;
}

function renderSolverResults() {
    const wrap = document.getElementById("solver_results");
    if (!wrap) return;
    if (!solverResults.length) {
        wrap.innerHTML = solverCounts && solverCounts.considered
            ? `<p class="text-xs text-amber-600 dark:text-amber-400">No combination works. Loosen your busy times, un-hide sections, or drop a class above.</p>`
            : "";
        if (solverCounts && solverCounts.blocked && solverCounts.blocked.length) {
            wrap.innerHTML += `<p class="mt-1 text-xs text-amber-600 dark:text-amber-400">Every section is hidden for: ${escapeHtml(solverCounts.blocked.join(", "))}.</p>`;
        }
        return;
    }

    const shown = solverResults.slice(0, SOLVER_RENDER_LIMIT);
    const win = solverPreviewWindow(shown);
    wrap.innerHTML = `
        <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            ${shown.map((entry, idx) => {
                const score = entry.score;
                return `
                <div class="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/40 p-2.5">
                    <div class="flex items-center justify-between gap-2">
                        <span class="text-xs font-semibold text-slate-500 dark:text-slate-400">#${idx + 1}</span>
                        <span class="tnum text-[11px] font-semibold px-1.5 py-0.5 rounded-full bg-accent-100 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300 tip-trigger"
                              data-tip="Realism score — lunch break, even spread, sane hours, few long gaps">${score.total}</span>
                    </div>
                    <div class="mt-1.5">${win ? solverMiniCalendar(entry.sections, win) : ""}</div>
                    <div class="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-slate-500 dark:text-slate-400">${solverRosterHtml(entry.sections)}</div>
                    <div class="mt-1.5 flex items-center gap-1.5">
                        <button class="solver_save btn-press flex-1 text-[11px] font-medium px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors"
                                data-idx="${idx}" type="button">Save as new</button>
                        <button class="solver_replace btn-press flex-1 text-[11px] font-medium px-2 py-1 rounded bg-accent-600 text-white hover:bg-accent-700 transition-colors"
                                data-idx="${idx}" type="button">Use this</button>
                    </div>
                </div>`;
            }).join("")}
        </div>
        ${solverResults.length > SOLVER_RENDER_LIMIT
            ? `<p class="mt-2 text-xs text-slate-400 dark:text-slate-500">Showing the top ${SOLVER_RENDER_LIMIT} of ${solverResults.length} — the best-scoring come first.</p>`
            : ""}`;

    wrap.querySelectorAll(".solver_save").forEach(b => b.addEventListener("click", () => solverApply(+b.dataset.idx, "new")));
    wrap.querySelectorAll(".solver_replace").forEach(b => b.addEventListener("click", () => solverApply(+b.dataset.idx, "replace")));
    initTooltips();
}

function runSolver() {
    const status = document.getElementById("solver_status");
    const codes = solverSelectedCodes();
    if (!codes.length) {
        solverResults = [];
        solverCounts = null;
        renderSolverResults();
        if (status) status.textContent = "Pick at least one class above.";
        return;
    }
    if (status) status.textContent = "Solving…";

    // Yield once so "Solving…" paints before a long search. Deliberately a timeout
    // rather than requestAnimationFrame, which never fires in a backgrounded tab.
    window.setTimeout(() => {
        const {solutions, counts} = solveSchedules();
        // Score once per solution — scoring walks every meeting, so doing it inside
        // the comparator would repeat that work O(n log n) times.
        const scored = solutions.map(sections => ({sections, score: scoreSolution(sections)}));
        scored.sort((x, y) => y.score.total - x.score.total);
        solverResults = scored;
        solverCounts = counts;
        renderSolverResults();
        if (status) status.textContent = solverStatusText(counts);
    }, 0);
}

async function solverApply(idx, mode) {
    const entry = solverResults[idx];
    if (!entry) return;
    const keys = entry.sections.map(s => s["_key"]);

    if (mode === "replace") {
        const ok = await uiConfirm({
            title: "Use this schedule?",
            message: "The classes currently added to this schedule are replaced by the sections in this option. Starred classes are kept.",
            confirmLabel: "Use it",
            danger: true
        });
        if (!ok) return;
        config.courses = keys;
    } else {
        syncActiveSchedule();
        config.schedules.push({
            name: nextScheduleName("Option"),
            courses: keys.slice(),
            favorites: (config.favorites || []).slice(),
            show_conflict_crns: []
        });
        config.active_schedule = config.schedules.length - 1;
        loadActiveSchedule();
    }

    saveConfig();
    renderSchedulePresets(config.active_schedule);
    calculateSchedule();
    refreshResults();
    renderSolverCourses();
    const status = document.getElementById("solver_status");
    if (status) status.textContent = mode === "replace" ? "Applied to this schedule." : "Saved as a new schedule.";
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
    const minLevel = Number.parseInt(config.min_level, 10) || 0;

    let result_classes = Object.values(classes).filter(course => {
        const courseId = course["_key"] || course["CRN"];
        if (config.course_excludes.includes(courseId)) return false;       // manually hidden
        if (config.courses.includes(courseId)) return false;               // already added
        const num = Number.parseInt(course["Course"].split(" ")[1], 10);
        if (!Number.isNaN(num)) {
            const lvl = Math.floor(num / 1000);
            if (lvl > maxLevel || lvl < minLevel) return false;
        }
        if (!config.prefixes.includes(course["Course"].split(" ")[0])) return false;
        if (conflictsWithSchedule(course)) return false;
        return true;
    });

    // Search
    if (config.search_bar.length > 0) {
        const richKeys = currentSchema.caps && (currentSchema.caps.locations || currentSchema.caps.eligibility);
        const fuse = new Fuse(result_classes, {
            keys: richKeys
                ? ["Course", "Title", "Instructor", "Place", "_campus", "_l2_eligibility"]
                : ["Course", "Title", "Instructor"],
            minMatchCharLength: 2, threshold: 0.3
        });
        result_classes = fuse.search(config.search_bar).map(r => r.item);
    } else if (currentSchema.grouped) {
        // Grouped view: keep every course's sections contiguous and in section order
        // (favorites stay starred but don't float out of their group).
        result_classes.sort(courseAndSectionCompare);
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
    if (currentSchema.grouped) {
        body.classList.add("grouped");
        body.innerHTML = renderGroupedBody(result_classes);
    } else {
        body.classList.remove("grouped");
        body.innerHTML = result_classes.map(course => renderRow(course)).join("");
    }

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

    ensureCourseColors(solverCourseCodes());   // courses added or starred = everything we colour
    renderCoursesList();
    renderStarredList();
    renderCalendar();
    renderSolverCourses();

    // Wire up row + list buttons
    document.querySelectorAll(".add_course_btn, .remove_course_btn, .star_course_btn, .delete_course_btn").forEach(btn =>
        btn.addEventListener("click", handleCourseButtonPress));

    // Grouped (WashU) section controls
    document.querySelectorAll(".grp_add").forEach(b => b.addEventListener("click", () => addSectionByKey(b.dataset.key)));
    document.querySelectorAll(".grp_star").forEach(b => b.addEventListener("click", () => starSectionByKey(b.dataset.key)));
    document.querySelectorAll(".grp_minus").forEach(b => b.addEventListener("click", () => removeSectionsByKeys((b.dataset.keys || "").split(",").filter(Boolean))));
    document.querySelectorAll(".grp_collapse").forEach(b => b.addEventListener("click", () => toggleGroupCollapse(b.dataset.course, b.dataset.gid, b)));
    document.querySelectorAll("#results-body [data-secpop]").forEach(el => {
        el.addEventListener("mouseenter", () => showSectionPop(el));
        el.addEventListener("mouseleave", scheduleSecPopHide);
    });

    initTooltips();
    updateResultsTableLayout();
    syncResultsHeight();

    justAddedCrn = null;
    justStarredCrn = null;
}

// Keep the results panel at least as tall as the sidebar on side-by-side layouts,
// so the search/results column is never shorter than the config sidebar.
function syncResultsHeight() {
    const scroll = document.getElementById("results-scroll");
    const aside = document.querySelector("aside");
    if (!scroll || !aside) return;
    if (!window.matchMedia("(min-width: 1024px)").matches) {
        scroll.style.height = "";   // stacked layout: let the CSS max-height handle it
        return;
    }
    const viewportBased = window.innerHeight - 176;   // header + search bar (~11rem)
    scroll.style.height = `${Math.max(viewportBased, aside.offsetHeight)}px`;
}

function deliveryIcon(delivery) {
    const lower = (delivery || "").toLowerCase();
    if (lower.includes("hybrid")) {
        return `<svg class="h-4 w-4 text-teal-500 dark:text-teal-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="M8.288 15.038a5.25 5.25 0 0 1 7.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 0 1 1.06 0Z"/></svg>`;
    }
    if (lower.includes("online") || lower.includes("distance")) {
        return `<svg class="h-4 w-4 text-accent-500 dark:text-accent-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="M8.288 15.038a5.25 5.25 0 0 1 7.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 0 1 1.06 0Z"/></svg>`;
    }
    return `<svg class="h-4 w-4 text-amber-500 dark:text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z"/></svg>`;
}

// Physical location pin + room name — only when the class has a named place
// (e.g. FIT). Lives next to the title.
function placePinHtml(course) {
    const placeText = displayLocation(course).place;
    if (!placeText) return "";
    return `<span class="tip-trigger cursor-help inline-flex items-center text-slate-400 dark:text-slate-500 shrink-0" data-tip="${escapeAttr(placeText)}"><svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" stroke-linejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z"/></svg></span>`;
}

// Compact delivery-mode badge for the minority of non-in-person classes (online,
// hybrid, distance). Sits next to the section/course code rather than in a
// location slot, so the majority of in-person rows aren't given an empty icon.
function deliveryBadgeHtml(course) {
    const delivery = course["_delivery"] || "";
    if (!delivery || delivery.toLowerCase() === "in-person") return "";
    return `<span class="tip-trigger cursor-help inline-flex items-center align-middle shrink-0 ml-1" data-tip="${escapeAttr(delivery)}">${deliveryIcon(delivery)}</span>`;
}

function capClass(capVal) {
    const [enrolled, cap] = String(capVal || "").split("/").map(v => Number.parseInt(v.trim(), 10));
    if (!Number.isNaN(cap) && !Number.isNaN(enrolled) && cap > 0) {
        const pct = (enrolled / cap) * 100;
        return pct >= 100 ? "text-red-600 dark:text-red-400 font-semibold"
            : pct > 75 ? "text-amber-600 dark:text-amber-400 font-medium"
                : "text-green-600 dark:text-green-400 font-medium";
    }
    return "text-slate-500 dark:text-slate-400";
}

// Cap cell content that never overflows the narrow column: numeric "e/c" is shown
// as-is; long text (e.g. "Waitlist Available") is shortened with the full value on
// hover. Always wrapped so it truncates rather than forcing horizontal scroll.
function capCellHtml(capVal) {
    const val = String(capVal || "").trim();
    if (!val) return "";
    if (/^\d+\s*\/\s*\d+$/.test(val)) {
        return `<span class="tnum ${capClass(val)}">${escapeHtml(val)}</span>`;
    }
    const short = /waitlist/i.test(val) ? "WL" : val;
    return `<span class="tip-trigger cursor-help block truncate text-sm font-medium text-amber-600 dark:text-amber-400" data-tip="${escapeAttr(val)}">${escapeHtml(short)}</span>`;
}

function descLineHtml(course) {
    const detailText = course["details"] || "";
    const note = course["Notes"] || "";
    const tipText = note ? (detailText ? `${detailText}  •  Note: ${note}` : `Note: ${note}`) : detailText;
    if (!tipText) return "";
    const noteBadge = note
        ? `<span class="ml-1 align-middle inline-flex items-center rounded px-1 text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">note</span>`
        : "";
    return `<div class="tip-trigger cursor-help text-xs text-slate-400 dark:text-slate-500 truncate leading-snug" data-tip="${escapeAttr(tipText)}">${escapeHtml(detailText || note)}${noteBadge}</div>`;
}

function daysTimeHtml(course) {
    const timeHtml = (course["Times"] || "").split("\n").map(range => {
        const [s, e] = range.split("-");
        const sm = toMinutes(s), em = toMinutes(e);
        if (sm === null || em === null) return escapeHtml(range);
        return `${formatMinutes(sm)}&nbsp;–&nbsp;${formatMinutes(em)}`;
    }).join("<br>");
    const daysHtml = escapeHtml(course["Days"] || "").replaceAll("\n", "<br>");
    return { timeHtml, daysHtml };
}

// A plain (non-grouped) row: FIT classes and single-section WashU courses.
function resultActionCells(course, pad = "py-1.5") {
    const id = course["_key"] || course["CRN"];
    const starred = config.favorites.includes(id);
    return `<td class="px-2 ${pad} text-center align-middle">
            <button class="star_course_btn btn-press text-lg leading-none ${id === justStarredCrn ? "animate-pop" : ""} ${starred ? "text-amber-400" : "text-slate-300 dark:text-slate-600 hover:text-amber-400"}" id="star_course_${id}" title="Star to compare">${starred ? "★" : "☆"}</button>
        </td>
        <td class="px-2 ${pad} text-center align-middle whitespace-nowrap">
            <span class="inline-flex gap-2">
                <button class="add_course_btn btn-press inline-grid place-items-center h-7 w-7 rounded-lg border border-green-500/50 bg-green-500/5 text-green-600 dark:text-green-400 hover:bg-green-600 hover:text-white hover:border-green-600" id="add_course_${id}" title="Add to schedule">
                    <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14M5 12h14"/></svg>
                </button>
                <button class="remove_course_btn tip-trigger btn-press inline-grid place-items-center h-7 w-7 rounded-lg border border-red-500/50 bg-red-500/5 text-red-600 dark:text-red-400 hover:bg-red-600 hover:text-white hover:border-red-600" id="remove_course_${id}" data-tip="Hide this section" data-tip-shift="Hide all ${escapeAttr(course["Course"] || "matching")} sections">
                    <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14"/></svg>
                </button>
            </span>
        </td>`;
}

function resultCellHtml(col, course, opts = {}) {
    const displayCrn = course["CRN"];
    const { timeHtml, daysHtml } = daysTimeHtml(course);
    const pinHtml = placePinHtml(course);
    const deliveryHtml = deliveryBadgeHtml(course);
    const capVal = course["Cap"] || "";
    const py = opts.py || "py-1.5";
    if (col.id === "crn") {
        return `<td class="px-3 ${py} align-top whitespace-nowrap overflow-hidden">
            <div class="font-mono tnum text-xs text-slate-500 dark:text-slate-400 leading-tight truncate">${escapeHtml(displayCrn || "")}</div>
            <div class="font-mono text-[11px] leading-tight tracking-tight text-slate-400 dark:text-slate-500 truncate">${escapeHtml(course["Section"] || "—")} · ${escapeHtml(course["Cr"] || "—")}cr</div>
        </td>`;
    }
    if (col.id === "course") {
        if (opts.sectionCellHtml) {
            return `<td class="px-3 ${py} align-middle whitespace-nowrap overflow-hidden${opts.helpCls || ""}"${opts.popData || ""}>${opts.sectionCellHtml}</td>`;
        }
        if (currentSchema.showCRN) {
            return `<td class="px-3 ${py} align-top font-semibold text-slate-800 dark:text-slate-100 whitespace-nowrap overflow-hidden">${escapeHtml(course["Course"] || "")}${deliveryHtml}</td>`;
        }
        return `<td class="px-3 ${py} align-top whitespace-nowrap overflow-hidden">
            <div class="font-semibold text-slate-800 dark:text-slate-100 leading-tight truncate">${escapeHtml(course["Course"] || "")}${deliveryHtml}</div>
            <div class="font-mono text-[11px] leading-tight tracking-tight text-slate-400 dark:text-slate-500 truncate">Sec ${escapeHtml(course["Section"] || "—")} · ${escapeHtml(course["Cr"] || "—")}cr</div>
        </td>`;
    }
    if (col.id === "title") {
        return `<td class="px-3 ${py} align-top overflow-hidden">
            <div class="flex items-center gap-1.5 min-w-0">
                <div class="font-medium text-slate-800 dark:text-slate-100 leading-snug truncate">${escapeHtml(course["Title"] || "")}</div>
                ${pinHtml}
                ${tagBadgesHtml(course["_tags"])}
            </div>
            ${descLineHtml(course)}
        </td>`;
    }
    if (col.id === "location") {
        const { place, campus } = displayLocation(course);
        const tip = [place, campus].filter(Boolean).join(" · ");
        return `<td class="px-3 ${py} align-top text-slate-600 dark:text-slate-300 overflow-hidden">
            ${tip ? `<div class="tip-trigger cursor-help truncate" data-tip="${escapeAttr(tip)}">${escapeHtml(place || campus)}</div>` : `<span class="text-slate-400 dark:text-slate-500">—</span>`}
        </td>`;
    }
    if (col.id === "days") {
        return `<td class="px-3 ${py} align-top font-mono tnum text-slate-600 dark:text-slate-300 whitespace-nowrap overflow-hidden">${daysHtml || "—"}</td>`;
    }
    if (col.id === "time") {
        return `<td class="px-3 ${py} align-top font-mono tnum text-slate-600 dark:text-slate-300 whitespace-nowrap overflow-hidden">${timeHtml || "—"}</td>`;
    }
    if (col.id === "instructor") {
        return `<td class="px-3 ${py} align-top text-slate-600 dark:text-slate-300 overflow-hidden"><div class="truncate">${escapeHtml(course["Instructor"] || "")}</div></td>`;
    }
    if (col.id === "cap") {
        return `<td class="px-2 ${py} align-middle text-center overflow-hidden${opts.helpCls || ""}"${opts.popData || ""}>${opts.capCellHtml || capCellHtml(capVal)}</td>`;
    }
    return "";
}

function renderResultCells(course, opts = {}) {
    return visibleResultColumns().map(col => resultCellHtml(col, course, opts)).join("");
}

function renderRow(course) {
    const id = course["_key"] || course["CRN"];
    return `<tr data-course-code="${escapeAttr(course["Course"] || "")}" data-section-key="${escapeAttr(id)}">
        ${resultActionCells(course)}
        ${renderResultCells(course)}
    </tr>`;
}

// --------------------------------------------------------------------------
// Grouped course rendering (WashU): sections live under a course header, with
// identical sections (same days/time/instructor) merged into one annotated row.
// --------------------------------------------------------------------------

const collapsedCourses = new Set();      // course codes currently collapsed (transient)
let sectionPopRegistry = {};             // popover id -> { course, members[] }
let sectionPopSeq = 0;

function sectionKindOf(sec) {
    return /^[A-Za-z]/.test(String(sec || "").trim()) ? "alpha" : "num";
}

function parseSeats(v) {
    const p = String(v || "").split("/");
    const e = Number.parseInt(p[0], 10), c = Number.parseInt(p[1], 10);
    if (Number.isNaN(e) || Number.isNaN(c)) return null;
    return { enrolled: e, cap: c, open: Math.max(0, c - e), full: e >= c };
}

// First section with open seats, else the first section.
function pickDefaultKey(members) {
    const open = members.find(m => { const s = parseSeats(m["Cap"]); return s && !s.full; });
    return (open || members[0])["_key"];
}

function registerSectionPop(course, members) {
    const id = "sp" + (sectionPopSeq++);
    sectionPopRegistry[id] = { course, members };
    return id;
}

// Merge sections that share days + times + instructor.
function mergeIdentical(list) {
    const m = new Map();
    for (const s of list) {
        const k = `${s["Days"]}|${s["Times"]}|${s["Instructor"]}`;
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(s);
    }
    return [...m.values()];
}

function starBtnHtml(defKey, popId, starred, extra = "") {
    return `<button class="grp_star btn-press text-lg leading-none ${starred ? "text-amber-400" : "text-slate-300 dark:text-slate-600 hover:text-amber-400"}" data-key="${escapeAttr(defKey)}" data-secpop="${popId}" title="Star a section ${extra}(hover to choose)">${starred ? "★" : "☆"}</button>`;
}

function addMinusHtml(defKey, allKeys, popId, removeTip) {
    return `<span class="inline-flex gap-2">
        <button class="grp_add btn-press inline-grid place-items-center h-7 w-7 rounded-lg border border-green-500/50 bg-green-500/5 text-green-600 dark:text-green-400 hover:bg-green-600 hover:text-white hover:border-green-600" data-key="${escapeAttr(defKey)}" data-secpop="${popId}" title="Add a section (hover to choose one)">
            <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14M5 12h14"/></svg>
        </button>
        <button class="grp_minus tip-trigger btn-press inline-grid place-items-center h-7 w-7 rounded-lg border border-red-500/50 bg-red-500/5 text-red-600 dark:text-red-400 hover:bg-red-600 hover:text-white hover:border-red-600" data-keys="${escapeAttr(allKeys)}" data-tip="${escapeAttr(removeTip)}">
            <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14"/></svg>
        </button>
    </span>`;
}

// Header bar above a course's grouped sections, with its own add/star/minus.
function renderGroupHeader(course, allSections, gid) {
    const collapsed = collapsedCourses.has(course["Course"]);
    const dataColCount = Math.max(1, visibleResultColumns().length);
    const popId = registerSectionPop(course["Course"], allSections);
    const defKey = pickDefaultKey(allSections);
    const allKeys = allSections.map(s => s["_key"]).join(",");
    const starred = allSections.some(s => config.favorites.includes(s["_key"]));
    const detail = course["details"] || "";
    // Second line: the description if we have one, else the credit value. Never the section
    // count — the "N sections" badge already shows it (that was the duplicate the header had).
    const cr = course["Cr"];
    const descLine = detail
        ? `<div class="tip-trigger cursor-help text-xs text-slate-500 dark:text-slate-400 truncate leading-snug mt-0.5" data-tip="${escapeAttr(detail)}">${escapeHtml(detail)}</div>`
        : (cr ? `<div class="text-xs text-slate-400 dark:text-slate-500 mt-0.5">${escapeHtml(cr)} credits</div>` : "");
    const tags = [...new Set(allSections.flatMap(s => Array.isArray(s["_tags"]) ? s["_tags"] : []))];
    const chevron = `<svg class="h-4 w-4 text-slate-400 transition-transform ${collapsed ? "-rotate-90" : ""}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6"/></svg>`;
    const tabBorder = collapsed ? "border-accent-500/40" : "border-accent-500";
    return `<tr class="wgroup-header" data-group-header="${gid}" data-course-code="${escapeAttr(course["Course"] || "")}">
        <td class="grp_tab border-l-2 ${tabBorder} px-2 py-1.5 text-center align-middle">${starBtnHtml(defKey, popId, starred, "of " + escapeAttr(course["Course"]) + " ")}</td>
        <td class="px-2 py-1.5 text-center align-middle whitespace-nowrap">${addMinusHtml(defKey, allKeys, popId, `Hide all ${course["Course"]} sections`)}</td>
        <td colspan="${dataColCount}" class="px-2 py-1.5 align-middle">
            <div class="flex items-center gap-2.5 min-w-0">
                <button class="grp_collapse btn-press grid place-items-center h-6 w-6 rounded-md hover:bg-accent-100/60 dark:hover:bg-accent-500/15 shrink-0" data-course="${escapeAttr(course["Course"])}" data-gid="${gid}" title="Collapse / expand">${chevron}</button>
                <div class="flex-1 min-w-0">
                    <div class="flex items-baseline gap-2 min-w-0">
                        <span class="font-semibold text-sm text-slate-800 dark:text-slate-100 whitespace-nowrap">${escapeHtml(course["Course"] || "")}</span>
                        <span class="text-sm text-slate-600 dark:text-slate-300 truncate">${escapeHtml(course["Title"] || "")}</span>
                        <span class="text-[11px] font-medium text-accent-600 dark:text-accent-400 whitespace-nowrap shrink-0">${allSections.length} sections</span>
                        ${tagBadgesHtml(tags)}
                    </div>
                    ${descLine}
                </div>
            </div>
        </td>
    </tr>`;
}

// Course-attribute badges (Cross-Listed, Consent Required, Honors, …).
function tagBadgesHtml(tags) {
    if (!tags || !tags.length) return "";
    return tags.map(t =>
        `<span class="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap shrink-0 bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">${escapeHtml(t)}</span>`
    ).join("");
}

// A merged section row (represents one or more identical sections).
function renderMergedSectionRow(members, gid, course, collapsed) {
    const rep = members[0];
    const count = members.length;
    const popId = registerSectionPop(course, members);
    const defKey = pickDefaultKey(members);
    const allKeys = members.map(m => m["_key"]).join(",");
    const starred = members.some(m => config.favorites.includes(m["_key"]));
    const deliveryHtml = deliveryBadgeHtml(rep);

    const moreBadge = count > 1
        ? `<span class="ml-1 inline-flex items-center rounded px-1 text-[10px] font-semibold bg-accent-100 text-accent-700 dark:bg-accent-500/20 dark:text-accent-300">×${count}</span>` : "";
    const secCell = `<span class="font-mono font-bold text-sm text-slate-700 dark:text-slate-200">${escapeHtml(rep["Section"] || "—")}</span>${moreBadge}<span class="font-mono text-[11px] text-slate-400 dark:text-slate-500 ml-1.5">${escapeHtml(rep["Cr"] || "—")}cr</span>${deliveryHtml}`;

    // Cap: a single section shows its seats; a merged set shows total open seats.
    let capCell;
    if (count > 1) {
        const open = members.reduce((a, m) => { const s = parseSeats(m["Cap"]); return a + (s ? s.open : 0); }, 0);
        capCell = open > 0
            ? `<span class="tnum text-green-600 dark:text-green-400 font-medium">${open} open</span>`
            : `<span class="tnum text-red-600 dark:text-red-400 font-semibold">Full</span>`;
    } else {
        capCell = capCellHtml(rep["Cap"]);
    }
    const multi = count > 1;
    const popData = multi ? ` data-secpop="${popId}"` : "";
    const helpCls = multi ? " cursor-help" : "";

    return `<tr class="wsection${collapsed ? " hidden" : ""}" data-group="${gid}" data-course-code="${escapeAttr(rep["Course"] || "")}">
        <td class="px-2 py-2 text-center align-middle">${starBtnHtml(defKey, popId, starred)}</td>
        <td class="px-2 py-2 text-center align-middle whitespace-nowrap">${addMinusHtml(defKey, allKeys, popId, multi ? `Hide all ${count} sections` : "Hide this section")}</td>
        ${renderResultCells(rep, { py: "py-2", sectionCellHtml: secCell, helpCls, popData, capCellHtml: capCell })}
    </tr>`;
}

function renderSectionDivider(gid, collapsed) {
    const totalColCount = visibleResultColumns().length + 2;
    return `<tr class="wdivider${collapsed ? " hidden" : ""}" data-group="${gid}">
        <td colspan="${totalColCount}" class="px-3 py-1">
            <div class="h-px w-full bg-accent-300/60 dark:bg-accent-500/30"></div>
        </td>
    </tr>`;
}

// Build the results body: group same-course sections under a header, split into
// numeric/lettered blocks, and merge identical sections.
function renderGroupedBody(result_classes) {
    sectionPopRegistry = {};
    sectionPopSeq = 0;
    const groups = new Map();
    for (const c of result_classes) {
        const key = c["Course"] || "";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
    }
    let html = "";
    let gidSeq = 0;
    for (const secs of groups.values()) {
        if (secs.length === 1) { html += renderRow(secs[0]); continue; }
        const gid = "g" + (gidSeq++);
        const courseCode = secs[0]["Course"];
        const collapsed = collapsedCourses.has(courseCode);
        const nums = secs.filter(s => sectionKindOf(s["Section"]) === "num");
        const alphas = secs.filter(s => sectionKindOf(s["Section"]) === "alpha");
        const numMerged = mergeIdentical(nums);
        const alphaMerged = mergeIdentical(alphas);
        html += renderGroupHeader(secs[0], secs, gid);
        for (const m of numMerged) html += renderMergedSectionRow(m, gid, courseCode, collapsed);
        if (numMerged.length && alphaMerged.length) html += renderSectionDivider(gid, collapsed);
        for (const m of alphaMerged) html += renderMergedSectionRow(m, gid, courseCode, collapsed);
    }
    return html;
}

// --- Grouped interactions: section popover + per-section add/star/minus -------

function renderSectionPopContent(course, members) {
    const rows = members.map(m => {
        const seats = m["Cap"] || "";
        const isStar = config.favorites.includes(m["_key"]);
        const isAdded = config.courses.includes(m["_key"]);
        const { timeHtml, daysHtml } = daysTimeHtml(m);
        return `<div class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800/60">
            <span class="font-mono font-bold text-xs w-7 shrink-0 text-slate-700 dark:text-slate-200">${escapeHtml(m["Section"] || "—")}</span>
            <span class="text-[11px] text-slate-500 dark:text-slate-400 flex-1 min-w-0 truncate">${daysHtml} ${timeHtml}</span>
            <span class="font-mono text-[11px] ${capClass(seats)} shrink-0">${escapeHtml(seats)}</span>
            <button class="pop_star btn-press text-base leading-none ${isStar ? "text-amber-400" : "text-slate-300 dark:text-slate-600 hover:text-amber-400"}" data-key="${escapeAttr(m["_key"])}" title="Star this section">${isStar ? "★" : "☆"}</button>
            <button class="pop_add btn-press inline-grid place-items-center h-5 w-5 rounded border ${isAdded ? "border-green-600 bg-green-600 text-white" : "border-green-500/50 bg-green-500/5 text-green-600 dark:text-green-400 hover:bg-green-600 hover:text-white"}" data-key="${escapeAttr(m["_key"])}" title="${isAdded ? "Added" : "Add this section"}">
                <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14M5 12h14"/></svg>
            </button>
        </div>`;
    }).join("");
    return `<div class="px-3 py-2 border-b border-slate-100 dark:border-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-200">${escapeHtml(course)} · ${members.length} section${members.length === 1 ? "" : "s"}</div>
        <div class="p-1 max-h-64 overflow-auto">${rows}</div>`;
}

let secPopHideTimer = null;

function positionFloating(el, anchor) {
    const r = anchor.getBoundingClientRect();
    const tr = el.getBoundingClientRect();
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
    let top = r.bottom + 8;
    if (top + tr.height > window.innerHeight - 8) top = Math.max(8, r.top - tr.height - 8);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
}

function showSectionPop(triggerEl) {
    const entry = sectionPopRegistry[triggerEl.dataset.secpop];
    if (!entry) return;
    clearTimeout(secPopHideTimer);
    const pop = document.getElementById("section-popover");
    pop.innerHTML = renderSectionPopContent(entry.course, entry.members);
    pop.classList.add("visible");
    positionFloating(pop, triggerEl);
}

function scheduleSecPopHide() {
    clearTimeout(secPopHideTimer);
    secPopHideTimer = setTimeout(hideSectionPop, 220);
}

function hideSectionPop() {
    const p = document.getElementById("section-popover");
    if (p) p.classList.remove("visible");
}

function initSectionPopover() {
    const pop = document.getElementById("section-popover");
    if (!pop || pop.dataset.bound) return;
    pop.dataset.bound = "1";
    pop.addEventListener("mouseenter", () => clearTimeout(secPopHideTimer));
    pop.addEventListener("mouseleave", scheduleSecPopHide);
    pop.addEventListener("click", e => {
        const add = e.target.closest(".pop_add");
        const star = e.target.closest(".pop_star");
        if (add) addSectionByKey(add.dataset.key);
        else if (star) starSectionByKey(star.dataset.key);
    });
}

function addSectionByKey(key) {
    if (!key) return;
    if (!config.courses.includes(key)) config.courses.push(key);
    config.course_excludes = (config.course_excludes || []).filter(c => c !== key);
    justAddedCrn = key;
    hideSectionPop();
    calculateSchedule();
    saveConfig();
    refreshResults();
}

function starSectionByKey(key) {
    if (!key) return;
    if (config.favorites.includes(key)) config.favorites = config.favorites.filter(c => c !== key);
    else { config.favorites.push(key); justStarredCrn = key; }
    saveConfig();
    refreshResults();
}

function removeSectionsByKeys(keys) {
    for (const k of keys) if (k && !config.course_excludes.includes(k)) config.course_excludes.push(k);
    hideSectionPop();
    saveConfig();
    refreshResults();
}

function toggleGroupCollapse(courseCode, gid, btn) {
    if (collapsedCourses.has(courseCode)) collapsedCourses.delete(courseCode);
    else collapsedCourses.add(courseCode);
    const collapsed = collapsedCourses.has(courseCode);
    document.querySelectorAll(`#results-body [data-group="${gid}"]`).forEach(r => r.classList.toggle("hidden", collapsed));
    const chev = btn.querySelector("svg");
    if (chev) chev.classList.toggle("-rotate-90", collapsed);
    // Border tab: muted while collapsed, full accent once opened.
    const tab = btn.closest("tr")?.querySelector(".grp_tab");
    if (tab) {
        tab.classList.toggle("border-accent-500", !collapsed);
        tab.classList.toggle("border-accent-500/40", collapsed);
    }
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

function courseCountKey(course, fallback) {
    return (course && course["Course"] ? course["Course"] : fallback || "").trim().toLowerCase();
}

function sectionsForCourse(courseCode) {
    return Object.values(classes).filter(c => c && c["Course"] === courseCode);
}

// Compact label for a set of section codes: "01", "01–03", "A–C".
function sectionRangeLabel(sectionCodes) {
    const codes = [...new Set((sectionCodes || []).map(s => String(s || "").trim()).filter(Boolean))];
    if (!codes.length) return "";
    codes.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    if (codes.length === 1) return codes[0];
    return `${codes[0]}–${codes[codes.length - 1]}`;
}

function sectionRequirementForCourse(courseCode) {
    if (!(currentSchema.caps && currentSchema.caps.sectionGroups) || !courseCode) return null;
    const sections = sectionsForCourse(courseCode);
    if (!sections.length) return null;

    const explicit = sections.find(s => Array.isArray(s["_l2_requirement_groups"]) && s["_l2_requirement_groups"].length);
    if (explicit) {
        const groups = explicit["_l2_requirement_groups"].map((g, i) => {
            const listed = Array.isArray(g.sections) ? g.sections : [];
            const label = g.label || sectionRangeLabel(listed) || g.id || `Part ${i + 1}`;
            return { id: String(g.id || `group-${i + 1}`), label, sections: listed };
        });
        if (groups.length) return { source: "l2", groups };
    }

    const perSection = new Map();
    for (const s of sections) {
        const id = s["_l2_section_group"];
        if (!id) continue;
        if (!perSection.has(id)) perSection.set(id, { id: String(id), label: String(id), sections: [] });
        perSection.get(id).sections.push(s["Section"]);
    }
    if (perSection.size > 1) {
        const groups = [...perSection.values()].map(g => ({
            ...g,
            label: sectionRangeLabel(g.sections) || g.label
        }));
        return { source: "l2", groups };
    }

    if (!currentSchema.grouped) return null;
    const nums = sections.filter(s => sectionKindOf(s["Section"]) === "num");
    const alphas = sections.filter(s => sectionKindOf(s["Section"]) === "alpha");
    if (!nums.length || !alphas.length) return null;
    return {
        source: "fallback",
        groups: [
            { id: "num", label: sectionRangeLabel(nums.map(s => s["Section"])), kind: "num", sections: [] },
            { id: "alpha", label: sectionRangeLabel(alphas.map(s => s["Section"])), kind: "alpha", sections: [] }
        ]
    };
}

function sectionMatchesRequirement(section, group) {
    if (!section || !group) return false;
    const sec = String(section["Section"] || "").trim();
    if (Array.isArray(group.sections) && group.sections.length) {
        return group.sections.map(s => String(s).trim().toUpperCase()).includes(sec.toUpperCase());
    }
    if (section["_l2_section_group"] && String(section["_l2_section_group"]) === String(group.id)) return true;
    if (group.kind) return sectionKindOf(sec) === group.kind;
    return false;
}

function savedRequirementStatus(courseCode, savedIds) {
    const requirement = sectionRequirementForCourse(courseCode);
    if (!requirement) return null;
    const savedSections = (savedIds || []).map(id => classes[id]).filter(Boolean);
    const missing = requirement.groups.filter(g => !savedSections.some(s => sectionMatchesRequirement(s, g)));
    return { requirement, missing, complete: missing.length === 0 };
}

function focusRequirementGroup(courseCode) {
    config.search_bar = courseCode;
    const input = document.getElementById("search_bar");
    if (input) input.value = courseCode;
    collapsedCourses.delete(courseCode);
    saveConfig();
    refreshResults();
    window.requestAnimationFrame(() => {
        const row = [...document.querySelectorAll("#results-body [data-course-code]")]
            .find(el => el.dataset.courseCode === courseCode);
        if (row) row.scrollIntoView({ block: "center", behavior: "smooth" });
    });
}

function savedCourseSummary(ids) {
    const unique = new Map();
    for (const id of ids || []) {
        const course = classes[id];
        if (!course) continue;
        const key = courseCountKey(course, id);
        const credits = parseFloat(course["Cr"]);
        const creditValue = Number.isNaN(credits) ? 0 : credits;
        unique.set(key, Math.max(unique.get(key) || 0, creditValue));
    }
    const credits = Array.from(unique.values()).reduce((sum, cr) => sum + cr, 0);
    return { classCount: unique.size, credits };
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
    const summary = savedCourseSummary(valid);
    count.textContent = summary.classCount;
    empty.classList.toggle("hidden", valid.length > 0);

    // Master "show conflicting classes" toggle — visible only with saved courses,
    // checked when every saved course already has conflicts shown.
    const masterRow = document.getElementById("conflicts_master_row");
    const masterToggle = document.getElementById("conflicts_master_toggle");
    if (masterRow && masterToggle) {
        masterRow.classList.toggle("hidden", valid.length === 0);
        masterRow.classList.toggle("flex", valid.length > 0);
        const shown = config.show_conflict_crns || [];
        const allOn = valid.length > 0 && valid.every(crn => shown.includes(crn));
        masterToggle.setAttribute("aria-checked", allOn ? "true" : "false");
    }

    const byCourse = new Map();
    for (const crn of valid) {
        const code = classes[crn]["Course"] || crn;
        if (!byCourse.has(code)) byCourse.set(code, []);
        byCourse.get(code).push(crn);
    }
    const renderedRequired = new Set();

    for (const crn of valid) {
        const c = classes[crn];
        const courseCode = c["Course"] || crn;
        const courseIds = byCourse.get(courseCode) || [crn];
        const reqStatus = savedRequirementStatus(courseCode, courseIds);
        if (reqStatus) {
            if (renderedRequired.has(courseCode)) continue;
            renderedRequired.add(courseCode);
            const color = courseColor(courseCode);
            const savedSecs = courseIds.map(id => classes[id]).filter(Boolean);
            // One chip per required part: filled when a matching section is saved.
            const partChips = reqStatus.requirement.groups.map(g => {
                const filled = savedSecs.some(s => sectionMatchesRequirement(s, g));
                const tip = filled
                    ? `Have a section from ${g.label}`
                    : `Also need one section from ${g.label}`;
                const cls = filled
                    ? "bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300"
                    : "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300";
                return `<span class="tip-trigger cursor-help inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold font-mono ${cls}" data-tip="${escapeAttr(tip)}">${filled ? "✓" : "○"} ${escapeHtml(g.label)}</span>`;
            }).join("");
            const sectionRows = courseIds.map(id => {
                const sec = classes[id];
                const showConflicts = (config.show_conflict_crns || []).includes(id);
                return `<div class="flex items-center gap-2 rounded-md bg-slate-50 dark:bg-slate-800/60 px-2 py-1">
                    <span class="tip-trigger cursor-help flex-1 min-w-0" data-tip-crn="${escapeAttr(id)}">
                        <span class="font-mono text-xs text-slate-500 dark:text-slate-400">Sec ${escapeHtml(sec["Section"] || "—")}</span>
                    </span>
                    <button class="show_conflict_toggle switch switch-sm" role="switch" aria-checked="${showConflicts}" data-crn="${escapeAttr(id)}" type="button" title="Show classes that clash only with this section"><span class="switch-thumb"></span></button>
                    <button class="delete_course_btn btn-press shrink-0 grid place-items-center h-5 w-5 rounded text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors" id="delete_course_${id}" title="Remove">
                        <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>
                    </button>
                </div>`;
            }).join("");
            const missingLabel = reqStatus.missing.map(g => g.label).join(" / ");
            const missingAction = reqStatus.complete ? "" : `<button class="requirement_find_btn btn-press self-start ml-[18px] text-xs font-medium px-2 py-1 rounded-md border border-amber-300/70 text-amber-700 hover:bg-amber-50 dark:border-amber-500/40 dark:text-amber-300 dark:hover:bg-amber-500/10 transition-colors" data-course="${escapeAttr(courseCode)}" type="button" title="This course needs one section from each group">Add Sec ${escapeHtml(missingLabel)}</button>`;
            list.innerHTML += `<li class="flex flex-col gap-2 text-sm ${courseIds.includes(justAddedCrn) ? "animate-in" : ""}">
                <div class="flex items-start gap-2">
                    <span class="mt-1 h-2.5 w-2.5 rounded-full shrink-0" style="background:${color}"></span>
                    <span class="flex-1 min-w-0">
                        <span class="font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(courseCode)}</span>
                        <span class="text-slate-500 dark:text-slate-400"> · ${escapeHtml(c["Title"])}</span>
                    </span>
                </div>
                <div class="pl-[18px] flex flex-wrap gap-1">${partChips}</div>
                <div class="pl-[18px] flex flex-col gap-1">${sectionRows}</div>
                ${missingAction}
            </li>`;
            continue;
        }
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
    list.querySelectorAll(".requirement_find_btn").forEach(btn =>
        btn.addEventListener("click", () => focusRequirementGroup(btn.dataset.course)));
}

// Master toggle: turn "show conflicts" on for every saved course, or off for all
// if they're already all on.
function toggleAllShowConflicts() {
    const valid = config.courses.filter(crn => classes[crn]);
    if (!valid.length) return;
    const shown = config.show_conflict_crns || [];
    const allOn = valid.every(crn => shown.includes(crn));
    if (allOn) {
        config.show_conflict_crns = shown.filter(c => !valid.includes(c));
    } else {
        config.show_conflict_crns = Array.from(new Set([...shown, ...valid]));
    }
    saveConfig();
    refreshResults();
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

// Colours are assigned from consecutive slots rather than hashed straight to a hue.
// Hashing gave collisions constantly — with eight courses two would often land within
// a few degrees of each other (and sometimes on the exact same hue). Walking the
// golden angle over slots 0,1,2,... instead guarantees the courses actually on screen
// get the most widely separated hues available for that many colours.
const COURSE_HUE_STEP = 137.508;   // golden angle
const COURSE_HUE_START = 205;
let courseSlots = new Map();       // course code -> slot index

// Slots are sticky: a course keeps its colour for as long as it stays in play, so
// adding a class never repaints the ones already on the calendar. A fresh page load
// starts from an empty map and assigns in sorted order, so a given set of courses
// always opens with the same colours — but because removing a course leaves its slot
// free rather than compacting, a session with a lot of add/remove churn can come back
// with different colours after a reload. Stable while you work beats stable across
// reloads here, since only the former is visible as flicker.
function ensureCourseColors(codes) {
    const wanted = new Set((codes || []).filter(Boolean));
    for (const code of [...courseSlots.keys()]) {
        if (!wanted.has(code)) courseSlots.delete(code);
    }
    const used = new Set(courseSlots.values());
    const pending = [...wanted]
        .filter(code => !courseSlots.has(code))
        .sort((a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: "base"}));
    for (const code of pending) {
        let slot = 0;
        while (used.has(slot)) slot++;
        courseSlots.set(code, slot);
        used.add(slot);
    }
}

function courseHue(courseCode) {
    if (courseSlots.has(courseCode)) {
        return (COURSE_HUE_START + courseSlots.get(courseCode) * COURSE_HUE_STEP) % 360;
    }
    // Not in the active set (e.g. a stray lookup) — fall back to a stable hash.
    let hash = 0;
    for (let i = 0; i < courseCode.length; i++) hash = (hash * 31 + courseCode.charCodeAt(i)) >>> 0;
    return hash % 360;
}

// Hue alone gets crowded past ~10 courses, so lightness is a second axis: slots are
// banded in fives, and within any one band the hues are >=52 degrees apart. The first
// band keeps the original 45% lightness, so a typical schedule looks unchanged.
const COURSE_BAND = 5;
const COURSE_LIGHTNESS = [45, 38, 52];

function courseLightness(courseCode) {
    const slot = courseSlots.get(courseCode);
    if (slot === undefined) return COURSE_LIGHTNESS[0];
    return COURSE_LIGHTNESS[Math.floor(slot / COURSE_BAND) % COURSE_LIGHTNESS.length];
}

function courseColor(courseCode) {
    return `hsl(${courseHue(courseCode)} 62% ${courseLightness(courseCode)}%)`;
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
    const added = config.courses.filter(c => classes[c]);
    const summary = savedCourseSummary(added);
    const nCourses = summary.classCount;
    if (countEl) countEl.textContent = `${nCourses} class${nCourses === 1 ? "" : "es"}`;

    const creditsEl = document.getElementById("calendar_credits");
    if (creditsEl) {
        const totalCr = summary.credits;
        // Trim a trailing ".0" (e.g. 15 not 15.0) but keep genuine halves (13.5).
        const crText = Number.isInteger(totalCr) ? String(totalCr) : totalCr.toFixed(1);
        creditsEl.textContent = `${crText} cr`;
        creditsEl.classList.toggle("hidden", nCourses === 0);
    }

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

let tipHideTimer = null;

function scheduleTipHide(tip) {
    // Small grace period so the cursor can travel from the trigger onto the tip
    // (which lets the user select/copy its text) without it vanishing.
    clearTimeout(tipHideTimer);
    tipHideTimer = setTimeout(() => {
        tip.classList.remove("visible");
        activeTipEl = null;
    }, 220);
}

function initTooltips() {
    const tip = document.getElementById("floating-tip");

    // One-time wiring: keep the tip open while hovered, and live-swap Shift text.
    if (!tip.dataset.hoverBound) {
        tip.dataset.hoverBound = "1";
        tip.addEventListener("mouseenter", () => clearTimeout(tipHideTimer));
        tip.addEventListener("mouseleave", () => scheduleTipHide(tip));
        document.addEventListener("keydown", e => {
            if (e.key === "Shift" && !shiftHeld) {
                shiftHeld = true;
                if (activeTipEl && activeTipEl.dataset.tipShift) showTip(activeTipEl, tip);
            }
        });
        document.addEventListener("keyup", e => {
            if (e.key === "Shift" && shiftHeld) {
                shiftHeld = false;
                if (activeTipEl && activeTipEl.dataset.tipShift) showTip(activeTipEl, tip);
            }
        });
    }

    document.querySelectorAll(".tip-trigger").forEach(el => {
        if (el.dataset.tipBound) return;
        el.dataset.tipBound = "1";
        el.addEventListener("mouseenter", () => { clearTimeout(tipHideTimer); activeTipEl = el; showTip(el, tip); });
        el.addEventListener("mouseleave", () => scheduleTipHide(tip));
        el.addEventListener("focus", () => { clearTimeout(tipHideTimer); activeTipEl = el; showTip(el, tip); });
        el.addEventListener("blur", () => scheduleTipHide(tip));
    });
}

function showTip(el, tip) {
    // Rich card (full class details) when data-tip-crn is present, else plain text.
    // A `data-tip-shift` alternate is shown while Shift is held.
    if (el.dataset.tipCrn) {
        const html = classDetailsHtml(el.dataset.tipCrn);
        if (!html) return;
        tip.innerHTML = html;
    } else {
        const text = (shiftHeld && el.dataset.tipShift) ? el.dataset.tipShift : el.dataset.tip;
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
    const loc = displayLocation(c);
    const where = [loc.place, loc.campus].filter(Boolean).join(", ");

    return `<div class="text-left space-y-1">
        <div class="font-semibold text-white">${escapeHtml(c["Course"])} · Sec ${escapeHtml(c["Section"] || "—")}</div>
        <div class="text-slate-200">${escapeHtml(c["Title"] || "")}</div>
        <div class="pt-1 space-y-0.5">
            ${row("When", times)}
            ${row("Where", where)}
            ${row("Instructor", c["Instructor"])}
            ${row("Credits", c["Cr"])}
            ${row("Seats", c["Cap"])}
            ${row("CRN", c["CRN"])}
            ${row("Status", c["_l2_status"])}
        </div>
        ${c["details"] ? `<div class="pt-1 text-slate-300 border-t border-white/10 mt-1">${escapeHtml(c["details"])}</div>` : ""}
        ${c["_l2_eligibility"] ? `<div class="pt-1 text-slate-300 border-t border-white/10 mt-1">Eligibility: ${escapeHtml(c["_l2_eligibility"])}</div>` : ""}
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
