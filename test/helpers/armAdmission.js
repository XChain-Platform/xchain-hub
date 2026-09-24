'use strict';

// Load a set of modules under an admission activation without leaking either the
// require-cache entries or the environment override into the rest of the test run.
// moduleIds are require.resolve() results from the caller so relative paths keep the
// caller's resolution context. Loaded exports remain usable after their cache entries
// are restored because they retain the dependencies they closed over at load time.
function armAdmission(height, moduleIds, load) {
    const paths = [...new Set(moduleIds)];
    const saved = paths.map(path => [path, require.cache[path]]);
    const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;

    try {
        for (const path of paths) delete require.cache[path];
        process.env.XC_MIRROR_ADMISSION_ACTIVATION = String(height);
        return load();
    } finally {
        for (const [path, mod] of saved) {
            if (mod === undefined) delete require.cache[path];
            else require.cache[path] = mod;
        }
        if (savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
    }
}

module.exports = armAdmission;
