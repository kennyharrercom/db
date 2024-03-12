const _ = require('lodash');
const { readDocument } = require('./read');
const { writeDocument } = require('./write');
const { waitMyTurn } = require('./queue');

async function updateDocument(documentPath, data, updateType) {
    let resolveQueue = await waitMyTurn();
    let {
        error: readError,
        code: readCode,
        data: oldData,
    } = await readDocument(documentPath, undefined, false);
    if (readError) {
        if (readCode == 404) {
            oldData = {};
        } else {
            resolveQueue();
            return { error: readError, code: readCode };
        }
    }

    let newData;
    try {
        switch (updateType) {
            case 'merge':
                newData = _.merge(oldData, data);
                break
            default:
                newData = _.assign(oldData, data);
                break
        }       
    } catch (error) {
        resolveQueue();
        return { error: 'Failed to merge data', code: 500 };
    }
    let writeResults = await writeDocument(documentPath, newData, false);

    if (writeResults.error) {
        resolveQueue();
        return { error: writeResults.error, code: writeResults.code };
    }

    resolveQueue();
    return { code: 200 };
}

module.exports = { updateDocument };
