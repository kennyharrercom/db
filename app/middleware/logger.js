module.exports = (req, res, next) => {
    console.log(req.method, req.fullPath);
    next();
};
