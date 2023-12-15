const express = require('express');
const { readCollection } = require('../app/CRUD/read');
const router = express.Router();

router.get('/*', async (req, res, next) => {
    if (!req.canRead) return res.status(401).json({ error: 'Unauthorized.' });
    if (!req.isDirectory) return next(); //move to view document

    //read the data

    let { error, code, documents, collections } = await readCollection(req.fullPath);

    //handle errors

    if (error) return res.status(code).json({ error });

    //respond with data

    res.status(code).json({ documents, collections });
});

module.exports = router;
