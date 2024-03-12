const express = require('express');
const router = express.Router();
const { readDocument } = require('../app/CRUD/read');

router.get('/*', async (req, res, next) => {
    if (!req.canRead) return res.status(401).json({ error: 'Unauthorized.' });

    if (req.isDirectory) return next(); //move to view collection

    let { keys } = req.query || {};
    if (keys && keys.includes(',')) keys = keys.split(',');

    //read the data
    let { error, code, data } = await readDocument(req.fullPath, keys);

    //handle errors
    if (error) return res.status(code).json({ error });

    //respond with data

    res.status(code).json(data);
});

module.exports = router;
