const { readdir, readFile } = require('fs/promises');
const path = require('path');
const { checkIfFileExists } = require('../util');
const { waitMyTurn } = require('./queue');

async function readCollection(collectionPath) {
    let resolveQueue = await waitMyTurn()
    let doesFileExist = await checkIfFileExists(collectionPath);

    if (!doesFileExist) {
        resolveQueue()
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
        resolveQueue()
        return { documents, collections, code: 200 };
    } catch (error) {
        console.log(error);
        resolveQueue()
        return { error: 'Error reading collection', code: 500 };
    }
}

async function readDocument(documentPath, targetKeys) {
    let resolveQueue = await waitMyTurn()
    let doesFileExist = await checkIfFileExists(documentPath);

    if (!doesFileExist) {
        resolveQueue()
        return { error: 'The requested document does not exist', code: 404 };
    }

    let data;

    try {
        data = await readFile(documentPath, { encoding: 'utf-8' });
    } catch (error) {
        resolveQueue()
        console.log(error, 'docpath: ' + documentPath);
        return { error: 'An internal error has occured.', code: 500 };
    }

    try {
        data = JSON.parse(data);
    } catch (error) {
        resolveQueue()
        console.log(error, 'docpath: ' + documentPath, 'data: ' + data);
        return {
            error: 'An internal error has occured while trying to parse this document.',
            code: 500,
        };
    }

    if (!targetKeys) {
        resolveQueue()
        return { data, code: 200 };
    }

    let targetedData = {};

    if (typeof targetKeys == 'string') {
        targetKeys = [targetKeys];
    }

    if (!Array.isArray(targetKeys)) {
        resolveQueue()
        return { error: 'invalid targetKeys', code: 400 };
    }

    for (let targetKey of targetKeys) {
        targetedData[targetKey] = data[targetKey];
    }

    resolveQueue()
    return { data: targetedData, code: 200 };
}

module.exports = { readCollection, readDocument };
