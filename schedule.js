// Get classes.json (for website)
let classes = [];
let days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
let config = {
    "max_level": 4,
    "prefixes_open": true,
    "schedule_exclude_open": true,
    "schedule_exclude_0_pre":"08:30",
    "schedule_exclude_0_post":"15:30",
    "schedule_exclude_1_pre":"08:30",
    "schedule_exclude_1_post":"15:30",
    "schedule_exclude_2_pre":"08:30",
    "schedule_exclude_2_post":"15:30",
    "schedule_exclude_3_pre":"08:30",
    "schedule_exclude_3_post":"15:30",
    "schedule_exclude_4_pre":"08:30",
    "schedule_exclude_4_post":"14:15",
    "margin_time": 10,
    "prefixes": ["*"],
    "courses": [],
    "course_excludes": [],
    "search_bar": ""
}
let letter_days = {
    "M": 0, "T": 1, "W": 2, "R": 3, "F": 4
}
fetch('./classes.json').then(response => {
    response.json().then(data => {
        classes = data;
        propagateWebpage()
    })
})

async function propagateWebpage() {
    if (localStorage.getItem("config") != null) {
        console.log("Found saved config");
        config = JSON.parse(atob(localStorage.getItem("config")));
    }
    
    // Render the exclude times
    for (let i = 0; i < days.length; i++) {
        document.getElementById("schedule_excludes").innerHTML += `<div class="flex flex-row justify-between max-w-80">
            <label>${days[i]}: </label>
            <div>
                <input class="bg-gray-100 rounded border border-gray-400" id="schedule_exclude_${i}_pre" type="time"  value="${config[`schedule_exclude_${i}_pre`]}"> - 
                <input class="bg-gray-100 rounded border border-gray-400" id="schedule_exclude_${i}_post" type="time" value="${config[`schedule_exclude_${i}_post`]}"></div>
        </div>`
    }

    // Assemble the prefixes
    let isAll = config.prefixes.length === 1 && config.prefixes[0] === "*";
    if (isAll) config.prefixes = [];
    let prefixes = [];
    for (let course of Object.values(classes)) {
        let prefix = course["Course"].split(" ")[0];
        if (!prefixes.includes(prefix)) {
            prefixes.push(prefix);

            if (!config.prefixes.includes(prefix) && isAll) {
                config.prefixes.push(prefix);
            }

            document.getElementById("prefixes_list").innerHTML += `<label><input ${config.prefixes.includes(prefix) ? "checked" : ""}
                type="checkbox" class="prefix_toggle" id="prefix_toggle_${prefix}">${prefix}</label>`

        }
    }

    // Load the rest of the config
    for (let [key, value] of Object.entries(config)) {
        if (["prefixes", "courses", "course_excludes", "search"].includes(key)) continue;
        if (["max_level", "margin_time", "search_bar"].includes(key)) {
            document.getElementById(key).value = value;
            continue;
        }
        if (key.endsWith("_collapse_open") && !value) {
            console.log(`Hiding ${key}`);
            document.getElementById(key.replace("_collapse_open", "_collapsable")).classList.add("hidden");
            continue;
        }
    }

    // Add event listeners
    document.getElementById("max_level").addEventListener("input", handleValueChange);
    document.getElementById("margin_time").addEventListener("input", handleValueChange);

    for (let prefix of prefixes) {
        document.getElementById(`prefix_toggle_${prefix}`).addEventListener("change", handlePrefixToggle);
    }

    for (let i = 0; i < days.length; i++) {
        document.getElementById(`schedule_exclude_${i}_pre`).addEventListener("input", handleValueChange);
        document.getElementById(`schedule_exclude_${i}_post`).addEventListener("input", handleValueChange);
    }

    document.querySelectorAll(".collapse_toggle").forEach((toggle) => {
        toggle.addEventListener("click", handleCollapseToggle);
    });

}

function handleValueChange(e) {
    let value = e.target.value;
    let id = e.target.id;
    config[id] = value;
    localStorage.setItem("config", btoa(JSON.stringify(config)));
    refreshResults()
}
function handleSearchBarChange(e) {
    handleValueChange(e);

    console.log(e.target.value)
    // Perform search
}

function handlePrefixToggle(e) {
    let prefix = e.target.id.replace("prefix_toggle_", "");
    let checked = e.target.checked;
    if (checked) {
        config.prefixes.push(prefix);
    } else {
        config.prefixes = config.prefixes.filter(p => p !== prefix);
    }
    localStorage.setItem("config", btoa(JSON.stringify(config)));
    refreshResults()
}

function handleCollapseToggle(e) {
    let id = e.target.id.replace("_collapse", "");
    let wasOpen = config[id + "_collapse_open"];
    config[id + "_collapse_open"] = !wasOpen;
    localStorage.setItem("config", btoa(JSON.stringify(config)));
    if (wasOpen) {
        document.getElementById(id + "_collapsable").classList.add("hidden");
    } else {
        document.getElementById(id + "_collapsable").classList.remove("hidden");
    }
}

function refreshResults() {
    // TODO: Render the results based on the config
}