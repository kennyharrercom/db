const crypto = require('crypto');

function generateAlphanumericToken(length = 128) {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = crypto.randomBytes(length);
    return Array.from(bytes, (byte) => charset[byte % charset.length]).join('');
}

function isAlphanumeric(str) {
    const regex = /^[a-zA-Z0-9]+$/;
    return regex.test(str);
}

function isPathClean(str) {
    const regex = /^[a-zA-Z0-9\/]+$/;
    return regex.test(str);
}

const { stat } = require('fs/promises');

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

function SplitNonEscapedPeriods(input) {
    let parts = [];
    let currentPart = '';
    let escapeNext = false;

    for (let i = 0; i < input.length; i++) {
        const char = input[i];

        if (escapeNext) {
            currentPart += char;
            escapeNext = false;
        } else if (char === '\\') {
            escapeNext = true;
        } else if (char === '.' && !escapeNext) {
            parts.push(currentPart);
            currentPart = '';
        } else {
            currentPart += char;
        }
    }

    parts.push(currentPart);

    return parts;
}

function getNestedValue(object, keyPath) {
    if (typeof keyPath == 'string') keyPath = SplitNonEscapedPeriods(keyPath);
    if (!Array.isArray(keyPath)) return; //something is very wrong.
    let value = object[keyPath[0]];
    keyPath.shift();
    if (value == undefined) return undefined;
    if (keyPath.length == 0) {
        return value;
    }
    return getNestedValue(value, keyPath);
}

function insertNestedResult(object, keyPath, value) {
    if (typeof keyPath == 'string') keyPath = SplitNonEscapedPeriods(keyPath);
    if (!Array.isArray(keyPath)) return; //something is very wrong.
    let current = object;
    for (const [index, key] of Object.entries(keyPath)) {
        if (index == keyPath.length - 1) {
            current[key] = value;
        } else {
            if (!current[key] || typeof current[key] !== 'object') {
                current[key] = {};
            }
            current = current[key];
        }
    }
    return object;
}

function getNestedValues(object, keyPaths) {
    const nestedValues = {};

    for (let keyPath of keyPaths) {
        insertNestedResult(nestedValues, keyPath, getNestedValue(object, keyPath));
    }

    return nestedValues;
}

module.exports = {
    checkIfFileExists,
    isPathClean,
    isAlphanumeric,
    getNestedValues,
    getNestedValue,
    SplitNonEscapedPeriods,
    generateAlphanumericToken,
};
