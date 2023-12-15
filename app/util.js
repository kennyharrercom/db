const { stat, readFile, writeFile, readdir, unlink, mkdir, rm } = require('fs/promises');
const path = require('path');
const _ = require('lodash');

function isAlphanumeric(str) {
    const regex = /^[a-zA-Z0-9]+$/;
    return regex.test(str);
}

function isPathClean(str) {
    const regex = /^[a-zA-Z0-9\/]+$/;
    return regex.test(str);
}

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

async function createCollection(collectionPath) {
    try {
        await mkdir(collectionPath);
    } catch (error) {
        return { error: 'failed to create collect', code: 500 };
    }

    return { code: 200 };
}

async function readCollection(collectionPath) {
    let doesFileExist = await checkIfFileExists(collectionPath);

    if (!doesFileExist) {
        return { error: 'The requested collection does not exist', code: 404 };
    }

    try {
        let documents = [];
        let collections = [];

        const files = await readdir(collectionPath, { withFileTypes: true });

        for (let file of files) {
            if (file.isDirectory()) {
                collections.push(file.name);
            } else if (path.extname(file.name).toLowerCase() === '.json') {
                documents.push(file.name.replace('.json', ''));
            }
        }

        return { documents, collections, code: 200 };
    } catch (error) {
        console.log(error);
        return { error: 'Error reading collection', code: 500 };
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

async function writeDocument(documentPath, data) {
    if (typeof data != 'object') {
        return { error: 'The requested write data is not an object.', code: 400 };
    }

    let doesFileExist = await checkIfFileExists(documentPath);

    if (!doesFileExist) {
        return { error: 'The requested document does not exist', code: 404 };
    }

    let stringifiedData;

    try {
        stringifiedData = JSON.stringify(data);
    } catch (error) {
        console.log(error);
        return { error: 'Erorr stringifying data', code: 500 };
    }

    try {
        await writeFile(documentPath, stringifiedData, { encoding: 'utf-8' });
    } catch (error) {
        console.log(error);
        return { error: 'Error writing data', code: 500 };
    }

    return { code: 200 };
}

async function readDocument(documentPath, targetKeys) {
    console.log(documentPath);
    let doesFileExist = await checkIfFileExists(documentPath);

    if (!doesFileExist) {
        return { error: 'The requested document does not exist', code: 404 };
    }

    let data;

    try {
        data = await readFile(documentPath, { encoding: 'utf-8' });
    } catch (error) {
        console.log(error);
        return { error: 'An internal error has occured.', code: 500 };
    }

    try {
        data = JSON.parse(data);
    } catch (error) {
        console.log(error);
        return {
            error: 'An internal error has occured while trying to parse this document.',
            code: 500,
        };
    }

    if (!targetKeys) {
        return { data, code: 200 };
    }

    let targetedData = {};

    if (typeof targetKeys == 'string') {
        targetKeys = [targetKeys];
    }

    if (!Array.isArray(targetKeys)) {
        return { error: 'invalid targetKeys', code: 400 };
    }

    for (let targetKey of targetKeys) {
        targetedData[targetKey] = data[targetKey];
    }

    return { data: targetedData, code: 200 };
}

async function checkIfFileExists(filePath) {
    try {
        await stat(filePath);
        return true; // The file exists
    } catch (error) {
        if (error.code === 'ENOENT') {
            return false; // The file does not exist
        }
        throw error; // An error other than 'file not found' occurred
    }
}

module.exports = {
    checkIfFileExists,
    readDocument,
    updateDocument,
    writeDocument,
    deleteDocument,
    readCollection,
    deleteCollection,
    createCollection,
    isPathClean,
    isAlphanumeric,
};
