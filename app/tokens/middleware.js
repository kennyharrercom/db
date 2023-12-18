const { isAlphanumeric } = require('../util');
const { readDocument } = require('../CRUD/read');
const path = require('path');

module.exports = async (req, res, next) => {
    const { token } = req.query || {};

    if (!isAlphanumeric(token)) return res.status(400).json({ error: 'Invalid token format.' });
    const { data, code } = await readDocument(
        path.join(__basedir, 'data', 'tokens/', token + '.json')
    );

    if (code === 404)
        return res.status(401).json({ error: 'Invalid token. Authentication failed.' });

    req.canWrite = data.canWrite;
    req.canRead = data.canRead;
    req.canDelete = data.canDelete;

    req.tokenBaseDirectory = data.baseDirectory;

    // Continue to the next middleware/route handler
    next();
};
