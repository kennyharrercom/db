/*

this middleware checks if all collections & documents exists in requested paths.

*/

const path = require('path');
const { checkIfFileExists } = require('../../app/util');

async function recursivelyCheckPath(relativePath, basePath) {
    let dirs = relativePath.split(path.sep);
    dirs.shift();

    for (let i = 0; i < dirs.length; i++) {
        if (dirs[i].length == 0) continue;
        let isDir = dirs[i + 1] != undefined;

        let collections = dirs.slice(0, i + 1); // i=0 [0], i=1 [0,1], i=3 [0,1,2]

        let lastFile = collections.pop() + (isDir ? '/' : '.json'); //ensure either dir (collection), or json file (document)

        if (!isDir) continue;

        let testLocation = path.join(basePath, ...collections, lastFile); //datafolder defined in index, spread collections, and add the final file

        let doesExist = await checkIfFileExists(testLocation); //fs.promises.stat with try catch wrapper

        if (!doesExist || isDir !== doesExist.isDirectory()) {
            return {
                error:
                    (isDir ? 'collection' : 'document') +
                    ' ' +
                    dirs.slice(i, i + 1) + //name of collection/document
                    ' does not exist.',
                code: 404,
            };
        }
    }
}

module.exports = async (req, res, next) => {
    let { error, code } = (await recursivelyCheckPath(req.relativePath, req.basePath)) || {};

    if (error) {
        return res.status(code).json({ error }); //stop execution, return error to user
    }

    // Continue to the next middleware/route handler
    next();
};
