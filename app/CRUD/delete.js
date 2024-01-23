const { checkIfFileExists } = require('../util');
const { unlink, rm } = require('fs/promises');
const { waitMyTurn } = require('./queue');

async function deleteCollection(collectionPath) {

    let resolveQueue = await waitMyTurn()

    let doesFileExist = await checkIfFileExists(collectionPath);

    if (!doesFileExist) {
        resolveQueue()
        return { error: 'The requested collection does not exist', code: 404 };
    }

    try {
        await rm(collectionPath, { recursive: true, force: true });
    } catch (error) {
        resolveQueue()
        return { error: 'Error deleting the folder', code: 500 };
    }

    resolveQueue()
    return { code: 200 };
}

async function deleteDocument(documentPath) {

    let resolveQueue = await waitMyTurn()
    let doesFileExist = await checkIfFileExists(documentPath);

    if (!doesFileExist) {
        resolveQueue()
        return { error: 'The requested document does not exist', code: 404 };
    }

    try {
        await unlink(documentPath);
    } catch (error) {
        resolveQueue()
        return { error: 'Error deleting the document', code: 500 };
    }

    resolveQueue()
    return { code: 200 };
}

module.exports = { deleteDocument, deleteCollection };
