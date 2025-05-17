const fs = require('fs');
const cheerio = require('cheerio');

require('dotenv').config();

const url_base = process.env.URL;
const min_page = process.env.PAGE_MIN;
const max_page = process.env.PAGE_MAX;


let classes = {};

async function fetchPage(page) {
    const url = `${url_base}${page}`;
    const cache_path = "page_cache/" + url.replaceAll(/[^a-zA-Z0-9()\[\]{}|,&=]/g, '_');
    if (fs.existsSync(cache_path)) {
        console.log("Using cached page");
        return fs.readFileSync(cache_path, 'utf8');
    }
    console.log(`Fetching URL: ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    let data = await response.text();
    // Save the page to a file
    fs.writeFileSync(cache_path, data);
    return data;
}

async function scrapeData() {
    for (let i = min_page; i <= max_page; i++) {
        let html = await fetchPage(i);
        const $ = cheerio.load(html);
        let classList = $('tr');
        let headerRow = $(classList.splice(0, 1)[0]);
        let header_items = [];
        headerRow.find('th').toArray().forEach(x => {
            header_items.push($(x).text().trim());
        });
        classList.toArray().forEach(classRow => {
            let classData = {};
            $(classRow).find('td').toArray().forEach((x, i) => {
                if (i === 4) {
                    let description_span = $(x).find('span[data-content]');
                    if (description_span.length > 0) {
                        classData["details"] = $(description_span[0]).attr('data-content').trim();
                    } else {
                        classData["details"] = "";
                    }
                }
                classData[header_items[i]] = $(x).text().trim().replaceAll(/\n {2,}/g, "\n");
            });
            if (classes[classData['CRN']]) {
                console.error("Duplicate CRN found: " + classData['CRN']);
            }
            classes[classData['CRN']] = classData;
        })
        console.log(Object.keys(classes).length);
        // Save the classes to a file
        fs.writeFileSync('classes.json', JSON.stringify(classes, null, 2));
    }
}

scrapeData();