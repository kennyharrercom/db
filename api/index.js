const deleteDocument = require('./deleteDocument');
const viewDocument = require('./viewDocument');
const viewCollection = require('./viewCollection');
const setDocument = require('./setDocument');
const updateDocument = require('./updateDocument');
const fullPath = require('../app/middleware/fullPath');
const tokenAuthorization = require('../app/tokens/middleware');
const checkPath = require('./middleware/checkPath');
const logger = require('../app/middleware/logger');
const blockTokens = require('./middleware/blockTokens');

const express = require('express');

const router = express.Router();

router.use(tokenAuthorization); //check if user has authorization, get user's base collection
router.use(fullPath); //get request path out of url
router.use(logger);
router.use(blockTokens);
router.use(checkPath); //check if request path exists

router.use('/', deleteDocument);
router.use('/', viewCollection);
router.use('/', viewDocument);
router.use('/', updateDocument);
router.use('/', setDocument);

module.exports = router;
