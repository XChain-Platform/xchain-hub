'use strict';

const { validateLimit, validateSince } = require('../validate');

// Validate the two paging fields once for every snapshot table, including an
// explicitly empty value. Individual handlers retain their local guards so a
// directly mounted route remains fail-closed in focused tests and reuse.
function mountSnapshotQueryValidation(app) {
    app.use('/hub-db/snapshot', (req, res, next) => {
        if (Object.prototype.hasOwnProperty.call(req.query, 'limit')) {
            const error = validateLimit(req.query.limit);
            if (error) return res.status(400).json(error);
        }
        if (Object.prototype.hasOwnProperty.call(req.query, 'since_id')) {
            if (req.query.since_id === '')
                return res.status(400).json({ error: 'since_id must be a non-negative safe integer' });
            const error = validateSince(req.query.since_id);
            if (error) return res.status(400).json(error);
        }
        next();
    });
}

module.exports = { mountSnapshotQueryValidation };
