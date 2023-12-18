# db
simpe nosql json database 


TODO:

- allow caching of certain properties per document in a collect for querying. ex. PUT /COLLECTIONNAME {cacheProperties: {name,cost}} then if we add a query function we can use this cache to very efficiently query the collection. data should be cached in file (.cache.json) per collection
- something needs to be wrote to verify a document path before action is taken. loop through each directory (relative to data base folder) until we either find all the files required, or we find something missing, and if something is missing error out.
- sharding  