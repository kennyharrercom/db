global.__basedir = __dirname;

const express = require('express');
const app = express();
const myRouter = require('./api/');
app.use(express.json());
app.use('/*', myRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
