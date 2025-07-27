const path = require('path');
const { checkIfFileExists, generateAlphanumericToken, isPathClean } = require('../util');
const { writeDocument } = require('../CRUD/write');

async function createToken(tokenInfo = {}) {
    if (typeof tokenInfo !== 'object') {
        return { error: 'non-object passed token info', code: 400 };
    }

    if (!tokenInfo.baseDirectory) {
        return { error: 'no .baseDirectory passed to createToken', code: 400 };
    }

    if (!isPathClean(tokenInfo.baseDirectory)) {
        return { error: 'invalid path passed to .baseDirectory', code: 400 };
    }

    const tokenLength = parseInt(process.env.TOKEN_LENGTH, 10);
    if (!tokenLength || isNaN(tokenLength) || tokenLength < 32) {
        return { error: 'Invalid or insecure TOKEN_LENGTH', code: 500 };
    }

    const tokenID = generateAlphanumericToken(tokenLength);
    const tokenPath = path.join(global.DATAFOLDER, 'tokens', tokenID + '.json');

    if (await checkIfFileExists(tokenPath)) {
        return { error: 'Token ID collision, retry', code: 500 };
    }

    const tokenObject = {
        canRead: tokenInfo.canRead ?? false,
        canWrite: tokenInfo.canWrite ?? false,
        canDelete: tokenInfo.canDelete ?? false,
        modifyTokens: tokenInfo.modifyTokens ?? false,
        baseDirectory: tokenInfo.baseDirectory,
        label: tokenInfo.label ?? 'unnamed token',
    };

    const writeResult = await writeDocument(tokenPath, tokenObject);
    if (writeResult.error) {
        return { error: writeResult.error, code: writeResult.code };
    }

    return { tokenID, code: 200 };
}

module.exports = { createToken };
