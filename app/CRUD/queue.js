global.crudqueue = global.crudqueue || [];

async function waitMyTurn() {
    let resolver;
    const waitPromise = new Promise(resolve => resolver = resolve);
    global.crudqueue.push(resolver);

    // Check if it's not the first in the queue
    if (global.crudqueue[0] !== resolver) {
        await waitPromise;
    }

    return imDone.bind(null, resolver);
}

function imDone(resolver) {
    // Remove the resolver from the queue
    global.crudqueue = global.crudqueue.filter(item => item !== resolver);

    // Call the next resolver in the queue, if any
    if (global.crudqueue.length > 0) {
        const nextResolver = global.crudqueue[0];
        nextResolver();
    }
}

module.exports = {
    waitMyTurn,
    imDone // Exporting imDone is optional now, depending on your use case
};
