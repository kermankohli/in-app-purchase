var async = require('./async');
var verbose = require('./verbose');
var constants = require('../constants');
var request = require('request');
var errorMap = {
	21000: 'The App Store could not read the JSON object you provided.',
	21002: 'The data in the receipt-data property was malformed.',
	21003: 'The receipt could not be authenticated.',
	21004: 'The shared secret you provided does not match the shared secret on file for your account.',
	21005: 'The receipt server is not currently available.',
	21006: 'This receipt is valid but the subscription has expired. When this status code is returned to your server, the receipt data is also decoded and returned as part of the response.',
	21007: 'This receipt is a sandbox receipt, but it was sent to the production service for verification.',
	21008: 'This receipt is a production receipt, but it was sent to the sandbox service for verification.',
	2: 'The receipt is valid, but purchased nothing.'
};
var REC_KEYS = {
	IN_APP: 'in_app',
	LRI: 'latest_receipt_info',
	BUNDLE_ID: 'bundle_id',
	TRANSACTION_ID: 'transaction_id',
	PRODUCT_ID: 'product_id',
	ORIGINAL_PURCHASE_DATE_MS: 'original_purchase_date_ms',
	EXPIRES_DATE_MS: 'expires_date_ms',
	EXPIRES_DATE: 'expires_date',
	PURCHASE_DATE_MS: 'purchase_date_ms'
};
var config = null;
var sandboxHost = 'sandbox.itunes.apple.com';
var liveHost = 'buy.itunes.apple.com';
var path = '/verifyReceipt';

function isValidConfigKey(key) {
	return key.match(/^apple/);
}

module.exports.readConfig = function (configIn) {
	if (!configIn) {
		// no apple iap or password not required
		return;
	}
	
	// set up verbose logging
	verbose.setup(configIn);
	
	config = {};
	var configValueSet = false;
	// Apply any default settings to Request.
	if ('requestDefaults' in configIn) {
		request = request.defaults(configIn.requestDefaults);
	}
	Object.keys(configIn).forEach(function (key) {
		if (isValidConfigKey(key)) {
			config[key] = configIn[key];
			configValueSet = true;
		}
	});

	if (!configValueSet) {
		config = null;
	}
};

module.exports.setup = function (cb) {
	if (!config || !config.applePassword) {

		if (process.env.APPLE_IAP_PASSWORD) {
			config = config || {};
			config.applePassword = process.env.APPLE_IAP_PASSWORD;
		}

	}

	return cb();
};

module.exports.validatePurchase = function (secret, receipt, cb) {
	var prodPath = 'https://' + liveHost + path;
	var sandboxPath = 'https://' + sandboxHost + path;
	var status;
	var validatedData;
	var isValid = false;
	var content = { 'receipt-data': receipt };

	if (config && config.applePassword) {
		content.password = config.applePassword;
	}

	// override applePassword from config to allow dynamically fed secret to validate
	if (secret) {
		verbose.log('<Apple> Using dynamic applePassword:', secret);
		content.password = secret;
	}

	verbose.log('<Apple> Validatation data:', content);

	var tryProd = function (next) {
		verbose.log('<Apple> Try validate against production:', prodPath);
		send(prodPath, content, function (error, res, data) {
			verbose.log('<Apple>', prodPath, 'validation response:', data);
			// request error
			if (error) {
				verbose.log('<Apple>', prodPath, 'failed:', error, data);
				// 1 is unknown
				status = data ? data.status : 1;
				validatedData = {
					status: status,
					message: errorMap[status] || 'Unknown'
				};
				return next(error);
			}
			// apple responded with error
			if (data.status > 0 && data.status !== 21007 && data.status !== 21002) {
				verbose.log(prodPath, 'failed:', data);
				status = data.status;
				var emsg = errorMap[status] || 'Unknown';
				var err = new Error(emsg);
				validatedData = {
					status: status,
					message: emsg
				};
				return next(err);		
			}

			// try sandbox...
			if (data.status === 21007 || data.status === 21002) {
				return next();
			}
			verbose.log('<Apple> Production validation successful:', data);
			// production validated
			validatedData = data;
			isValid = true;
			next();
		});
	};

	var trySandbox = function (next) {
		if (isValid) {
			return next();
		}
		verbose.log('<Apple> Try validate against sandbox:', sandboxPath);
		send(sandboxPath, content, function (error, res, data) {
			verbose.log('<Apple>', sandboxPath, 'validation response:', data);
			if (error) {
				verbose.log('<Apple>', sandboxPath, 'failed:', error, data);
				// 1 is unknown
				status = data ? data.status : 1;
				validatedData = {
					status: status,
					message: errorMap[status] || 'Unknown'
				};
				return next(error);
			}
			if (data.status > 0) {
				verbose.log('<Apple>', sandboxPath, 'failed:', data);
				status = data.status;
				var emsg = errorMap[status] || 'Unknown';
				var err = new Error(emsg);
				validatedData = {
					status: status,
					message: emsg
				};
				return next(err);		
			}
			verbose.log('<Apple> Sandbox validation successful:', data);
			// sandbox validated
			validatedData = data;
			next();
		});
	};

	var done = function (error) {
		if (error) {
			return cb(error, validatedData);
		}
		handleResponse(receipt, validatedData, cb);
	};

	var tasks = [
		tryProd,
		trySandbox
	];
	async.series(tasks, done);
};

module.exports.getPurchaseData = function (purchase, options) {
	if (!purchase || !purchase.receipt) {
		return null;
	}
	var data = [];
	if (purchase.receipt[REC_KEYS.IN_APP]) {
		// iOS 6+
		var tids = {};
		var list = purchase.receipt[REC_KEYS.IN_APP];
		var lri = purchase[REC_KEYS.LRI];
		if (lri && Array.isArray(lri)) {
			list = list.concat(lri);
		}
		for (var i = 0, len = list.length; i < len; i++) {
			var item = list[i];
			var tid = item['original_' + REC_KEYS.TRANSACTION_ID];
			var pdate = parseInt(item[REC_KEYS.PURCHASE_DATE_MS], 10);
			var exp = getSubscriptionExpireDate(item);
			var index = data.length;

			if (options && options.ignoreExpired && exp && Date.now() - exp >= 0) {
				// we are told to ignore expired item and it is expired
				continue;
			}

			if (tids[tid] && tids[tid].time < pdate) {
				// avoid duplicate and keep the latest
				index = tids[tid].index;
			}

			tids[tid] = { time: pdate, index: data.length };
			data[index] = {
				bundleId: purchase.receipt[REC_KEYS.BUNDLE_ID],
				transactionId: item[REC_KEYS.TRANSACTION_ID],
				productId: item[REC_KEYS.PRODUCT_ID],
				purchaseDate: item[REC_KEYS.ORIGINAL_PURCHASE_DATE_MS],
				quantity: parseInt(item.quantity, 10),
				expirationDate: exp
			};
		}
		return data;
	}
	// old and will be deprecated by Apple
	data.push({
		bundleId: purchase.receipt[REC_KEYS.BUNDLE_ID],
		transactionId:  purchase.receipt[REC_KEYS.TRANSACTION_ID],
		productId: purchase.receipt[REC_KEYS.PRODUCT_ID],
		purchaseDate: purchase.receipt[REC_KEYS.ORIGINAL_PURCHASE_DATE_MS],
		quantity: parseInt(purchase.receipt.quantity, 10),
		expirationDate: getSubscriptionExpireDate(purchase)
	});
	return data;
};

function getSubscriptionExpireDate(data) {
	if (data[REC_KEYS.EXPIRES_DATE_MS]) {
		return parseInt(data[REC_KEYS.EXPIRES_DATE_MS], 10);
	}
	if (data[REC_KEYS.EXPIRES_DATE]) {
		return parseInt(data[REC_KEYS.EXPIRES_DATE], 10);
	}
	return 0;
}

function handleResponse(receipt, data, cb) {
	data.service = constants.SERVICES.APPLE;
	if (data.status === constants.VALIDATION.SUCCESS) {
		if (data.receipt[REC_KEYS.IN_APP] && !data.receipt[REC_KEYS.IN_APP].length) {
			// receipt is valid, but the receipt bought nothing
			// probably hacked: https://forums.developer.apple.com/thread/8954
			// https://developer.apple.com/library/mac/technotes/tn2413/_index.html#//apple_ref/doc/uid/DTS40016228-CH1-RECEIPT-HOW_DO_I_USE_THE_CANCELLATION_DATE_FIELD_
			data.status = constants.VALIDATION.POSSIBLE_HACK;
			data.message = errorMap[data.status];
			verbose.log(
				'<Apple>',
				'Empty purchased detected: in_app array is empty:',
				'consider invalid and does not validate',
				data
			);
			return cb(new Error('failed to validate for empty purchased list'), data);
		}
		// validated successfully
		return cb(null, data);
	} else {
		// error -> add error message
		data.message = errorMap[data.status] || 'Unkown';
	}
	
	// failed to validate
	cb(new Error('failed to validate purchase'), data);
}

function send(url, content, cb) {
	var options = {
		encoding: null,
		url: url,
		body: content,
		json: true
	};
	request.post(options, function (error, res, body) {
		return cb(error, res, body);
	});
}
