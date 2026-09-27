'use strict';

function hasUsablePrice(result, coinPairs) {
    if (!result || result.status !== 'fulfilled' || !result.value) return false;
    return coinPairs.some(pair =>
        result.value[pair] !== undefined && result.value[pair] !== null
    );
}

function summarizeSourceLiveness(keys, sourceResults, coinPairs) {
    const summary = { live: [], dead: [] };
    keys.forEach((key, index) => {
        const bucket = hasUsablePrice(sourceResults[index], coinPairs) ? summary.live : summary.dead;
        bucket.push(key);
    });
    return summary;
}

module.exports = { summarizeSourceLiveness };
