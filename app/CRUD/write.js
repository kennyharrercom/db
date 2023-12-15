const { checkIfFileExists } = require('../util');
const { writeFile } = require('fs/promises');

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

module.exports = {writeDocument}
