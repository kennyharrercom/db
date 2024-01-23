const _ = require('lodash');
const { readDocument } = require('./read');
const { writeDocument } = require('./write');

//no need for queue as the read and write ops already have a queue
async function updateDocument(documentPath, data) {
    let { error: readError, code: readCode, data: oldData } = await readDocument(documentPath);
    if (readError) {
        if (readCode == 404) {
            oldData = {};
        } else {
            return { error: readError, code: readCode };
        }
    }

    let newData;
    try {
        newData = _.assign(oldData, data);
    } catch (error) {
        return { error: 'Failed to merge data', code: 500 };
    }
    let writeResults = await writeDocument(documentPath, newData);

    if (writeResults.error) return { error: writeResults.error, code: writeResults.code };

    return { code: 200 };
}

module.exports = { updateDocument };
