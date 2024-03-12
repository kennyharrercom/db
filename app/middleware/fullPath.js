const { URL } = require('url');
const path = require('path');

module.exports = (req, res, next) => {
    const parsedUrl = new URL(req.originalUrl, 'http://' + req.headers.host);
    const requestPath = parsedUrl.pathname;

    req.relativePath = '/' + requestPath.replace(CRUDPATH, ''); //TODO: make this better, this is trash

    req.isDirectory = req.relativePath[req.relativePath.length - 1] == '/';

    req.documentId = req.relativePath.split('/').pop();

    req.basePath = path.join(DATAFOLDER, req.tokenBaseDirectory);

    req.fullPath = path.join(req.basePath, req.relativePath + (req.isDirectory ? '' : '.json'));

    if (!req.fullPath.startsWith(req.basePath)) {
        //sanity check
        return res.status(403).send('Attempt to access resources outside the permitted directory');
    }

    // Continue to the next middleware/route handler
    next();
};
