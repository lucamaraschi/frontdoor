"use strict";

var RegExpType = require("./types").RegExp;
var Types = require("./types").Types;

module.exports = function Route(route, options, handler, types) {

    // options is optional
    if (typeof options == "function" || Array.isArray(options)) {
        types = handler;
        handler = options;
        options = {};
    }

    options.route = route;
    types = types || new Types();
    
    if (Array.isArray(handler)) {
        this.middlewares = handler;
    }
    else {
        if (handler.length == 2) {
            handler = wrapHandler(handler);
        }        
        this.middlewares = [handler];
    }
        
    this.middlewares.unshift(decodeParams);
        
    this.method = (options.method || "GET").toLowerCase();
    this.lastMatch = {};
    
    var self = this;
    var keys = [];
    var params = options.params || {};
    var routeRe = normalizePath(options.route, keys, params);
    params = normalizeParams(params);

    function wrapHandler(handler) {
        return function(req, res, next) {
            handler(req.params || {}, function(err, json) {
                if (err) return next(err);
                
                res.json(json);
            });
        };
    }

    /**
     * Creates a rgular expression to match this route.
     * Url param names are stored in `keys` and the `params` are completed with
     * the default values for url parameters.
     */
    function normalizePath(path, keys, params) {
        for (var name in params) {
            var param = params[name];
            if (typeof param == "string" || param instanceof RegExp)
                params[name] = { type: param};
        }
        
        path = path
            .replace(/\/:(\w+)/g, function(match, key) {
                keys.push(key);
                if (!params[key]) {
                    params[key] = {};
                }
                // url params default to type string and optional=false
                var param = params[key];
                param.type = param.type || "string";
                
                if (!param.source || param.source == "url")
                    param.source = "url";
                else
                    throw new Error("Url parameters must have 'url' as source but found '" + param.source + "'");
                return "\/([^\\/]+)";
            })
            .replace(/([\/.])/g, '\\$1');

        return new RegExp('^' + path + '$');
    }
        
    function normalizeParams(params) {
        for (var name in params) {
            var param = params[name];

            if (param.source == "query") {
                // query params default to string
                param.type = param.type || "string";
            } 
            else if (!param.source || param.source == "body") {
                // body params default to json
                param.type = param.type || "json";
                param.source = "body";
            }
            else if (param.source !== "url") {
                throw new Error("parameter source muste be 'url', 'query' or 'body'");
            }
            
            // optional defaults to false
            param.optional = !!param.optional;
                
            // allow regular expressions as types
            if (param.type instanceof RegExp)
                param.type = new RegExpType(param.type);
                
            // convert all types to type objects
            param.type = types.get(param.type);
        }
        
        return params;
    }
        
    /**
     * Check if the given path matched the route regular expression. If the
     * regexp matches the url params are parsed and sored in `lastMatch`. If
     * the regular expression doesn't match or parsing fails `match` will
     * return `false`
     **/
    this.match = function(path) {
        var m = path.match(routeRe);
        if (!m) return false;
        
        this.lastMatch = {};
        for (var i = 0; i < keys.length; i++) {
            var value = m[i+1];
            var key = keys[i];
            var param = params[key];
            var type = param.type;
            try {
                value = type.parse(value);
            } catch (e) {
                this.lastMatch = {};
                return false;
            }
            if (!type.check(value)) {
                this.lastMatch = {};
                return false;
            }
            this.lastMatch[key] = value;
        }
        return true;
    };

    /**
     * Middleware to validate the parameters. It will take `lastMatch` for
     * url params, decode the query and body parameters. If validation passes
     * the decoded and validated parameters are stored in `req.params` 
     * otherwhise an error is returned.
     */
    function decodeParams(req, res, next) {
        if (!self.lastMatch)
            return;
        
        var body = req.body || {};
        var query = req.parsedUrl.query;
        var urlParams = self.lastMatch;
        
        req.params = {};
        var errors = [];
        
        // marker object
        var EMPTY = {};
        
        // 1. check if all required params are there
        for (var key in params) {
            var param = params[key];
            if (
                (!param.optional) && (
                    (param.source == "body" && !(key in body)) ||
                    (param.source == "query" && !(key in query)) ||
                    (param.source == "url" && !(key in urlParams))
                )
            ) {
                errors.push({
                    "resource": self.name || "root",
                    "field": key,
                    "source": param.source,
                    "code": "missing_field"
                });
            }
            else {
                var type = param.type;
                var value = EMPTY;
                var isValid = true;
                switch(param.source) {
                    case "body":
                        if (param.optional && !(key in body))
                            break;
                            
                        value = body[key]; // body is already JSON parsed
                        isValid = type.check(value);
                        break;
                    case "query":
                        if (param.optional && !(key in query))
                            break;
                            
                        try {
                            value = type.parse(query[key]);
                        } catch(e) {
                            isValid = false;
                        }
                        isValid = isValid === false ? false : type.check(value);
                        break;
                    case "url":
                        if (param.optional && !(key in urlParams))
                            break;

                        value = urlParams[key]; // is already parsed and checked
                        isValid = true;
                        break;
                }
                
                if (!isValid) {
                    errors.push({
                        "resource": self.name || "root",
                        "field": key,
                        "type_expected": type.toString(),
                        "code": "invalid"                        
                    });            
                }
                else {
                    if (value !== EMPTY)
                        req.params[key] = value;
                }
            }
        }

        if (errors.length) {
            res.writeHead(422, {"Content-Type": "application/json"});
            res.end(JSON.stringify({
                "message": "Validation failed",
                errors: errors
            }));
            return;
        }
            
        next();
    }
    
    this.describe = function() {
        var route = {
            route: options.route,
            method: this.method
        };
        
        if (options.name)
            route.name = options.name;
            
        if (options.description)
            route.description = options.description;

        route.params = {};
        for (var name in params) {
            var param = params[name];
            route.params[name] = {
                name: param.name,
                type: param.type.toString(),
                source: param.source,
                optional: param.optional
            };
            if (param.description)
                route.params[name].description = param.description;
        }
        
        if (!Object.keys(route.params).length)
            delete route.params;
            
        return route;
    };
};