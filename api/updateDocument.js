const express = require('express');
const router = express.Router();
const { updateDocument, isAlphanumeric } = require('../app/util');

router.put('/*', async (req, res, next) => {
    //like setDocument but instead it merges with old data in the document
    if (!req.canWrite) return res.status(401).json({ error: 'Unauthorized.' });
    if (req.isDirectory) return next(); //move to view update collection

    if (!isAlphanumeric(req.documentId))
        return res.status(400).json({ error: 'document id must be alphanumeric' });

    const { error, code } = await updateDocument(req.fullPath, req.body || {});

    if (error) return res.send(code).json({ error });

    res.status(200).json({ message: 'successfully updated document' });
});

module.exports = router;
