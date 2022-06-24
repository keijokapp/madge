'use strict';

const os = require('os');
const path = require('path');
const {promisify} = require('util');
const commondir = require('commondir');
const walk = require('walkdir');
const dependencyTree = require('./dependency-tree');

const stat = promisify(require('fs').stat);

const isWin = (os.platform() === 'win32');

function isNpmPath(path) {
	return path.indexOf('node_modules') >= 0;
}

function isGitPath(filePath) {
	return filePath.split(path.sep).indexOf('.git') !== -1;
}

function getFiles(config, srcPaths) {
	const files = [];

	return Promise
		.all(srcPaths.map((srcPath) => {
			return stat(srcPath)
				.then((stats) => {
					if (stats.isFile()) {
						if (isGitPath(srcPath)) {
							return;
						}

						files.push(path.resolve(srcPath));

						return;
					}

					walk.sync(srcPath, (filePath, stat) => {
						if (isGitPath(filePath) || isNpmPath(filePath) || !stat.isFile()) {
							return;
						}

						const ext = path.extname(filePath).replace('.', '');

						if (files.indexOf(filePath) < 0 && config.fileExtensions.indexOf(ext) >= 0) {
							files.push(filePath);
						}
					});
				});
		}))
		.then(() => files);
}

async function generateTree(files, baseDir, config) {
	const nonExistent = [];
	const npmPaths = {};
	const pathCache = {};
	const depths = {};
	const deepDependencies = {};
	const tree = {};

	const modules = await dependencyTree(files, {
		directory: baseDir,
		requireConfig: config.requireConfig,
		webpackConfig: config.webpackConfig,
		tsConfig: config.tsConfig,
		filter(dependencyFilePath, traversedFilePath) {
			let dependencyFilterRes = true;
			const isNpmPath0 = isNpmPath(dependencyFilePath);

			if (isGitPath(dependencyFilePath)) {
				return false;
			}

			if (config.dependencyFilter) {
				dependencyFilterRes = config.dependencyFilter(dependencyFilePath, traversedFilePath, baseDir);
			}

			if (config.includeNpm && isNpmPath0) {
				(npmPaths[traversedFilePath] = npmPaths[traversedFilePath] || []).push(dependencyFilePath);
			}

			return !isNpmPath0 && (dependencyFilterRes || dependencyFilterRes === undefined);
		},
		detective: config.detectiveOptions,
		nonExistent: nonExistent
	});

	function calculateDepths(tree, depth) {
		if (depth <= config.depth) {
			for (const dependency of tree) {
				depths[dependency] = true;
				calculateDepths(modules[dependency], depth + 1);
			}
		}
	}

	function getDeepDependencies(dependency) {
		if (deepDependencies[dependency] === null) {
			return [];
		}

		if (!(dependency in deepDependencies)) {
			deepDependencies[dependency] = null;
			deepDependencies[dependency] = [...new Set(modules[dependency].flatMap(
				(dependency) => dependency in depths ? [dependency] : getDeepDependencies(dependency)
			))];
		}

		return deepDependencies[dependency];
	}

	function processPath(absPath) {
		if (pathCache[absPath]) {
			return pathCache[absPath];
		}

		let relPath = path.relative(baseDir, absPath);

		if (isWin) {
			relPath = relPath.replace(/\\/g, '/');
		}

		pathCache[absPath] = relPath;

		return relPath;
	}

	if (Number.isInteger(config.depth)) {
		calculateDepths(files, 0);

		Object.keys(depths).forEach((module) => {
			tree[processPath(module)] = getDeepDependencies(module).map((dependency) => processPath(dependency));
		});
	} else {
		Object.entries(modules).forEach(([module, dependencies]) => {
			tree[processPath(module)] = dependencies.map((dependency) => processPath(dependency));
		});
	}

	for (const npmKey in npmPaths) {
		const id = processPath(npmKey);

		npmPaths[npmKey].forEach((npmPath) => {
			tree[id].push(processPath(npmPath));
		});
	}

	if (config.excludeRegExp) {
		const regExpList = config.excludeRegExp.map((re) => new RegExp(re));

		return {
			tree: Object
				.keys(tree)
				.filter((id) => regExpList.findIndex((regexp) => regexp.test(id)) < 0)
				.sort()
				.reduce((acc, id) => {
					acc[id] = tree[id]
						.filter((id) => regExpList.findIndex((regexp) => regexp.test(id)) < 0)
						.sort();
					return acc;
				}, {}),

			skipped: nonExistent
		};
	}

	return {
		tree: Object
			.keys(tree)
			.sort()
			.reduce((acc, id) => {
				acc[id] = tree[id].sort();
				return acc;
			}, {}),
		skipped: nonExistent
	};
}

/**
 * Expose API.
 * @param {Array} srcPaths
 * @param {Object} config
 * @return {Promise}
 */
module.exports = (srcPaths, config) => {
	srcPaths = srcPaths.map((s) => path.resolve(s));

	let baseDir;

	return Promise
		.all(srcPaths.map(
			(srcPath) => stat(srcPath)
				.then((stats) => stats.isDirectory() ? srcPath : path.dirname(path.resolve(srcPath))))
		)
		.then((dirs) => {
			if (config.baseDir) {
				baseDir = path.resolve(config.baseDir);
			} else {
				baseDir = commondir(dirs);
			}

			return getFiles(config, srcPaths);
		})
		.then((files) => generateTree(files, baseDir, config));
};
