/**
 * Appcelerator Common Library for Node.js
 * Copyright (c) 2012 by Appcelerator, Inc. All Rights Reserved.
 * Please see the LICENSE file for information about licensing.
 */

var exec = require('child_process').exec,
	async = require('async'),
	path = require('path'),
	util = require('./util'),
	fs = require('fs'),
	afs = require('./fs'),
	plist = require('./plist'),
	version = require('./version'),
	cached;

exports.detect = function (finished, opts) {
	if (process.platform != 'darwin') return finished();
	if (cached) return finished(cached);
	
	opts = opts || {};
	
	async.parallel([
		function (callback) {
			var searchDirs = ['/Developer'],
				xcodeInfo = {},
				xcodeBuildTasks = [];
			
			// first we build up a full list of places to check for xcodebuild
			fs.readdirSync('/Applications').forEach(function (dir) {
				/^Xcode.*\.app$/.test(dir) && searchDirs.push('/Applications/' + dir + '/Contents/Developer');
			});
			fs.readdirSync('/Volumes').forEach(function (dir) {
				var vol = '/Volumes/' + dir;
				searchDirs.push(vol + '/Developer');
				afs.exists(vol + '/Applications') && fs.readdirSync(vol + '/Applications').forEach(function (dir) {
					/^Xcode.*\.app$/.test(dir) && searchDirs.push(vol + '/Applications/' + dir + '/Contents/Developer');
				});
			});
			
			// TODO: try to use spotlight to find additional Xcode locations: "mdfind kMDItemDisplayName==Xcode&&kMDItemKind==Application"
			
			exec('xcode-select -print-path', function (err, stdout, stderr) {
				var selected = err ? '' : stdout.trim();
				
				// for each search dir, create a worker task to verify the path
				searchDirs.sort().forEach(function (dir) {
					var xcodebuild = path.join(dir, 'usr', 'bin', 'xcodebuild');
					// only try to run xcodebuild if it exists and it's not a symlink... if it's a symlink, we're
					// probably going to find it anyways
					if (afs.exists(xcodebuild) && !fs.lstatSync(xcodebuild).isSymbolicLink()) {
						xcodeBuildTasks.push(function (cb) {
							// first, get the Xcode version
							exec(xcodebuild.replace(/ /g, '\\ ') + ' -version', function (err, stdout, stderr) {
								if (err) return cb();
								
								// TODO: check if license has NOT been accepted: "You have not agreed to the Xcode license agreements"
								
								var ver = stdout.match(/xcode\s+?(.*)/i),
									build = stdout.match(/build ?version\:?\s+?(.*)/i),
									xb = {
										path: dir,
										xcodebuild: xcodebuild,
										selected: dir == selected,
										version: ver && ver[1],
										build: build && build[1],
										sdks: [],
										sims: []
									},
									key;
								
								if (!ver) return cb();
								key = ver[1] + (build ? ':' + build[1] : '');
								
								// if we already have this version of Xcode, ignore unless it's currently the selected version
								if (xcodeInfo[key] && !xb.selected && dir > xcodeInfo[key].path) return cb();
								
								xcodeInfo[key] = xb;
								xb.selected && (xcodeInfo.__selected__ = xb);
									
								// get all the sdks and simulator versions for the Xcode instances we care about
								exec(xcodebuild.replace(/ /g, '\\ ') + ' -showsdks', function (err, stdout, stderr) {
									if (!err) {
										stdout.split('\n').forEach(function (line) {
											var m = line.match(/(iphoneos|iphonesimulator)(.+)$/);
											m && (!opts.minSDK || version.gte(m[2], opts.minSDK)) && xb[m[1] == 'iphoneos' ? 'sdks' : 'sims'].push(m[2]);
										});
									}
									cb();
								});
							});
						});
					}
				});
				
				async.parallel(xcodeBuildTasks, function () {
					callback(null, xcodeInfo);
				});
			});
		},
		
		function (callback) {
			exec('security dump-keychain', function (err, stdout, stderr) {
				var result = {
					devNames: {},
					distNames: {},
					wwdr: false
				};
				
				if (!err) {
					stdout.split('\n').forEach(function (line) {
						var m = line.match(/"iPhone Developer\: (.*)"/);
						if (m) {
							result.devNames[m[1].trim()] = 1;
						}
						
						m = line.match(/"iPhone Distribution\: (.*)"/);
						if (m) {
							result.distNames[m[1].trim()] = 1;
						}
						
						if (!result.wwdr && line.indexOf('Apple Worldwide Developer Relations Certification Authority') == -1) {
							result.wwdr = true;
						}
					});
					
					result.devNames = Object.keys(result.devNames).sort();
					result.distNames = Object.keys(result.distNames).sort();
				}
				
				callback(null, result);
			});
		},
		
		function (callback) {
			var dir = afs.resolvePath('~/Library/MobileDevice/Provisioning Profiles'),
				provisioningProfiles = {
					adhoc: [],
					development: [],
					distribution: []
				};
			
			afs.exists(dir) && fs.readdirSync(dir).forEach(function (file) {
				if (/.+\.mobileprovision$/.test(file)) {
					var contents = fs.readFileSync(path.join(dir, file)).toString(),
						i = contents.indexOf('<?xml'),
						j = contents.lastIndexOf('</plist>'),
						p,
						dest = 'development',
						appPrefix,
						entitlements;
					
					if (i != -1 && j != -1) {
						p = new plist().parse(contents.substring(i, j + 8));
						appPrefix = (p.ApplicationIdentifierPrefix || []).shift();
						entitlements = p.Entitlements || {};
						
						if (!p.ProvisionedDevices || !p.ProvisionedDevices.length) {
							dest = 'distribution';
						} else if (new Buffer(p.DeveloperCertificates[0], 'base64').toString().indexOf('Distribution:') != -1) {
							dest = 'adhoc';
						}
						
						provisioningProfiles[dest].push({
							uuid: p.UUID,
							name: p.Name,
							appPrefix: appPrefix,
							appId: (entitlements['application-identifier'] || '').replace(appPrefix + '.', ''),
							getTaskAllow: entitlements['get-task-allow'] || '',
							apsEnvironment: entitlements['aps-environment'] || ''
						});
					}
				}
			});
			
			callback(null, provisioningProfiles);
		},
		
		function (callback) {
			var result = [];
			exec('security list-keychains', function (err, stdout, stderr) {
				if (!err) {
					result.keychains = stdout.split('\n').filter(function (line) {
						var m = line.match(/[^"]*"([^"]*)"/);
						m && result.push(m[1].trim());
					});
				}
			});
			callback(null, result);
		}

	], function (err, results) {
		finished(cached = {
			xcode: results[0],
			certs: results[1],
			provisioningProfiles: results[2],
			keychains: results[3]
		});
	});
};