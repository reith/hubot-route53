/*
 * Common functionalities for calling route53 methods
 */

var _ = require('lodash');
var assert = require('assert');
var AWS = require('aws-sdk');

AWS.config = {
	"accessKeyId": process.env.AWS_ACCESS_KEY_ID,
	"secretAccessKey": process.env.AWS_SECRET_ACCESS_KEY
};

var patterns = {
	name_maybe_with_type: '(\\S+)(?:\\s+(\\S+))?', // actual types not expressed with reason
	valid_types: '(SOA|AAAA|A|TXT|NS|CNAME|MX|PTR|SRV|SPF)'
};

var route53 = new AWS.Route53({apiVersion: '2013-04-01'});

var recordNameMatch = function (n1, n2) {
	if(! _.endsWith(n1, '.')) n1 += '.';
	if(! _.endsWith(n2, '.')) n2 += '.';
	return n1 === n2;
};

// an undefined type match any type
var recordTypeMatch = function (t1, t2) {
	return t1 === undefined || t2 === undefined || t1 === t2;
};

var nextRecordMatch = function (r1, r2) {
	if (r2.Name === undefined || r2.Type === undefined)
		return false;
	return (! recordNameMatch(r1.Name, r2.Name)) ? false : recordTypeMatch(r1.Type, r2.Type);
};


var debug = function(msg) {
	if (process.env.NODE_ENV == 'development' && process.env.DEBUG)
		console.log('debug: ' + msg);
};


var callOn = {

	// if there is a zone already defined in ctx, use that zone and call callback with it
	// this is useful when we are sure zone is looked up before
	currentZone: function(callback, errback, ctx) {
		assert.notEqual(ctx.zone, undefined, "Not zone found in this context");
		return callback.call(ctx, ctx.zone);
	},

	// execute callback on zone that satisfies predicate
	// this look for attribute zone in ctx, if found and still satisfies predicate, call
	// callback with it. this can prevent several excess zone lookups.
	// if there is a zone in ctx that not satisfies predicate, it will replaced with new
	// one that does, if any. so whole operation will not hurt much.
	zoneWhere: function(predicate, callback, errback, ctx) {
		var target;
		var ctx = ctx || this;
		var errback = errback || ctx.defaultErrorHandler;

		if (ctx.zone !== undefined && predicate(ctx.zone)) {
			debug('using pre found zone in context');
			return callback.call(ctx, ctx.zone);
		}

		ctx.listHostedZones().on('success', function(r) {
			if ( (target = _.find(r.data.HostedZones, predicate)) === undefined )
				return errback.call(ctx, "Zone not found");
			else {
				if (ctx.zone !== undefined)
					debug('updated previous found zone in context');
				else
					debug('set zone in context');
				ctx.zone = target;
				return callback.call(ctx, target);
			}
		}).on('error', function(r) {
			return errback.call(ctx, r);
		}).send();
	},

	zoneNamed: function(zoneName, callback, errback, ctx) {
		var ctx = ctx || this;

		var args = Array.prototype.slice.call(arguments, 1);
		if (! _.endsWith(zoneName, '.')) zoneName += '.';
		args.unshift(function(zone) {
			return zone.Name == zoneName;
		});
		return callOn.zoneWhere.apply(ctx, args);
	},

	// execute on zone which contains given host
	hostZone: function(host, callback, errback, ctx) {
		var ctx = ctx || this;
		var args = Array.prototype.slice.call(arguments, 1);
		if (! _.endsWith(host, '.')) host += '.';
		args.unshift(function(zone) {
			return _.endsWith(host, '.' + zone.Name);
		});
		return callOn.zoneWhere.apply(ctx, args);
	},


	// rr_data contains information to picking some records, these would interpreted:
	// {
	// Name -> name of record,
	// Type -> type of record or undefined if not important
	// }
	resourceRecord: function(rr_data, callback, errback, ctx) {
		var rr_name = rr_data.Name;
		var rr_type;
		var ctx = ctx || this;
		var errback = errback || ctx.defaultErrorHandler;

		//It's important to not regard invalid user supplied record type as unspecified
		if ( new RegExp( '^' + patterns.valid_types + '$', 'i').test(rr_data.Type) )
			rr_type = rr_data.Type;
		else if (rr_data.Type != undefined)
			return errback.call(ctx, 'Bad record type supplied "' + rr_data.Type + '"');

		callOn.hostZone.call(ctx, rr_name, function(zone) {
				ctx.listResourceRecordSets({
				HostedZoneId: zone.Id,
				MaxItems: '1',
				StartRecordName: rr_name,
				StartRecordType: rr_type
			},
			function(err, data) {
				if (err) return errback.call(ctx, err.message);

				var result = data.ResourceRecordSets[0];
				if (result && recordNameMatch(rr_name, result.Name)) {
					if (recordTypeMatch(rr_type, result.Type)) {
						if (nextRecordMatch({Name: rr_name, Type: rr_type}, {
								Name: data.NextRecordName,
								Type: data.NextRecordType
							}))
							return errback.call(ctx, 'Aambiguous records selection');
						else
							return callback.call(ctx, result);
					} else {
						return errback.call(ctx, 'No such record name with specified type');
					}
				} else {
					return errback.call(ctx, 'No such record with given name');
				}
			});
		});
	},

	// WARNING:
	// On truncated pages this may call callback more than once for same record,
	// because record info passed to api for requesting next page, could match
	// some records that is already returned.  This happens specially for alias
	// sets that have same name and type but many different targets..  And if
	// these sets contain more than 100 records, this probably will never finish
	// fetching all records..
	zoneRecords: function(zone, callback, final_callback, _options) {
		var _options = _options || {};
		var ctx = _options.ctx || this;
		var hreq_opts  = _.extend({ HostedZoneId: zone.Id }, _options.request_options || {});
		var errback = _options.errback || ctx.defaultErrorHandler;

		ctx.listResourceRecordSets(hreq_opts, function(err, data) {
			if (err) return errback.call(ctx, err.message);

			_.each(data.ResourceRecordSets, function(record) {
				if (! _options.predicate || _options.predicate(record))
					callback.call(ctx, record);
			});

			if (data.IsTruncated) {
				return callOn.zoneRecords.call(ctx, zone, callback, final_callback,
						_.extend({}, _options, {
							request_options: {
								StartRecordType: data.NextRecordType,
								StartRecordName: data.NextRecordName
							}
						}
					)
				);
			} else {
				return final_callback.call(ctx);
			}
		});
	},

	updateRecord: function(zone, old, _new, callback, options) {
		var ctx = options.ctx || this;
		var errback = options.errback || ctx.defaultErrorHandler;

		var params = {
			HostedZoneId: zone.Id,
			ChangeBatch: {
				Changes: [{
						Action: 'DELETE',
						ResourceRecordSet: old
					}, {
						Action: 'CREATE',
						ResourceRecordSet: _new
					}
				],
				Comment: options.comment
			}
		};

		ctx.changeResourceRecordSets(params, function(err, data) {
			if (err) return errback(err.message);
			return callback(data);
		});
	}

};


var APICall = function(response, options) {
	var options = options || {};

	var robot = response.robot;
	var user = response.message.user;

	var _data = {};

	_.each(callOn, function(func, name) {
		if(typeof func === 'function')
			this[name] = function() { return func.apply(this, arguments); };
		}, this);

	this.defaultErrorHandler = function(message) {
		response.reply('Error: ' + message);
	};

	this.data = function(name, value) {
		return arguments.length == 2 ? (_data[name] = value, this) : _data[name];
	};

	this.unset = function(name) {
		delete _data[name];
	};

	this.clear = function() {
		_data = {};
	};

	if (process.env.NODE_ENV != 'development' &&  options.need !== undefined && !robot.auth.hasRole(user, options.need)) {
		response.reply('Insufficient privilege to proceede action');
		_.each(route53.api.operations, function(m, k) { this[k] = new Function(); }, this);
	}
};

APICall.prototype = route53;

module.exports = {
	call: APICall,
	on: callOn,
	api: route53,
	helper: {
		patterns: patterns
	}
};