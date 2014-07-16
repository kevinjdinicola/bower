var util = require('util');
var path = require('path');
var Q = require('q');
var chmodr = require('chmodr');
var rimraf = require('rimraf');
var mkdirp = require('mkdirp');
var which = require('which');
var LRU = require('lru-cache');
var mout = require('mout');
var Resolver = require('./Resolver');
var semver = require('../../util/semver');
var createError = require('../../util/createError');
var defaultConfig = require('../../config');

var hasHg;

// Check if hg is installed
try {
    which.sync('hg');
    hasHg = true;
} catch (ex) {
    hasHg = false;
}

// Set template dir to the empty directory so that user templates are not run
// This environment variable is not multiple config aware but it's not documented
// anyway
mkdirp.sync(defaultConfig.storage.empty);
process.env.HG_TEMPLATE_DIR = defaultConfig.storage.empty;

function HgResolver(decEndpoint, config, logger) {
    Resolver.call(this, decEndpoint, config, logger);

    if (!hasHg) {
        throw createError('hg is not installed or not in the PATH', 'ENOGIT');
    }
}

util.inherits(HgResolver, Resolver);
mout.object.mixIn(HgResolver, Resolver);

// -----------------

HgResolver.prototype._hasNew = function (canonicalDir, pkgMeta) {
    var oldResolution = pkgMeta._resolution || {};

    // Create temporary dir, always need one before a cloning will happen
    return this._tryClone()
    .then(function() {
        // Dont pass the arguments from clone into find resolution
        return this._findResolution();
    }.bind(this))
    .then(function (resolution) {
        // Check if resolution types are different
        if (oldResolution.type !== resolution.type) {
            return true;
        }

        // If resolved to a version, there is new content if the tags are not equal
        if (resolution.type === 'version' && semver.neq(resolution.tag, oldResolution.tag)) {
            return true;
        }

        // As last check, we compare both commit hashes
        return resolution.commit !== oldResolution.commit;
    });
};

HgResolver.prototype._resolve = function () {
    var that = this;
    // A new directory has been created by Resolver.resolve, and doesn't need to be created here.
    return this._tryClone()
    .then(function() {
        // Dont pass the arguments from clone into find resolution
        return this._findResolution();
    }.bind(this))
    .then(this._checkout.bind(this))
    .fin(this._cleanup.bind(this));
};


// -----------------

// Abstract functions that should be implemented by concrete hg resolvers
HgResolver.prototype._checkout = function () {
    throw new Error('_checkout not implemented');
};

HgResolver.prototype._hasClone = function() {
    throw new Error('_hasClone not implemented');
}

HgResolver.prototype._clone = function () {
    throw new Error('_clone not implemented');
};

HgResolver._branches = function (source) {
    throw new Error('_branches not implemented');
};

HgResolver._tags = function (source) {
    throw new Error('_tags not implemented');
};


// -----------------

// Try to make a clone if we don't have one already
HgResolver.prototype._tryClone = function() {
    return this._hasClone()
        .then(function(validRepo) {
            if (!validRepo) {
                // This will only create a tempDir if there isnt one already.
                // In this case, it will only create one for this Resolver
                // if we are going through the _hasNew path, not the _resolver path.
                return this._createTempDir()
                    .then(this._clone.bind(this));
            }
        }.bind(this));
}


HgResolver.prototype._findResolution = function (target) {
    var err;
    var self = this.constructor;
    var that = this;

    target = target || this._target || '*';

    // Target is a commit, so it's a stale target (not a moving target)
    // There's nothing to do in this case
    if ((/^[a-f0-9]{40}$/).test(target)) {
        this._resolution = { type: 'commit', commit: target };
        return Q.resolve(this._resolution);
    }

    // Target is a range/version
    if (semver.validRange(target)) {
        return self.versions(this._tempDir, true)
        .then(function (versions) {
            var versionsArr,
                version,
                index;

            versionsArr = versions.map(function (obj) { return obj.version; });

            // If there are no tags and target is *,
            // fallback to the latest commit on master
            if (!versions.length && target === '*') {
                return that._findResolution('default');
            }

            versionsArr = versions.map(function (obj) { return obj.version; });
            // Find a satisfying version, enabling strict match so that pre-releases
            // have lower priority over normal ones when target is *
            index = semver.maxSatisfyingIndex(versionsArr, target, true);
            if (index !== -1) {
                version = versions[index];
                return that._resolution = { type: 'version', tag: version.tag, commit: version.commit };
            }

            // Check if there's an exact branch/tag with this name as last resort
            return Q.all([
                self.branches(that._tempDir),
                self.tags(that._tempDir)
            ])
            .spread(function (branches, tags) {
                // Use hasOwn because a branch/tag could have a name like "hasOwnProperty"
                if (mout.object.hasOwn(tags, target)) {
                    return that._resolution = { type: 'tag', tag: target, commit: tags[target] };
                }
                if (mout.object.hasOwn(branches, target)) {
                    return that._resolution = { type: 'branch', branch: target, commit: branches[target] };
                }

                throw createError('No tag found that was able to satisfy ' + target, 'ENORESTARGET', {
                    details: !versions.length ?
                        'No versions found in ' + that._source :
                        'Available versions: ' + versions.map(function (version) { return version.version; }).join(', ')
                });
            });
        });
    }

    // Otherwise, target is either a tag or a branch
    return Q.all([
        self.branches(that._tempDir),
        self.tags(that._tempDir)
    ])
    .spread(function (branches, tags) {
        // Use hasOwn because a branch/tag could have a name like "hasOwnProperty"
        if (mout.object.hasOwn(tags, target)) {
            return that._resolution = { type: 'tag', tag: target, commit: tags[target] };
        }
        if (mout.object.hasOwn(branches, target)) {
            return that._resolution = { type: 'branch', branch: target, commit: branches[target] };
        }

        if ((/^([0-9]+\:)?[a-f0-9]{12,40}$/).test(target)) {
            if (target.length < 12) {
                that._logger.warn(
                    'short-sha',
                    'Consider using longer commit SHA to avoid conflicts'
                );
            }

            that._resolution = { type: 'commit', commit: target };
            return that._resolution;
        }

        branches = Object.keys(branches);
        tags = Object.keys(tags);

        err = createError('Tag/branch ' + target + ' does not exist', 'ENORESTARGET');
        err.details = !tags.length ?
                'No tags found in ' + that._source :
                'Available tags: ' + tags.join(', ');
        err.details += '\n';
        err.details += !branches.length ?
                'No branches found in ' + that._source :
                'Available branches: ' + branches.join(', ');

        throw err;
    });
};

HgResolver.prototype._cleanup = function () {
    var hgFolder = path.join(this._tempDir, '.hg');

    // Remove the .hg folder
    // Note that on windows, we need to chmod to 0777 before due to a bug in git
    // See: https://github.com/isaacs/rimraf/issues/19
    if (process.platform === 'win32') {
        return Q.nfcall(chmodr, hgFolder, 0777)
        .then(function () {
            return Q.nfcall(rimraf, hgFolder);
        }, function (err) {
            // If .git does not exist, chmodr returns ENOENT
            // so, we ignore that error code
            if (err.code !== 'ENOENT') {
                throw err;
            }
        });
    } else {
        return Q.nfcall(rimraf, hgFolder);
    }
};

HgResolver.prototype._savePkgMeta = function (meta) {
    var version;

    if (this._resolution.type === 'version') {
        version = semver.clean(this._resolution.tag);

        // Warn if the package meta version is different than the resolved one
        if (typeof meta.version === 'string' && semver.neq(meta.version, version)) {
            this._logger.warn('mismatch', 'Version declared in the json (' + meta.version + ') is different than the resolved one (' + version + ')', {
                resolution: this._resolution,
                pkgMeta: meta
            });
        }

        // Ensure package meta version is the same as the resolution
        meta.version = version;
    } else {
        // If resolved to a target that is not a version,
        // remove the version from the meta
        delete meta.version;
    }

    // Save version/tag/commit in the release
    // Note that we can't store branches because _release is supposed to be
    // an unique id of this ref.
    meta._release = version ||
                    this._resolution.tag ||
                    this._resolution.commit.substr(0, 10);

    // Save resolution to be used in hasNew later
    meta._resolution = this._resolution;

    return Resolver.prototype._savePkgMeta.call(this, meta);
};

// ------------------------------

HgResolver.versions = function (repoDir, extra) {
    var value = this._cache.versions.get(repoDir);

    if (value) {
        return Q.resolve(value)
        .then(function () {
            var versions = this._cache.versions.get(repoDir);

            // If no extra information was requested,
            // resolve simply with the versions
            if (!extra) {
                versions = versions.map(function (version) {
                    return version.version;
                });
            }

            return versions;
        }.bind(this));
    }

    value = this.tags(repoDir)
    .then(function (tags) {
        var tag;
        var version;
        var versions = [];

        // For each tag
        for (tag in tags) {
            version = semver.clean(tag);
            if (version) {
                versions.push({ version: version, tag: tag, commit: tags[tag] });
            }
        }

        // Sort them by DESC order
        versions.sort(function (a, b) {
            return semver.rcompare(a.version, b.version);
        });

        this._cache.versions.set(repoDir, versions);

        // Call the function again to keep it DRY
        return this.versions(repoDir, extra);
    }.bind(this));


    // Store the promise to be reused until it resolves
    // to a specific value
    this._cache.versions.set(repoDir, value);

    return value;
};


HgResolver.tags = function (repoDir) {
    var value = this._cache.tags.get(repoDir);

    if (value) {
        return Q.resolve(value);
    }

    value = this._tags(repoDir)
    .then(function (refs) {
        var tags = {};
        // For each line in the refs, match only the tags
        refs.forEach(function (line) {
            var match = line.match(/^(\S+)\s+([0-9]+\:[a-f0-9]{12})$/);

            if (match && !mout.string.endsWith(match[2], '^{}')) {
                tags[match[1]] = match[2];
            }
        });

        this._cache.tags.set(repoDir, tags);

        return tags;
    }.bind(this));

    // Store the promise to be reused until it resolves
    // to a specific value
    this._cache.tags.set(repoDir, value);

    return value;
};


HgResolver.branches = function (repoDir) {
    var value = this._cache.branches.get(repoDir);

    if (value) {
        return Q.resolve(value);
    }

    value = this._branches(repoDir)
    .then(function (refs) {
        var branches = {};
        // For each line in the refs, extract only the heads
        // Organize them in an object where keys are branches and values
        // the commit hashes
        refs.forEach(function (line) {
            var match = line.match(/^(\S+)\s+([0-9]+\:[a-f0-9]{12})$/);

            if (match) {
                branches[match[1]] = match[2];
            }
        });

        this._cache.branches.set(repoDir, branches);

        return branches;
    }.bind(this));

    // Store the promise to be reused until it resolves
    // to a specific value
    this._cache.branches.set(repoDir, value);

    return value;
};


HgResolver.prototype._createTempDir = function () {
    if (this._tempDir) {
        // A temp directory has already been created.  I only ever want to create one temp directory for 
        // an Hg resolver, because I want to reuse the clone i make for hasNew and resolve.
        return Q.resolve(this._tempDir);
    } else {
        // We don't have a temp dir, make one like we normally do.
        return Resolver.prototype._createTempDir.call(this);
    }
};


HgResolver.clearRuntimeCache = function () {
    // Reset cache for branches, tags, etc
    mout.object.forOwn(HgResolver._cache, function (lru) {
        lru.reset();
    });
};

HgResolver._cache = {
    branches: new LRU({ max: 50, maxAge: 5 * 60 * 1000 }),
    tags: new LRU({ max: 50, maxAge: 5 * 60 * 1000 }),
    versions: new LRU({ max: 50, maxAge: 5 * 60 * 1000 }),
    refs: new LRU({ max: 50, maxAge: 5 * 60 * 1000 })
};

module.exports = HgResolver;
