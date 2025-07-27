const path = require('path');
const { updateDocument } = require('../CRUD/update');

async function updateToken(tokenID, updates) {
    if (!tokenID || typeof tokenID !== 'string') {
        return { error: 'Invalid or missing token ID', code: 400 };
    }

    if (!updates || typeof updates !== 'object') {
        return { error: 'Invalid or missing update data', code: 400 };
    }

    const tokenPath = path.join(global.DATAFOLDER, 'tokens', tokenID + '.json');

    const result = await updateDocument(tokenPath, updates, 'assign');

    if (result.error) {
        return { error: result.error, code: result.code };
    }

    return { code: 200 };
}

module.exports = { updateToken };
