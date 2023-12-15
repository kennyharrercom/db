const deleteDocument = require('./deleteDocument');
const viewDocument = require('./viewDocument');
const viewCollection = require('./viewCollection');
const setDocument = require('./setDocument');
const updateDocument = require('./updateDocument');
const fullPath = require('../app/middleware/fullPath');
const tokenAuthorization = require('../app/middleware/token');

const express = require('express');
const router = express.Router();

router.use(tokenAuthorization);
router.use(fullPath);

router.use('/', deleteDocument);
router.use('/', viewCollection);
router.use('/', viewDocument);
router.use('/', updateDocument);
router.use('/', setDocument);

module.exports = router;
