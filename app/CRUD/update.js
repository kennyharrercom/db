const _ = require('lodash')
const { readDocument } = require('./read')
const { writeDocument } = require('./write')

async function updateDocument(documentPath, data) {
    let { error: readError, code: readCode, data: oldData } = await readDocument(documentPath);
    if (readError) return { error: readError, code: readCode };
    let newData;
    try {
        newData = _.merge(oldData, data);
    } catch (error) {
        console.log(error);
        return { error: 'Failed to merge data', code: 500 };
    }
    let writeResults = await writeDocument(documentPath, newData);
    if (writeResults.error) return { error: writeResults.error, code: writeResults.code };
    return { code: 200 };
}

module.exports = {updateDocument}