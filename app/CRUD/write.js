const { checkIfFileExists } = require('../util');
const { writeFile } = require('fs/promises');
const { waitMyTurn } = require('./queue');

async function writeDocument(documentPath, data) {
    let resolveQueue = await waitMyTurn();
    if (typeof data != 'object') {
        resolveQueue();
        return { error: 'The requested write data is not an object.', code: 400 };
    }

    let stringifiedData;

    try {
        stringifiedData = JSON.stringify(data);
    } catch (error) {
        console.log(error);
        resolveQueue();
        return { error: 'Erorr stringifying data', code: 500 };
    }

    try {
        await writeFile(documentPath, stringifiedData, { encoding: 'utf-8' });
    } catch (error) {
        console.log(error);
        resolveQueue();
        return { error: 'Error writing data', code: 500 };
    }

    resolveQueue();
    return { code: 200 };
}

module.exports = { writeDocument };
