const { stat } = require('fs/promises');

function isAlphanumeric(str) {
    const regex = /^[a-zA-Z0-9]+$/;
    return regex.test(str);
}

function isPathClean(str) {
    const regex = /^[a-zA-Z0-9\/]+$/;
    return regex.test(str);
}

async function checkIfFileExists(filePath) {
    try {
        return await stat(filePath); // The file exists
    } catch (error) {
        if (error.code === 'ENOENT') {
            return false; // The file does not exist
        }
        throw error; // An error other than 'file not found' occurred
    }
}

module.exports = {
    checkIfFileExists,
    isPathClean,
    isAlphanumeric,
};
