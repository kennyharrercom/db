const { readDocument } = require('../app/CRUD/read');
const { getNestedValues, SplitNonEscapedPeriods } = require('../app/util');

//this is really memory intensive and slow
function recursivelySearchObj(obj, pathArr) {
    let value = obj[pathArr[0]];
    pathArr.shift();
    if (value == undefined) return undefined;
    if (pathArr.length == 0) return value;
    recursivelySearchObj(value, pathArr);
}

module.exports = async (documents, sort, keys, req, res) => {
    if (!keys) return res.status(400).json({ error: 'missing keys query' });

    const { limit = 10 } = req.query || {};

    let documentsToSort = [];

    let sortByValue = SplitNonEscapedPeriods(sort);

    for (let documentName of documents) {
        const documentPath = req.fullPath + documentName + '.json';
        let { error, code, data } = await readDocument(documentPath);

        //handle errors
        if (error) return res.status(code).json({ error });

        let value = recursivelySearchObj(data, [...sortByValue]); //clone arr

        if (value == undefined) continue;

        let document = getNestedValues(data, keys.split(','));

        documentsToSort.push({ value, document });
    }

    documentsToSort = documentsToSort.sort((a, b) => b.value - a.value).slice(0, limit);

    let sortedDocuments = [];

    for (let { document } of documentsToSort) {
        sortedDocuments.push(document);
    }

    res.status(200).json(sortedDocuments);
};
