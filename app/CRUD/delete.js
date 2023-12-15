const { checkIfFileExists } = require('../util');
const { unlink, rm } = require('fs/promises');

async function deleteCollection(collectionPath) {
    let doesFileExist = await checkIfFileExists(collectionPath);

    if (!doesFileExist) {
        return { error: 'The requested collection does not exist', code: 404 };
    }

    try {
        await rm(collectionPath, { recursive: true, force: true });
    } catch (error) {
        return { error: 'Error deleting the folder', code: 500 };
    }

    return { code: 200 };
}

async function deleteDocument(documentPath) {
    let doesFileExist = await checkIfFileExists(documentPath);

    if (!doesFileExist) {
        return { error: 'The requested document does not exist', code: 404 };
    }

    try {
        await unlink(documentPath);
    } catch (error) {
        return { error: 'Error deleting the document', code: 500 };
    }
    return { code: 200 };
}

module.exports = { deleteDocument, deleteCollection };
