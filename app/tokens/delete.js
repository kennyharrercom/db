const path = require('path');
const { deleteDocument } = require('../CRUD/delete');

async function deleteToken(tokenID) {
    if (!tokenID || typeof tokenID !== 'string') {
        return { error: 'Invalid or missing token ID', code: 400 };
    }

    const tokenPath = path.join(global.DATAFOLDER, 'tokens', tokenID + '.json');
    return await deleteDocument(tokenPath);
}

module.exports = { deleteToken };
