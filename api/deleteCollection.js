const express = require('express');
const router = express.Router();
const { isPathClean, deleteCollection } = require('../app/util');

router.delete('/*', async (req, res, next) => {
    if (!req.canDelete) return res.status(401).json({ error: 'Unauthorized.' });
    if (!req.isDirectory) return next() //move to delete document
    if (!isPathClean(req.relativePath)) return res.status(400).json({ error: 'path not clean' });
    const { error, code } = await deleteCollection(req.fullPath)

    if (error) return res.status(code).json({ error })
    
    res.status(200).json({message:'collection deleted successfully '})

});

module.exports = router;
