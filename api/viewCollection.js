const express = require('express');
const { readCollection } = require('../app/CRUD/read');
const filterCollection = require('./filterCollection');
const sortCollection = require('./sortCollection');
const router = express.Router();

router.get('/*', async (req, res, next) => {
    if (!req.canRead) return res.status(401).json({ error: 'Unauthorized.' });

    if (!req.isDirectory) return next(); //move to view document

    //read the data

    let { error, code, documents, collections } = await readCollection(req.fullPath);

    //filter all documents in collection
    let { filter } = req.query || {};

    if (filter) return filterCollection(documents, filter, req, res);

    //sort docuemtns in collection
    let { sort, keys } = req.query || {};

    if (sort && keys) return sortCollection(documents, sort, keys, req, res);

    //handle errors

    if (error) return res.status(code).json({ error });

    //respond with data

    res.status(code).json({ documents, collections });
});

module.exports = router;
