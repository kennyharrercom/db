const { mkdir } = require('fs/promises');

async function createCollection(collectionPath) {
    //TODO: this needs to be a lot better
    try {
        await mkdir(collectionPath);
    } catch (error) {
        return { error: 'failed to create collect', code: 500 };
    }

    return { code: 200 };
}

module.exports = {createCollection}