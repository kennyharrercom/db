const { mkdir } = require('fs/promises');

const { waitMyTurn } = require('./queue');

async function createCollection(collectionPath) {
    let resolveQueue = await waitMyTurn();
    //TODO: this needs to be a lot better
    try {
        await mkdir(collectionPath);
    } catch (error) {
        resolveQueue();
        return { error: 'failed to create collect', code: 500 };
    }

    resolveQueue();
    return { code: 200 };
}

module.exports = { createCollection };
