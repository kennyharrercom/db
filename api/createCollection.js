const express = require('express');
const router = express.Router();
const { isPathClean, createCollection } = require('../app/util');

router.post('/*', async (req, res, next) => {
    if (!req.canWrite) return res.status(401).json({ error: 'Unauthorized.' });
    if (!req.isDirectory) return next(); //move to view set document

    if (!isPathClean(req.relativePath))
        return res.status(400).json({ error: 'path not clean' });

    const { code, error } = await createCollection(req.fullPath);

    if (error) return res.status(code).json({ error });

    res.status(200).json({ message: 'successfully created collection' });
});

module.exports = router;
