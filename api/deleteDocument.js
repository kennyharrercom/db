const express = require('express');
const router = express.Router();
const { isPathClean, deleteDocument } = require('../app/util');

router.delete('/*', async (req, res, next) => {
    if (!req.canDelete) return res.status(401).json({ error: 'Unauthorized.' });
    if (req.isDirectory) return next(); //move to delete collection
    if (!isPathClean(req.relativePath)) return res.status(400).json({ error: 'path not clean' });

    let { error, code } = await deleteDocument(req.fullPath);

    if (error) return res.status(code).json({ error });

    res.status(200).json({ message: 'document deleted successfully' });
});

module.exports = router;
