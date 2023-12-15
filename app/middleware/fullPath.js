const { URL } = require('url');
const path = require('path');

module.exports = (req, res, next) => {
    const parsedUrl = new URL(req.originalUrl, 'http://' + req.headers.host + '/');
    const requestPath = parsedUrl.pathname;

    req.relativePath = requestPath;

    const isDirectory = req.relativePath[req.relativePath.length - 1] == '/';
    req.isDirectory = isDirectory;

    const documentId = req.relativePath.split('/').pop();
    req.documentId = documentId;

    req.fullPath = path.join(
        req.baseDirectory, //in token.js, adjusts to PROJECTROOT/data/TOKENBASEDIR
        req.relativePath + (isDirectory ? '' : '.json')
    );

    // Continue to the next middleware/route handler
    next();
};
