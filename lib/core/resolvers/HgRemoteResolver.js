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

HgResolver.prototype._hasClone = function() {
    if (!this._tempDir) {
        // We couldn't have ever cloned something without a temp directory
        return Q.resolve(false);
    } else {
        var promise;

        promise = cmd('hg', ['identify'], { cwd: this._tempDir });

        return promise.then(function(data) {
            if (data && data[0] && data[0].match(/^[a-f0-9]{12}\s+\S+/)) {
                return true;   
            }
            return false;
        }, function() {
            return false;
        })
    }
}

HgRemoteResolver.prototype._clone = function() {
    var promise,
        timer,
        reporter,
        that = this,
        args;

    this._logger.action('clone', this._source);

    args = ['clone',  this._source, '.', '-v', '--debug'];

    promise = cmd('hg', args, { cwd: this._tempDir });

    // NOTE - I can't seem to get any progress reported on by hg..

    // Throttle the progress reporter to 1 time each sec
    reporter = mout.fn.throttle(function (data) {
        var lines,
            percent;

        lines = data.split(/[\r\n]+/);
        lines.forEach(function (line) {
            percent = line.match(/\(([0-9]+\.[0-9]+\%)\)$/);
            if (percent) {
                // TODO: There are some strange chars that appear once in a while (\u001b[K)
                //       Trim also those?
                that._logger.info('progress', percent[1]);
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
        clearTimeout(timer);
        reporter.cancel();
    }.bind(this));
}

HgRemoteResolver.prototype._checkout = function () {
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


// Grab branches and tags from the repository
HgRemoteResolver._branches = function (repoDir) {
    var value;

    // Not going to cache this here.  This is cached by HgResolver.branches.  Also
    // this call will only ever query the local repo in the temp dir

    // Store the promise in the branches object
    value = promise = cmd('hg', ['branches'], { cwd: repoDir })
    .spread(function (stdout) {
        var branches;

        branches = stdout.toString()
        .trim()                         // Trim trailing and leading spaces
        .replace(/[\t ]+/g, ' ')        // Standardize spaces (some git versions make tabs, other spaces)
        .split(/[\r\n]+/);              // Split lines into an array

        return branches;
    }.bind(this));


    return value;
};

// Grab tags from local
HgRemoteResolver._tags = function (repoDir) {
    var value;

    // Not going to cache this here.  This is cached by HgResolver.tags.  Also
    // this call will only ever query the local repo in the temp dir

    // Store the promise in the tags object
    value = promise = cmd('hg', ['tags'], { cwd: repoDir })
    .spread(function (stdout) {
        var tags;

        tags = stdout.toString()
        .trim()                         // Trim trailing and leading spaces
        .replace(/[\t ]+/g, ' ')        // Standardize spaces (some git versions make tabs, other spaces)
        .split(/[\r\n]+/);              // Split lines into an array

        return tags;
    }.bind(this));

    return value;
};

// Store hosts that do not support shallow clones here
HgRemoteResolver._noShallow = new LRU({ max: 50, maxAge: 5 * 60 * 1000 });

module.exports = HgRemoteResolver;
