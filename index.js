global.__basedir = __dirname;
const path = require('path');
global.DATAFOLDER = path.join(global.__basedir, 'data');

global.CRUDPATH = '/api/collections/';

const express = require('express');
const app = express();
const apirouter = require('./api/');
app.use(express.json());

app.use(CRUDPATH + '*', apirouter);

app.get('/', (req, res) => {
    res.status(200).send('yipee');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
