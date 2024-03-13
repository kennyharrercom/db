const { deleteKeyInDocument } = require('../app/CRUD/delete');

module.exports = async function (keys, req, res) {
    let { code, error } = await deleteKeyInDocument(keys, req.fullPath);
    if (error) {
        return res.status(code).json({ error });
    }
    return res.status(200).json({ message: 'sucessfully deleted keys from document.' });
};
