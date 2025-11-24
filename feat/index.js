import XXH from "xxhashjs";

const SEED = 0xabcd1234; // fixed seed for stability
const VIRTUAL_SHARDS = 65_536n; // total logical shards (~0.0015% each)

/**
 * Compute a virtual-shard ID (0–65,535) for a given key.
 */
export function getVirtualShardId(key) {
  const h64 = BigInt("0x" + XXH.h64(key, SEED).toString(16));
  return Number(h64 % VIRTUAL_SHARDS); // safe: <= 65,535
}

/**
 * Generate a shard manifest for a cluster.
 * @param {Object} nodes - Map of nodeName -> { url, weight }
 * @param {Object} [opts]
 * @param {number} [opts.version=1] - manifest version
 * @returns {Object} manifest
 */
export function generateShardManifest(nodes, opts = {}) {
  const version = opts.version ?? 1;
  const algo = "hash64";
  const virtualShards = Number(VIRTUAL_SHARDS);

  // total node weight
  const totalWeight = Object.values(nodes).reduce(
    (sum, n) => sum + (n.weight ?? 1),
    0
  );

  const assignments = {};
  let cursor = 0;

  for (const [name, node] of Object.entries(nodes)) {
    const share = (node.weight ?? 1) / totalWeight;
    const count = Math.round(virtualShards * share);
    const start = cursor;
    const end = Math.min(cursor + count - 1, virtualShards - 1);
    assignments[`${start}-${end}`] = name;
    cursor = end + 1;
  }

  // fill rounding remainder
  const lastNode = Object.keys(nodes).at(-1);
  if (cursor < virtualShards) {
    const lastRange = Object.keys(assignments).at(-1);
    delete assignments[lastRange];
    assignments[`${lastRange.split("-")[0]}-${virtualShards - 1}`] = lastNode;
  }

  return {
    version,
    algo,
    virtual_shards: virtualShards,
    assignments,
    nodes,
  };
}

/**
 * Look up the physical node for a given key using the manifest.
 * @param {string} key
 * @param {Object} manifest
 * @returns {Object} { nodeName, nodeInfo, vsid }
 */
export function resolveNodeForKey(key, manifest) {
  const vsid = getVirtualShardId(key);

  // Find which range owns this vsid
  for (const [range, name] of Object.entries(manifest.assignments)) {
    const [start, end] = range.split("-").map(Number);
    if (vsid >= start && vsid <= end) {
      return {
        name,
        node: manifest.nodes[name],
        vsid,
      };
    }
  }
  throw new Error(`vsid ${vsid} not assigned to any node`);
}

// Example usage --------------------------------------------------------------

const nodes = {
  "node-a": { url: "http://10.0.0.1:3000", weight: 1 },
  "node-b": { url: "http://10.0.0.2:3000", weight: 1 },
  "node-c": { url: "http://10.0.0.3:3000", weight: 1 },
  "node-d": { url: "http://10.0.0.4:3000", weight: 1 },
};

const manifest = generateShardManifest(nodes);

const key = "ORD-79c27ef0-f6ac-4eb1-97b5-93952f15d5e8";
const result = resolveNodeForKey(key, manifest);

console.log(JSON.stringify(result, null, 2));
