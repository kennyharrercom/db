const { readDocument } = require('../app/CRUD/read');

function parseFilters(filter) {
    // Split the filter string into parts, taking care not to split on escaped commas
    const parts = filter.split(/(?<!\\),/).map((part) => part.replace(/\\,/g, ','));

    return parts.map((part) => {
        // Split each part into path and value at the first unescaped equals sign
        const [rawPath, rawValue] = part.split(/(?<!\\)=/).map((p) => p.replace(/\\=/g, '='));

        // Handle escaped dots in the path and replace \\ with \
        const path = rawPath
            .split(/(?<!\\)\./)
            .map((p) => p.replace(/(?<!\\)\\\./g, '.').replace(/\\\\/g, '\\'));

        // Prepare the result object
        const result = { path, rawPath };

        // If there's a value, add it to the result object
        if (rawValue !== undefined) {
            // Replace \\ with \ in the value
            result.value = rawValue;
        }

        return result;
    });
}
//this is really memory intensive and slow
function recursivelySearchObj(obj, pathArr) {
    let value = obj[pathArr[0]];
    pathArr.shift();
    if (value == undefined) return undefined;
    if (pathArr.length == 0) return value;
    recursivelySearchObj(value, pathArr);
}

module.exports = async (documents, filter, req, res) => {
    const { caseinsensitive } = req.query || {};

    let filteredDocuments = {};

    let filters = parseFilters(filter);

    for (let documentName of documents) {
        let { error, code, data } = await readDocument(req.fullPath + documentName + '.json');

        //handle errors
        if (error) return res.status(code).json({ error });

        for (let filter of filters) {
            let value = recursivelySearchObj(data, [...filter.path]); //clone arr

            if (value == undefined) continue;

            if (filter.value != undefined) {
                if (
                    caseinsensitive &&
                    typeof filter.value == 'string' &&
                    typeof value == 'string'
                ) {
                    if (filter.value.toLowerCase() != value.toLowerCase()) continue;
                } else if (filter.value != value) {
                    continue;
                }
            }

            filteredDocuments[documentName] = filteredDocuments[documentName] || {};
            filteredDocuments[documentName][filter.rawPath] = value;
        }
    }

    res.status(200).json(filteredDocuments);
};
