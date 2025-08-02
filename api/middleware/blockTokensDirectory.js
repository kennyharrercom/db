const path = require('path');

module.exports = (req, res, next) => {
    const tokensDir = path.join(DATAFOLDER, 'tokens') + path.sep;

    if (req.fullPath && req.fullPath.startsWith(tokensDir)) {
        return res.status(403).json({ error: 'Access to tokens directory is forbidden.' });
    }
};
