var util = require('util');
var url = require('url');
var Q = require('q');
var mout = require('mout');
var LRU = require('lru-cache');
var HgResolver = require('./HgResolver');
var cmd = require('../../util/cmd');

function HgRemoteResolver(decEndpoint, config, logger) {
    if (decEndpoint.source.indexOf("hg+") == 0) {
        // Im cheating and adding hg+ so i know it's hg,
        // so chop that off.
        decEndpoint.source = decEndpoint.source.substring(3);
    }


    HgResolver.call(this, decEndpoint, config, logger);

    if (!mout.string.startsWith(this._source, 'file://')) {
        // Trim trailing slashes
        this._source = this._source.replace(/\/+$/, '');
    }

    // If the name was guessed, remove the trailing .git
    if (this._guessedName && mout.string.endsWith(this._name, '.hg')) {
        this._name = this._name.slice(0, -4);
    }

    if (this._name.indexOf(":") > -1) {
        // Does the name contain a port
        this._name = this._name.substring(0, this._name.indexOf(":"));
    }

    // Get the host of this source
    if (!/:\/\//.test(this._source)) {
        this._host = url.parse('ssh://' + this._source).host;
    } else {
        this._host = url.parse(this._source).host;
    }
}

util.inherits(HgRemoteResolver, HgResolver);
mout.object.mixIn(HgRemoteResolver, HgResolver);

// -----------------

HgRemoteResolver.prototype._clone = function() {
    var promise,
        timer,
        reporter,
        that = this,
        args;

    console.log('cloning!');
    // this._logger.action('clone', {
    //     resolution: resolution,
    //     to: this._tempDir
    // });

    args = ['clone',  this._source, '-v'];
    debugger;
    promise = cmd('hg', args, { cwd: this._tempDir });

    // Throttle the progress reporter to 1 time each sec
    reporter = mout.fn.throttle(function (data) {
        var lines;

        lines = data.split(/[\r\n]+/);
        lines.forEach(function (line) {
            if (/\d{1,3}\%/.test(line)) {
                // TODO: There are some strange chars that appear once in a while (\u001b[K)
                //       Trim also those?
                that._logger.info('progress', line.trim());
            }
        });
    }, 1000);

    // Start reporting progress after a few seconds
    timer = setTimeout(function () {
        promise.progress(reporter);
    }, 8000);

    return promise
    // Clear timer at the end
    .fin(function () {
        debugger;
        clearTimeout(timer);
        reporter.cancel();
    }.bind(this));
}

HgRemoteResolver.prototype._checkout = function () {
    debugger;
    var promise;
    var timer;
    var reporter;
    var that = this;
    var resolution = this._resolution;

    this._logger.action('checkout', resolution.tag || resolution.branch || resolution.commit, {
        resolution: resolution,
        to: this._tempDir
    });

    var branch = resolution.tag || resolution.branch || resolution.commit;

    promise = cmd('hg', ['checkout', branch ], { cwd: this._tempDir })

    return promise;
};

// ------------------------------

HgRemoteResolver.prototype._slowClone = function (resolution) {
    return cmd('hg', ['clone', this._source, this._tempDir, '-v'])
    .then(cmd.bind(cmd, 'hg', ['checkout', resolution.commit], { cwd: this._tempDir }));
};


HgRemoteResolver.prototype._fastClone = function (resolution) {
    var branch,
        args,
        that = this;

    branch = resolution.tag || resolution.branch;
    args = ['clone',  this._source, '-r', branch, '-v', '.'];

    // If the host does not support shallow clones, we don't use --depth=1
    if (!HgRemoteResolver._noShallow.get(this._host)) {
        args.push('--depth', 1);
    }

    return cmd('hg', args, { cwd: this._tempDir })
    .spread(function (stdout, stderr) {
        // Only after 1.7.10 --branch accepts tags
        // Detect those cases and inform the user to update git otherwise it's
        // a lot slower than newer versions
        if (!/branch .+? not found/i.test(stderr)) {
            return;
        }

        that._logger.warn('old-git', 'It seems you are using an old version of git, it will be slower and propitious to errors!');
        return cmd('git', ['checkout', resolution.commit], { cwd: that._tempDir });
    }, function (err) {
        // Some git servers do not support shallow clones
        // When that happens, we mark this host and try again
        if (!HgRemoteResolver._noShallow.has(that._source) &&
            err.details &&
            /(rpc failed|shallow|--depth)/i.test(err.details)
        ) {
            HgRemoteResolver._noShallow.set(that._host, true);
            return that._fastClone(resolution);
        }

        throw err;
    });
};

// ------------------------------

// Grab refs remotely
HgRemoteResolver.refs = function (source) {
    var value;
    debugger;
    // TODO: Normalize source because of the various available protocols?
    value = this._cache.refs.get(source);
    if (value) {
        return Q.resolve(value);
    }

    // Store the promise in the refs object
    value = promise = cmd('hg', ['tags'], { cwd: source })
    .spread(function (stdout) {
        debugger;
        var refs;

        refs = stdout.toString()
        .trim()                         // Trim trailing and leading spaces
        .replace(/[\t ]+/g, ' ')        // Standardize spaces (some git versions make tabs, other spaces)
        .split(/[\r\n]+/);              // Split lines into an array

        // Update the refs with the actual refs
        this._cache.refs.set(source, refs);

        return refs;
    }.bind(this));

    // Store the promise to be reused until it resolves
    // to a specific value
    this._cache.refs.set(source, value);

    return value;
};

HgRemoteResolver._branches = function (source) {
    var value;
    // TODO: Normalize source because of the various available protocols?
    // value = this._cache.branches.get(source);
    // if (value) {
    //     return Q.resolve(value);
    // }

    // Store the promise in the branches object
    value = promise = cmd('hg', ['branches'], { cwd: source })
    .spread(function (stdout) {
        var branches;

        branches = stdout.toString()
        .trim()                         // Trim trailing and leading spaces
        .replace(/[\t ]+/g, ' ')        // Standardize spaces (some git versions make tabs, other spaces)
        .split(/[\r\n]+/);              // Split lines into an array

        // // Update the branches with the actual branches
        // this._cache.branches.set(source, branches);

        return branches;
    }.bind(this));

    // Store the promise to be reused until it resolves
    // to a specific value
    // this._cache.branches.set(source, value);

    return value;
};

// Grab tags from local
HgRemoteResolver._tags = function (source) {
    var value;
    // TODO: Normalize source because of the various available protocols?
    // value = this._cache.tags.get(source);
    // if (value) {
    //     return Q.resolve(value);
    // }

    // Store the promise in the tags object
    value = promise = cmd('hg', ['tags'], { cwd: source })
    .spread(function (stdout) {
        var tags;

        tags = stdout.toString()
        .trim()                         // Trim trailing and leading spaces
        .replace(/[\t ]+/g, ' ')        // Standardize spaces (some git versions make tabs, other spaces)
        .split(/[\r\n]+/);              // Split lines into an array



        // Update the tags with the actual tags
        // this._cache.tags.set(source, tags);

        return tags;
    }.bind(this));

    // Store the promise to be reused until it resolves
    // to a specific value
    // this._cache.tags.set(source, value);

    return value;
};

// Store hosts that do not support shallow clones here
HgRemoteResolver._noShallow = new LRU({ max: 50, maxAge: 5 * 60 * 1000 });

module.exports = HgRemoteResolver;
