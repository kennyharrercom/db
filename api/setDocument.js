const express = require('express');
const router = express.Router();
const { isAlphanumeric, writeDocument } = require('../app/util');

router.post('/*', async (req, res, next) => {
    if (!req.canWrite) return res.status(401).json({ error: 'Unauthorized.' });
    if (req.isDirectory) return next(); //move to view create collection

    if (!isAlphanumeric(req.documentId))
        return res.status(400).json({ error: 'document id must be alphanumeric' });

    const { error, code } = await writeDocument(req.fullPath, req.body || {});

    if (error) return res.status(code).json({ error })
    
    res.status(200).json({message:'document successfully set'})
});

module.exports = router;
