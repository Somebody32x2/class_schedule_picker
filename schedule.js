// Get classes.json (for website)
let classes = [];
let days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
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
    "M": 0, "T": 1, "W": 2, "R": 3, "F": 4, "S": 5, "U": 6
}
let schedule = [[], [], [], [], [],[], []];
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
        }
    }

    all_prefixes.sort();
    for (let prefix of all_prefixes) {
        document.getElementById("prefixes_list").innerHTML += `<label><input ${config.prefixes.includes(prefix) ? "checked" : ""}
                type="checkbox" class="prefix_toggle" id="prefix_toggle_${prefix}"> ${prefix}</label>`
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

    // Add the current config time values to the occupied times
    calculateSchedule();


    // Render the table header
    let th = document.getElementById("results-header");
    let header_elements = ["★", "+", "-", ...Object.keys(classes[Object.keys(classes)[0]])].filter(key => key !== "details").map(key => {
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
    if (id.startsWith("schedule_exclude_")) {
        calculateSchedule();
    }
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
        .filter(course => {
            // Check if the course is in the schedule
            return !schedule.some(day => {
                day.some(event => {
                    return event.id === course["Course"]
                })
            })
        }).filter(course => {
            if (course["Days"].length===0 || course["Times"].length === 0) return true;
            // Check if the course conflicts with the schedule
            let day_blocks = course["Days"].split("\n"); // M, MW
            let time_blocks = course["Times"].split("\n").map(x => [...x.split("-")]); // 10:00-11:00, 12:00-13:00
            for (let i = 0; i < day_blocks.length; i++) {
                // Check if any time for each day it occurs is between schedule occupied times
                // Parse this time block
                let pretime = +time_blocks[i][0].slice(0, 2) * 60 + +time_blocks[i][0].slice(2);
                let posttime = +time_blocks[i][1].slice(0, 2) * 60 + +time_blocks[i][1].slice(2);
                // Check if any of the schedule times overlap with this time block for each day this class meets

                for (let d of day_blocks[i].split("")) {
                    console.log(schedule[letter_days[d]], d,);
                    if (schedule[letter_days[d]].some(event => {
                        return (event.start - config.margin_time <= pretime && pretime <= event.end + config.margin_time || event.start - config.margin_time <= posttime && posttime <= event.end + config.margin_time)
                    })) {
                        return false;
                    }
                }
            }
            return true;
        })

    console.log(result_classes.length, "Filtered classes");

    let search_results = result_classes;

    // Perform search
    if (config.search_bar.length > 0) {
        const fuse = new Fuse(result_classes, {
            keys: ["Course", "Title", "Instructor"], minMatchCharLength: 2, threshold: 0.3,
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
                <a class="details_btn" id="details_${course["CRN"]}"><div class="tooltip"><img width="25" height="25" src="https://img.icons8.com/ios/100/info--v1.png" alt="info--v1"/><p class="tooltiptext w-80">${course["details"]}</p></div></a>`;
                if (value.length > 0) {
                    rowHTML += `<a class="notes_btn mt-2" id="notes_${course["CRN"]}"><div class="tooltip"><img width="25" height="25" src="https://img.icons8.com/material-outlined/24/note.png" alt="note"/><p class="tooltiptext">${course["Notes"]}</p> </div> </a>`
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
            rowHTML += `<td class="px-4 py-2 border-gray-300 border">${value.replaceAll("\n", "<br>").replaceAll("-", key === "Times" ? "&#8209;" : "-")}</td>`;
        }
        rowHTML += `</tr>`;
        results.innerHTML += rowHTML;

    }

    let courses_list = document.getElementById("courses_list");
    courses_list.innerHTML = "";
    for (let course of config.courses) {
        let course_data = classes[+course];
        courses_list.innerHTML += `<li class="text-gray-800 font-bold">
${course_data["Course"]} - ${course_data["Title"]} <button class="remove_course_btn text-red-500 font-bold hover:font-extrabold" onclick="handleCourseButtonPress({target:{id:'delete_course_${course_data["CRN"]}'}})" >X</button></li>`;
        console.log(course_data["Course"]);
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

    console.log(type, crn);

    switch (type) {
        case "add":
            if (!config.courses.includes(crn)) {
                config.courses.push(crn);
            }
            calculateSchedule();
            refreshResults();
            break;
        case "delete":
            if (config.courses.includes(crn)) {
                config.courses = config.courses.filter(c => c !== crn);
            }
            calculateSchedule();
            refreshResults();
            break;
        case "remove":
            if (!config.course_excludes.includes(crn)) {
                config.course_excludes.push(crn);
            }
            calculateSchedule();
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
    } else {
        let details = document.getElementById("popup");
        details.classList.add("hidden");
        details.innerText = "";
    }
}

function calculateSchedule() {
    schedule = [[], [], [], [], [], [], []];
    for (let i = 0; i < 5; i++) {
        let pre_time = config[`schedule_exclude_${i}_pre`].split(":").map(x => Number.parseInt(x));
        let post_time = config[`schedule_exclude_${i}_post`].split(":").map(x => Number.parseInt(x));
        schedule[i].push({
            start: pre_time[0] * 60 + pre_time[1],
            end: post_time[0] * 60 + post_time[1],
            name: "Schedule Exclude",
            id: "schedule_exclude"
        });
    }
    for (let course of config.courses) {
        let course_data = classes[course];
        let day_blocks = course_data["Days"].split("\n"); // M, MW
        let time_blocks = course_data["Times"].split("\n").map(x => [x.split("-")[0].trim(), x.split("-")[1].trim()]); // 10:00-11:00, 12:00-13:00
        for (let i = 0; i < day_blocks.length; i++) {
            // Check if any time for each day it occurs is between schedule occupied times
            // Parse this time block
            let pretime = +time_blocks[i][0].slice(0, 2) * 60 + +time_blocks[i][0].slice(2);
            let posttime = +time_blocks[i][1].slice(0, 2) * 60 + +time_blocks[i][1].slice(2);
            // Add the time blocks to the schedule
            for (let d of day_blocks[i].split("")) {
                schedule[letter_days[d]].push({
                    start: pretime, end: posttime, name: course_data["Course"], id: course_data["Course"]
                });
            }
        }
    }
}