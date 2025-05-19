// Get classes.json (for website)
let classes = [];
let days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
let config = {
    "max_level": 4,
    "prefixes_open": true,
    "schedule_exclude_open": true,
    "schedule_exclude_0_pre": "08:30",
    "schedule_exclude_0_post": "15:30",
    "schedule_exclude_1_pre": "08:30",
    "schedule_exclude_1_post": "15:30",
    "schedule_exclude_2_pre": "08:30",
    "schedule_exclude_2_post": "15:30",
    "schedule_exclude_3_pre": "08:30",
    "schedule_exclude_3_post": "15:30",
    "schedule_exclude_4_pre": "08:30",
    "schedule_exclude_4_post": "14:15",
    "margin_time": 10,
    "dynamic_times": true,
    "prefixes": ["*"],
    "courses": [],
    "course_excludes": [],
    "favorites": [],
    "search_bar": ""
}
let all_prefixes = [];
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
    all_prefixes = [];
    for (let course of Object.values(classes)) {
        let prefix = course["Course"].split(" ")[0];
        if (!all_prefixes.includes(prefix)) {
            all_prefixes.push(prefix);

            if (!config.prefixes.includes(prefix) && isAll) {
                config.prefixes.push(prefix);
            }

            document.getElementById("prefixes_list").innerHTML += `<label><input ${config.prefixes.includes(prefix) ? "checked" : ""}
                type="checkbox" class="prefix_toggle" id="prefix_toggle_${prefix}"> ${prefix}</label>`

        }
    }

    // Load the rest of the config
    for (let [key, value] of Object.entries(config)) {
        if (["prefixes", "courses", "course_excludes", "search"].includes(key)) continue;
        if (["max_level", "margin_time", "search_bar"].includes(key)) {
            document.getElementById(key).value = value;
            continue;
        }
        if (["dynamic_times"].includes(key)) {
            document.getElementById(key).checked = value;
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

    for (let prefix of all_prefixes) {
        document.getElementById(`prefix_toggle_${prefix}`).addEventListener("change", handlePrefixToggle);
    }

    for (let i = 0; i < days.length; i++) {
        document.getElementById(`schedule_exclude_${i}_pre`).addEventListener("input", handleValueChange);
        document.getElementById(`schedule_exclude_${i}_post`).addEventListener("input", handleValueChange);
    }

    document.querySelectorAll(".collapse_toggle").forEach((toggle) => {
        toggle.addEventListener("click", handleCollapseToggle);
    });

    document.getElementById("search_bar").addEventListener("change", handleSearchBarChange);
    document.getElementById("search_bar").value = config.search_bar;

    document.getElementById("prefixes_all").addEventListener("click", handlePrefixAllNone);
    document.getElementById("prefixes_none").addEventListener("click", handlePrefixAllNone);

    document.getElementById("dynamic_times").addEventListener("click", handleValueChange);

    // Render the table header
    let th = document.getElementById("results-header");
    let header_elements = ["★","+", "-", ...Object.keys(classes[Object.keys(classes)[0]])].filter(key => key !== "details").map(key => {
        return `<th class="px-4 py-2 border-gray-300 border">${key === "Notes" ? "More" : key}</th>`;
    });
    th.innerHTML = `<tr class="bg-gray-200">${header_elements.join("")}</tr>`;

    // Render the table body
    refreshResults()

}

function handleValueChange(e) {
    let value = e.target.value;
    if (e.target.type === "checkbox") {
        value = e.target.checked;
    }
    let id = e.target.id;
    config[id] = value;
    localStorage.setItem("config", btoa(JSON.stringify(config)));
    refreshResults()
}

function handleSearchBarChange(e) {
    handleValueChange(e);

    console.log(e.target.value)
    // Perform search

    refreshResults()
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

function handlePrefixAllNone(e) {
    let all = e.target.id === "prefixes_all";
    if (all) {
        config.prefixes = all_prefixes.slice(0);
        document.querySelectorAll(".prefix_toggle").forEach((toggle) => {
            toggle.checked = true;
        });
    } else {
        config.prefixes = [];
        document.querySelectorAll(".prefix_toggle").forEach((toggle) => {
            toggle.checked = false;
        });
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
    let result_classes = [];
    // Filter and add classes based on the config

    result_classes = Object.values(classes).filter(course => !config.course_excludes.includes(course["CRN"]))
        .filter(course => !(Number.parseInt(course["Course"].split(" ")[1][0]) > config.max_level))
        .filter(course => config.prefixes.includes(course["Course"].split(" ")[0]))

    console.log(result_classes.length, "Filtered classes");

    let search_results = result_classes;

    // Perform search
    if (config.search_bar.length > 0) {
        const fuse = new Fuse(result_classes, {
            keys: ["Course", "Title", "Instructor"],
            minMatchCharLength: 2,
            threshold: 0.3,
        })
        search_results = fuse.search(config.search_bar);
        console.log(search_results.length, "Search results");
        search_results = search_results.map(result => result.item);
    }

    // If too many, show first 200 results
    if (search_results.length > 200) {
        search_results = search_results.slice(0, 200);
    }
    // Render the results
    let results = document.getElementById("results-body");
    results.innerHTML = "";
    for (const course of search_results) {
        let rowHTML = `
        <tr class="border-b border-gray-300">
        <td class="py-2 border-gray-300 border text-center"><button class="star_course_btn rounded border-yellow-600 text-yellow-800 font-extrabold text-2xl hover:bg-yellow-600 hover:text-white transition-colors" id="star_course_${course["CRN"]}">${config.favorites.includes(course["CRN"]) ? "★" : "☆"}</button></td>
        <td class="py-2 border-gray-300 border text-center"><button class="add_course_btn border-2 rounded px-1 border-green-600 text-green-800 font-extrabold hover:bg-green-600 hover:border-2 hover:text-white transition-colors" id="add_course_${course["CRN"]}">+</button></td>
        <td class="py-2 border-gray-300 border text-center"><button class="remove_course_btn border-2 rounded px-2 border-red-600 text-red-800 font-extrabold hover:bg-red-600 hover:border-2 hover:text-white transition-colors" id="remove_course_${course["CRN"]}">-</button></td>
`
        for (let [key, value] of Object.entries(course)) {
            if (key === "details") continue;
            if (key === "Notes") {
                rowHTML += `<td class="px-4 py-2 border-gray-300 border">
                <a class="details_btn" id="details_${course["CRN"]}"><img width="25" height="25" src="https://img.icons8.com/ios/100/info--v1.png" alt="info--v1"/></a>`;
                if (value.length > 0) {
                    rowHTML += `<a class="notes_btn mt-2" id="notes_${course["CRN"]}"><img width="25" height="25" src="https://img.icons8.com/material-outlined/24/note.png" alt="note"/></a>`
                }
                continue;
            }
            if (key === "Times" && config.dynamic_times && value.length > 0) {
                value = value.split("\n").map(time => {
                    let [start, end] = time.split("-").map(t => Number.parseInt(t.trim()));
                    let out_string = "";
                    if (start >= 1300) {
                        out_string += `${Math.floor(start / 100 - 12)}:${String(start % 100).padStart(2, "0")}&nbsp;PM`;
                    } else {
                        out_string += `${Math.floor(start / 100)}:${String(start % 100).padStart(2, "0")}&nbsp;AM`;
                    }
                    out_string += "&nbsp;-&nbsp;";
                    if (end >= 1300) {
                        out_string += `${Math.floor(end / 100 - 12)}:${String(end % 100).padStart(2, "0")}&nbsp;PM`;
                    } else {
                        out_string += `${Math.floor(end / 100)}:${String(end % 100).padStart(2, "0")}&nbsp;AM`;
                    }
                    return out_string;
                }).join("<br>");
            }
            if (key === "Cap") {
                console.log("dyn cap", value.split("/").length === 2);
                let [enrolled, cap] = value.split("/").map(v => Number.parseInt(v.trim()));
                if (!isNaN(cap) && !isNaN(enrolled) && cap > 0) {
                    let percent = Math.floor((enrolled / cap) * 100);
                    if (percent >= 100) {
                        value = `<span class="text-red-900 font-bold">${value}</span>`;
                    } else if (percent > 75) {
                        value = `<span class="text-yellow-900 font-bold">${value}</span>`;
                    } else {
                        value = `<span class="text-green-900 font-bold">${value}</span>`;
                    }
                }
            }
            rowHTML += `<td class="px-4 py-2 border-gray-300 border">${value.replaceAll("\n", "<br>").replaceAll("-", key==="Times" ? "&#8209;" : "-")}</td>`;
        }
        rowHTML += `</tr>`;
        results.innerHTML += rowHTML;

    }

    // Add event listeners to the buttons
    document.querySelectorAll(".add_course_btn, .remove_course_btn, .star_course_btn").forEach((btn) => {
        btn.addEventListener("click", handleCourseButtonPress);
    });
    console.log(search_results[0], search_results.length);
}

function handleCourseButtonPress(e) {
    let type = e.target.id.split("_")[0];
    let crn = e.target.id.split("_")[2];

    switch (type) {
        case "add":
            if (!config.courses.includes(crn)) {
                config.courses.push(crn);
            }
            refreshResults();
            break;
        case "remove":
            if (!config.course_excludes.includes(crn)) {
                config.course_excludes.push(crn);
            }
            refreshResults();
            break;
        case "star":
            if (!config.favorites.includes(crn)) {
                config.favorites.push(crn);
                document.getElementById(`star_course_${crn}`).innerHTML = "★";
            } else {
                config.favorites = config.favorites.filter(c => c !== crn);
                document.getElementById(`star_course_${crn}`).innerHTML = "☆";
            }
            break;

    }

    localStorage.setItem("config", btoa(JSON.stringify(config)));
}

function handleCourseMoreMouseoverChange(e) {
    let crn = e.target.id.split("_")[1];
    let on_off = e.type === "mouseover" ? "on" : "off";
    let more_type = e.target.id.split("_")[0];
    let course = classes[crn];
    if (on_off === "on") {
        let popup = document.getElementById("popup");
        popup.classList.remove("hidden");
        popup.innerText = course[more_type === "details" ? "details" : "Notes"];
    }
    else {
        let details = document.getElementById("popup");
        details.classList.add("hidden");
        details.innerText = "";
    }
}