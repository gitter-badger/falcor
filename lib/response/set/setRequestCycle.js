var emptyArray = [];
var AssignableDisposable = require("./../AssignableDisposable");
var GetResponse = require("./../get/GetResponse");
var setGroupsIntoCache = require("./setGroupsIntoCache");
var getWithPathsAsPathMap = require("./../../get").getWithPathsAsPathMap;
var InvalidSourceError = require("./../../errors/InvalidSourceError");
var MaxRetryExceededError = require("./../../errors/MaxRetryExceededError");

/**
 * The request cycle for set.  This is responsible for requesting to dataSource
 * and allowing disposing inflight requests.
 */
module.exports = function setRequestCycle(model, observer, groups,
                                          isJSONGraph, isProgressive, count) {
    // we have exceeded the maximum retry limit.
    if (count === 10) {
        throw new MaxRetryExceededError();
    }

    var requestedAndOptimizedPaths = setGroupsIntoCache(model, groups);
    var optimizedPaths = requestedAndOptimizedPaths.optimizedPaths;
    var requestedPaths = requestedAndOptimizedPaths.requestedPaths;
    var isMaster = model._source === undefined;

    // Local set only.  We perform a follow up get.  If performance is ever
    // a requirement simply requiring in checkCacheAndReport and use get request
    // internals.  Figured this is more "pure".
    if (isMaster) {
        return subscribeToFollowupGet(model, observer, requestedPaths,
                              isJSONGraph, isProgressive);
    }


    // Progressively output the data from the first set.
    if (isProgressive) {
        var json = {};
        getWithPathsAsPathMap(model, requestedPaths, [json]);
        observer.onNext(json);
    }

    var currentJSONGraph = getJSONGraph(model, optimizedPaths);
    var disposable = new AssignableDisposable();

    // Sends out the setRequest.  The Queue will call the callback with the
    // JSONGraph envelope / error.
    var requestDisposable = model._request.
        // TODO: There is error handling that has not been addressed yet.

        // If disposed before this point then the sendSetRequest will not
        // further any callbacks.  Therefore, if we are at this spot, we are
        // not disposed yet.
        set(currentJSONGraph, function(error, jsonGraphEnv) {
            if (typeof error === InvalidSourceError) {
                return observer.onError(error);
            }

            // TODO: This seems like there are errors with this approach, but
            // for sanity sake I am going to keep this logic in here until a
            // rethink can be done.
            var isCompleted = false;
            if (error || optimizedPaths.length === jsonGraphEnv.paths.length) {
                isCompleted = true;
            }

            // Happy case.  One request to the dataSource will fulfill the
            // required paths.
            if (isCompleted) {
                disposable.currentDisposable =
                    subscribeToFollowupGet(model, observer, requestedPaths,
                                          isJSONGraph, isProgressive);
            }

            // TODO: The unhappy case.  I am unsure how this can even be
            // achieved.
            else {
                // We need to restart the setRequestCycle.
                setRequestCycle(model, observer, groups, isJSONGraph,
                                isProgressive, count + 1);
            }
        });

    // Sets the current disposable as the requestDisposable.
    disposable.currentDisposable = requestDisposable;

    return disposable;
};

function getJSONGraph(model, optimizedPaths) {
    var boundPath = model._path;
    var envelope = {};
    model._path = emptyArray;
    model._getPathValuesAsJSONG(model._materialize().withoutDataSource(), optimizedPaths, [envelope]);
    model._path = boundPath;

    return envelope;
}

function subscribeToFollowupGet(model, observer, requestedPaths, isJSONGraph,
                               isProgressive) {

    // Creates a new response and subscribes to it with the original observer.
    // Also sets forceCollect to true, incase the operation is synchronous and
    // exceeds the cache limit size
    var response = new GetResponse(model, requestedPaths, isJSONGraph,
                                   isProgressive, true);
    return response.subscribe(observer);
}
