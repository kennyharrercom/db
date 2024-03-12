require('dotenv').config();
const express = require('express');
const fs = require('fs'); 
const https = require('https'); 
const path = require('path');

// global variables
global.__basedir = __dirname;
global.DATAFOLDER = path.join(global.__basedir, 'data');
global.CRUDPATH = '/api/collections/';

const app = express();
const apirouter = require('./api/');

app.use(express.json());
app.use(global.CRUDPATH + '*', apirouter);

app.get('/', (req, res) => {
    res.status(200).send('yipee');
});

const PORT = process.env.PORT || 3000;

if (process.env.HTTPS === 'true') {
    const sslOptions = {
        cert: fs.readFileSync(process.env.SSL_CERT_PATH),
        key: fs.readFileSync(process.env.SSL_KEY_PATH),
    };

    https.createServer(sslOptions, app).listen(PORT, () => {
        console.log(`Server is running on https://localhost:${PORT}`);
    });
} else {
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
}
